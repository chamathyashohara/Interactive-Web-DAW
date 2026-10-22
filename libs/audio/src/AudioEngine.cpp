#include "rr/audio/AudioEngine.h"

#include <atomic>
#include <cstring>
#include <thread>

#include "miniaudio.h"
#include "rr/shared/Clock.h"

struct AudioEngine::Impl
{
    ma_context context{};
    bool contextOk = false;
    std::vector<ma_device_info> captureInfos;   // copies: valid across re-enumeration
    std::vector<ma_device_info> playbackInfos;

    // ---- capture ----
    ma_device capture{};
    bool captureOk = false;
    std::atomic<bool> captureStoppingByUs{false};
    std::unique_ptr<CaptureIngest> ingest;
    std::unique_ptr<TakeRecorder> recorder;
    CaptureDescription captureDesc;
    uint32_t captureChannels = 0;
    std::atomic<uint32_t> captureFault{0};

    // ---- playback ----
    ma_device playback{};
    bool playbackOk = false;
    std::atomic<bool> playbackStoppingByUs{false};
    PlaybackDescription playbackDesc;
    uint32_t playbackChannels = 0;
    std::atomic<uint32_t> playbackFault{0};
    size_t playbackIndex = 0;
    PlaybackOptions playbackOptions;

    // ---- monitor bus: shared by both callbacks; replaced only while both devices are stopped ----
    std::unique_ptr<MonitorBus> bus;

    // ---- live audio (Stage 7): tap fed by the capture callback, contributor mixed by playback ----
    LiveTap tap;
    std::atomic<PlaybackContributor*> contributor{nullptr};
    std::atomic<bool> playbackInContributor{false};

    std::atomic<uint64_t> captureOpens{0};
    std::atomic<uint64_t> captureFaults{0};
    std::atomic<uint64_t> playbackOpens{0};
    std::atomic<uint64_t> playbackFaults{0};

    static void onCapture(ma_device* device, void* /*output*/, const void* input, ma_uint32 frames)
    {
        // Real-time thread: hand the block to the record path and (if enabled) the monitor.
        auto* self = static_cast<Impl*>(device->pUserData);
        const auto* in = static_cast<const float*>(input);
        self->ingest->onBlock(in, frames, monotonicNs());
        self->bus->pushCapture(in, frames, self->captureChannels);
        self->tap.pushCapture(in, frames, self->captureChannels);
    }

    static void onPlayback(ma_device* device, void* output, const void* /*input*/, ma_uint32 frames)
    {
        auto* self = static_cast<Impl*>(device->pUserData);
        self->bus->render(static_cast<float*>(output), frames, self->playbackChannels);
        // Seq-cst handshake with detachPlaybackContributor(): either detach sees this flag
        // set and waits, or this load sees the null it stored.
        self->playbackInContributor.store(true);
        PlaybackContributor* c = self->contributor.load();
        if (c != nullptr)
        {
            c->renderAdd(static_cast<float*>(output), frames, self->playbackChannels, self->playback.sampleRate);
        }
        self->playbackInContributor.store(false);
    }

    static void onCaptureNotification(const ma_device_notification* n)
    {
        auto* self = static_cast<Impl*>(n->pDevice->pUserData);
        DeviceFault fault = DeviceFault::None;
        if (n->type == ma_device_notification_type_stopped && !self->captureStoppingByUs.load())
        {
            fault = DeviceFault::StoppedUnexpectedly;
        }
        else if (n->type == ma_device_notification_type_rerouted)
        {
            fault = DeviceFault::Rerouted;
        }
        if (fault != DeviceFault::None)
        {
            self->captureFault.store(static_cast<uint32_t>(fault));
            self->captureFaults.fetch_add(1);
            if (self->ingest)
            {
                self->ingest->reportDeviceFault(fault);
            }
        }
    }

    static void onPlaybackNotification(const ma_device_notification* n)
    {
        auto* self = static_cast<Impl*>(n->pDevice->pUserData);
        DeviceFault fault = DeviceFault::None;
        if (n->type == ma_device_notification_type_stopped && !self->playbackStoppingByUs.load())
        {
            fault = DeviceFault::StoppedUnexpectedly;
        }
        else if (n->type == ma_device_notification_type_rerouted)
        {
            fault = DeviceFault::Rerouted;
        }
        if (fault != DeviceFault::None)
        {
            self->playbackFault.store(static_cast<uint32_t>(fault));
            self->playbackFaults.fetch_add(1);
        }
    }

    bool enumerate(std::string& error)
    {
        if (!contextOk)
        {
            error = "audio system not initialised";
            return false;
        }
        ma_device_info* playbackList = nullptr;
        ma_device_info* captureList = nullptr;
        ma_uint32 playbackCount = 0;
        ma_uint32 captureCount = 0;
        const ma_result r =
            ma_context_get_devices(&context, &playbackList, &playbackCount, &captureList, &captureCount);
        if (r != MA_SUCCESS)
        {
            error = std::string("device enumeration failed: ") + ma_result_description(r);
            return false;
        }
        captureInfos.assign(captureList, captureList + captureCount);
        playbackInfos.assign(playbackList, playbackList + playbackCount);
        return true;
    }

    static std::vector<DeviceInfo> toList(const std::vector<ma_device_info>& infos)
    {
        std::vector<DeviceInfo> list;
        for (size_t i = 0; i < infos.size(); ++i)
        {
            list.push_back(DeviceInfo{i, infos[i].name, infos[i].isDefault != 0});
        }
        return list;
    }

    // Only while BOTH devices are stopped.
    void recreateBus(uint32_t rate, const PlaybackOptions& options)
    {
        if (!bus || bus->getSampleRate() != rate)
        {
            const bool wasEnabled = bus && bus->isEnabled();
            const float gain = bus ? bus->getGainDb() : 0.0f;
            bus = std::make_unique<MonitorBus>(rate, options.monitorCapacityMs, options.monitorTargetMs);
            bus->setEnabled(wasEnabled);
            bus->setGainDb(gain);
        }
    }
};

AudioEngine::AudioEngine() : impl(std::make_unique<Impl>())
{
    impl->bus = std::make_unique<MonitorBus>(48000);
}

AudioEngine::~AudioEngine()
{
    detachPlaybackContributor();
    closeCapture();
    closePlayback();
    if (impl->contextOk)
    {
        ma_context_uninit(&impl->context);
    }
}

bool AudioEngine::initialise(std::string& error)
{
    if (impl->contextOk)
    {
        return true;
    }
    const ma_result r = ma_context_init(nullptr, 0, nullptr, &impl->context);
    if (r != MA_SUCCESS)
    {
        error = std::string("cannot initialise the audio system: ") + ma_result_description(r);
        return false;
    }
    impl->contextOk = true;
    return true;
}

bool AudioEngine::initialised() const noexcept
{
    return impl->contextOk;
}

std::string AudioEngine::backendName() const
{
    return impl->contextOk ? ma_get_backend_name(impl->context.backend) : "none";
}

std::vector<DeviceInfo> AudioEngine::captureDevices(std::string& error)
{
    return impl->enumerate(error) ? Impl::toList(impl->captureInfos) : std::vector<DeviceInfo>{};
}

std::vector<DeviceInfo> AudioEngine::playbackDevices(std::string& error)
{
    return impl->enumerate(error) ? Impl::toList(impl->playbackInfos) : std::vector<DeviceInfo>{};
}

bool AudioEngine::openCapture(size_t captureIndex, const CaptureOptions& options,
                               const RecorderOptions& recorderOptions, std::string& error)
                               {
    Impl& d = *impl;
    const bool reopenPlayback = d.playbackOk;
    const size_t playbackIndex = d.playbackIndex;
    const PlaybackOptions playbackOptions = d.playbackOptions;
    closeCapture();
    closePlayback();  // both stopped: the monitor bus may be replaced below
    const bool captureOk = [&]() -> bool
    {
        if (!d.contextOk)
        {
            error = "audio system not initialised";
            return false;
        }
        if (captureIndex >= d.captureInfos.size())
        {
            error = "no input device with index " + std::to_string(captureIndex) + " (enumerate first)";
            return false;
        }

        ma_device_config config = ma_device_config_init(ma_device_type_capture);
        config.capture.pDeviceID = &d.captureInfos[captureIndex].id;  // explicit ID, never "default"
        config.capture.format = ma_format_f32;
        config.capture.channels = 0;   // native channel count: no down-mix
        config.sampleRate = 0;         // native rate: no resampling
        config.periodSizeInMilliseconds = options.periodMs;
        config.performanceProfile = ma_performance_profile_low_latency;
        config.dataCallback = &Impl::onCapture;
        config.notificationCallback = &Impl::onCaptureNotification;
        config.pUserData = &d;
        config.wasapi.noAutoConvertSRC = MA_TRUE;
        config.wasapi.noDefaultQualitySRC = MA_TRUE;
        config.wasapi.noAutoStreamRouting = MA_TRUE;

        ma_result r = ma_device_init(&d.context, &config, &d.capture);
        if (r != MA_SUCCESS)
        {
            error = std::string("cannot open input device '") + d.captureInfos[captureIndex].name +
                    "': " + ma_result_description(r);
            return false;
        }
        d.captureOk = true;

        const ma_uint32 rate = d.capture.sampleRate;
        const ma_uint32 channels = d.capture.capture.channels;
        if (options.requiredSampleRate != 0 && rate != options.requiredSampleRate)
        {
            error = "input device runs at " + std::to_string(rate) + " Hz but " +
                    std::to_string(options.requiredSampleRate) +
                    " Hz is required. Set it in Windows: Sound settings > More sound settings > "
                    "Recording > (device) > Properties > Advanced > Default Format.";
            closeCapture();
            return false;
        }
        if (channels == 0 || channels > kMaxChannels)
        {
            error = "input device reports " + std::to_string(channels) + " channels (supported: 1.." +
                    std::to_string(kMaxChannels) + ")";
            closeCapture();
            return false;
        }

        CaptureDescription& desc = d.captureDesc;
        desc = CaptureDescription{};
        desc.sourceKind = "device";
        desc.backend = ma_get_backend_name(d.context.backend);
        desc.deviceName = d.capture.capture.name;
        desc.sampleRate = rate;
        desc.channels = channels;
        desc.deviceInternalFormat = ma_get_format_name(d.capture.capture.internalFormat);
        desc.deviceInternalRate = d.capture.capture.internalSampleRate;
        desc.deviceInternalChannels = d.capture.capture.internalChannels;
        desc.devicePeriodFrames = d.capture.capture.internalPeriodSizeInFrames;
        desc.devicePeriods = d.capture.capture.internalPeriods;
        if (d.capture.capture.internalFormat == ma_format_f32)
        {
            desc.conversionNotes.push_back("no sample-format conversion by miniaudio (device stream is float32)");
        }
        else
        {
            desc.conversionNotes.push_back(std::string("miniaudio converts the device's ") + desc.deviceInternalFormat +
                                            " samples to float32 (exact for integer input, no dither)");
        }
        if (desc.deviceInternalChannels != channels)
        {
            desc.conversionNotes.push_back("channel conversion from " + std::to_string(desc.deviceInternalChannels) +
                                            " to " + std::to_string(channels) + " channels");
        }
        if (desc.deviceInternalRate != rate)
        {
            desc.conversionNotes.push_back("resampled by miniaudio from " + std::to_string(desc.deviceInternalRate) +
                                            " Hz to " + std::to_string(rate) + " Hz");
        }
        if (d.context.backend == ma_backend_wasapi)
        {
            desc.conversionNotes.push_back(
                "WASAPI shared mode: samples are the Windows audio engine's capture stream (after any "
                "driver/Windows processing), not raw converter data");
        }
        desc.conversionNotes.push_back("no gain, noise suppression, AGC, compression or limiting is applied by this app");

        // Everything the callback touches is allocated before the device starts.
        d.captureChannels = channels;
        d.tap.setSourceRate(rate);
        d.recreateBus(rate, playbackOptions);
        d.ingest = std::make_unique<CaptureIngest>(channels, rate, options.ringSeconds);
        d.recorder = std::make_unique<TakeRecorder>(*d.ingest, recorderOptions);
        d.recorder->start();

        d.captureFault.store(0);
        d.captureStoppingByUs.store(false);
        d.ingest->setDeviceRunning(true);
        r = ma_device_start(&d.capture);
        if (r != MA_SUCCESS)
        {
            error = std::string("cannot start input device: ") + ma_result_description(r);
            closeCapture();
            return false;
        }
        d.captureOpens.fetch_add(1);
        return true;
    }();

    // Restore the output whether or not the input opened (at the new rate if it did).
    if (reopenPlayback)
    {
        std::string playbackError;
        if (!openPlayback(playbackIndex, playbackOptions, playbackError) && captureOk)
        {
            error = "input open; output could not be re-opened: " + playbackError;
        }
    }
    return captureOk;
}

void AudioEngine::closeCapture()
{
    Impl& d = *impl;
    if (d.recorder)
    {
        d.recorder->stop();  // finalises an active take while audio is still flowing
    }
    if (d.ingest)
    {
        d.ingest->setDeviceRunning(false);
    }
    if (d.captureOk)
    {
        d.captureStoppingByUs.store(true);
        ma_device_uninit(&d.capture);  // stops the device; no callbacks after this returns
        d.captureOk = false;
    }
    d.tap.setSourceRate(0);
    d.recorder.reset();
    d.ingest.reset();
}

bool AudioEngine::captureOpen() const noexcept
{
    return impl->captureOk && impl->ingest != nullptr;
}

bool AudioEngine::openPlayback(size_t playbackIndex, const PlaybackOptions& options, std::string& error)
{
    Impl& d = *impl;
    closePlayback();
    if (!d.contextOk)
    {
        error = "audio system not initialised";
        return false;
    }
    if (playbackIndex >= d.playbackInfos.size())
    {
        error = "no output device with index " + std::to_string(playbackIndex) + " (enumerate first)";
        return false;
    }
    // Monitor rate = capture rate when the input is open; otherwise 48 kHz. The bus may only be
    // replaced while the capture callback is not running.
    const uint32_t rate = d.captureOk ? d.capture.sampleRate : 48000;
    if (!d.captureOk)
    {
        d.recreateBus(rate, options);
    }

    ma_device_config config = ma_device_config_init(ma_device_type_playback);
    config.playback.pDeviceID = &d.playbackInfos[playbackIndex].id;
    config.playback.format = ma_format_f32;
    config.playback.channels = 0;  // native output channels
    config.sampleRate = rate;      // monitor rate; miniaudio resamples the monitor if the device differs
    config.periodSizeInMilliseconds = options.periodMs;
    config.performanceProfile = ma_performance_profile_low_latency;
    config.dataCallback = &Impl::onPlayback;
    config.notificationCallback = &Impl::onPlaybackNotification;
    config.pUserData = &d;
    config.wasapi.noAutoConvertSRC = MA_TRUE;
    config.wasapi.noDefaultQualitySRC = MA_TRUE;
    config.wasapi.noAutoStreamRouting = MA_TRUE;

    ma_result r = ma_device_init(&d.context, &config, &d.playback);
    if (r != MA_SUCCESS)
    {
        error = std::string("cannot open output device '") + d.playbackInfos[playbackIndex].name +
                "': " + ma_result_description(r);
        return false;
    }
    d.playbackOk = true;
    d.playbackChannels = d.playback.playback.channels;
    if (d.playbackChannels == 0)
    {
        error = "output device reports 0 channels";
        closePlayback();
        return false;
    }

    PlaybackDescription& desc = d.playbackDesc;
    desc = PlaybackDescription{};
    desc.backend = ma_get_backend_name(d.context.backend);
    desc.deviceName = d.playback.playback.name;
    desc.sampleRate = d.playback.sampleRate;
    desc.channels = d.playbackChannels;
    desc.deviceInternalFormat = ma_get_format_name(d.playback.playback.internalFormat);
    desc.deviceInternalRate = d.playback.playback.internalSampleRate;
    desc.deviceInternalChannels = d.playback.playback.internalChannels;
    desc.devicePeriodFrames = d.playback.playback.internalPeriodSizeInFrames;
    desc.devicePeriods = d.playback.playback.internalPeriods;
    if (desc.deviceInternalRate != desc.sampleRate)
    {
        desc.notes.push_back("MONITOR resampled by miniaudio from " + std::to_string(desc.sampleRate) + " Hz to " +
                             std::to_string(desc.deviceInternalRate) + " Hz (the master is not affected)");
    }
    if (d.captureOk)
    {
        desc.notes.push_back("monitor channel map: input " + std::to_string(d.captureChannels) +
                             " ch -> stereo (1 ch: L=R; >2 ch: first two) -> output " +
                             std::to_string(d.playbackChannels) +
                             (d.playbackChannels == 1 ? " ch (average of L and R)"
                                                       : (d.playbackChannels == 2 ? " ch (copied)"
                                                                                   : " ch (L/R, others silent)")));
    }
    desc.notes.push_back("monitor buffer target " + std::to_string(options.monitorTargetMs) + " ms, capacity " +
                         std::to_string(options.monitorCapacityMs) +
                         " ms; underruns play silence; excess latency is trimmed (counted)");

    d.playbackIndex = playbackIndex;
    d.playbackOptions = options;
    d.playbackFault.store(0);
    d.playbackStoppingByUs.store(false);
    r = ma_device_start(&d.playback);
    if (r != MA_SUCCESS)
    {
        error = std::string("cannot start output device: ") + ma_result_description(r);
        closePlayback();
        return false;
    }
    d.playbackOpens.fetch_add(1);
    return true;
}

void AudioEngine::closePlayback()
{
    Impl& d = *impl;
    if (d.playbackOk)
    {
        d.playbackStoppingByUs.store(true);
        ma_device_uninit(&d.playback);
        d.playbackOk = false;
    }
}

bool AudioEngine::playbackOpen() const noexcept
{
    return impl->playbackOk;
}

const CaptureDescription& AudioEngine::captureDescription() const noexcept
{
    return impl->captureDesc;
}

const PlaybackDescription& AudioEngine::playbackDescription() const noexcept
{
    return impl->playbackDesc;
}

CaptureIngest* AudioEngine::ingest() noexcept
{
    return impl->ingest.get();
}

const CaptureIngest* AudioEngine::ingest() const noexcept
{
    return impl->ingest.get();
}

TakeRecorder* AudioEngine::recorder() noexcept
{
    return impl->recorder.get();
}

MonitorBus& AudioEngine::monitor() noexcept
{
    return *impl->bus;
}

const MonitorBus& AudioEngine::monitor() const noexcept
{
    return *impl->bus;
}

LiveTap& AudioEngine::liveTap() noexcept
{
    return impl->tap;
}

const LiveTap& AudioEngine::liveTap() const noexcept
{
    return impl->tap;
}

void AudioEngine::attachPlaybackContributor(PlaybackContributor* c) noexcept
{
    detachPlaybackContributor();
    impl->contributor.store(c);
}

void AudioEngine::detachPlaybackContributor() noexcept
{
    impl->contributor.store(nullptr);
    // Bounded by one playback callback (a few ms); the callback itself never waits.
    while (impl->playbackInContributor.load())
    {
        std::this_thread::yield();
    }
}

uint32_t AudioEngine::playbackRate() const noexcept
{
    return impl->playbackOk ? impl->playback.sampleRate : 0;
}

DeviceFault AudioEngine::captureFault() const noexcept
{
    return static_cast<DeviceFault>(impl->captureFault.load());
}

DeviceFault AudioEngine::playbackFault() const noexcept
{
    return static_cast<DeviceFault>(impl->playbackFault.load());
}

DeviceEventCounts AudioEngine::deviceEvents() const noexcept
{
    DeviceEventCounts c;
    c.captureOpens = impl->captureOpens.load();
    c.captureFaults = impl->captureFaults.load();
    c.playbackOpens = impl->playbackOpens.load();
    c.playbackFaults = impl->playbackFaults.load();
    return c;
}

