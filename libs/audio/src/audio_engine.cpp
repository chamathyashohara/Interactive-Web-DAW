#include "rr/audio/audio_engine.hpp"

#include <atomic>
#include <cstring>
#include <thread>

#include "miniaudio.h"
#include "rr/shared/clock.hpp"

namespace rr::audio {

struct AudioEngine::Impl {
    ma_context context{};
    bool context_ok = false;
    std::vector<ma_device_info> capture_infos;   // copies: valid across re-enumeration
    std::vector<ma_device_info> playback_infos;

    // ---- capture ----
    ma_device capture{};
    bool capture_ok = false;
    std::atomic<bool> capture_stopping_by_us{false};
    std::unique_ptr<CaptureIngest> ingest;
    std::unique_ptr<TakeRecorder> recorder;
    CaptureDescription capture_desc;
    std::uint32_t capture_channels = 0;
    std::atomic<std::uint32_t> capture_fault{0};

    // ---- playback ----
    ma_device playback{};
    bool playback_ok = false;
    std::atomic<bool> playback_stopping_by_us{false};
    PlaybackDescription playback_desc;
    std::uint32_t playback_channels = 0;
    std::atomic<std::uint32_t> playback_fault{0};
    std::size_t playback_index = 0;
    PlaybackOptions playback_options;

    // ---- monitor bus: shared by both callbacks; replaced only while both devices are stopped ----
    std::unique_ptr<MonitorBus> bus;

    // ---- live audio (Stage 7): tap fed by the capture callback, contributor mixed by playback ----
    LiveTap tap;
    std::atomic<PlaybackContributor*> contributor{nullptr};
    std::atomic<bool> playback_in_contributor{false};

    std::atomic<std::uint64_t> capture_opens{0};
    std::atomic<std::uint64_t> capture_faults{0};
    std::atomic<std::uint64_t> playback_opens{0};
    std::atomic<std::uint64_t> playback_faults{0};

    static void on_capture(ma_device* device, void* /*output*/, const void* input, ma_uint32 frames) {
        // Real-time thread: hand the block to the record path and (if enabled) the monitor.
        auto* self = static_cast<Impl*>(device->pUserData);
        const auto* in = static_cast<const float*>(input);
        self->ingest->on_block(in, frames, time::monotonic_ns());
        self->bus->push_capture(in, frames, self->capture_channels);
        self->tap.push_capture(in, frames, self->capture_channels);
    }

    static void on_playback(ma_device* device, void* output, const void* /*input*/, ma_uint32 frames) {
        auto* self = static_cast<Impl*>(device->pUserData);
        self->bus->render(static_cast<float*>(output), frames, self->playback_channels);
        // Seq-cst handshake with detach_playback_contributor(): either detach sees this flag
        // set and waits, or this load sees the null it stored.
        self->playback_in_contributor.store(true);
        PlaybackContributor* c = self->contributor.load();
        if (c != nullptr) {
            c->render_add(static_cast<float*>(output), frames, self->playback_channels, self->playback.sampleRate);
        }
        self->playback_in_contributor.store(false);
    }

    static void on_capture_notification(const ma_device_notification* n) {
        auto* self = static_cast<Impl*>(n->pDevice->pUserData);
        DeviceFault fault = DeviceFault::None;
        if (n->type == ma_device_notification_type_stopped && !self->capture_stopping_by_us.load()) {
            fault = DeviceFault::StoppedUnexpectedly;
        } else if (n->type == ma_device_notification_type_rerouted) {
            fault = DeviceFault::Rerouted;
        }
        if (fault != DeviceFault::None) {
            self->capture_fault.store(static_cast<std::uint32_t>(fault));
            self->capture_faults.fetch_add(1);
            if (self->ingest) {
                self->ingest->report_device_fault(fault);
            }
        }
    }

    static void on_playback_notification(const ma_device_notification* n) {
        auto* self = static_cast<Impl*>(n->pDevice->pUserData);
        DeviceFault fault = DeviceFault::None;
        if (n->type == ma_device_notification_type_stopped && !self->playback_stopping_by_us.load()) {
            fault = DeviceFault::StoppedUnexpectedly;
        } else if (n->type == ma_device_notification_type_rerouted) {
            fault = DeviceFault::Rerouted;
        }
        if (fault != DeviceFault::None) {
            self->playback_fault.store(static_cast<std::uint32_t>(fault));
            self->playback_faults.fetch_add(1);
        }
    }

    bool enumerate(std::string& error) {
        if (!context_ok) {
            error = "audio system not initialised";
            return false;
        }
        ma_device_info* playback_list = nullptr;
        ma_device_info* capture_list = nullptr;
        ma_uint32 playback_count = 0;
        ma_uint32 capture_count = 0;
        const ma_result r =
            ma_context_get_devices(&context, &playback_list, &playback_count, &capture_list, &capture_count);
        if (r != MA_SUCCESS) {
            error = std::string("device enumeration failed: ") + ma_result_description(r);
            return false;
        }
        capture_infos.assign(capture_list, capture_list + capture_count);
        playback_infos.assign(playback_list, playback_list + playback_count);
        return true;
    }

    static std::vector<DeviceInfo> to_list(const std::vector<ma_device_info>& infos) {
        std::vector<DeviceInfo> list;
        for (std::size_t i = 0; i < infos.size(); ++i) {
            list.push_back(DeviceInfo{i, infos[i].name, infos[i].isDefault != 0});
        }
        return list;
    }

    // Only while BOTH devices are stopped.
    void recreate_bus(std::uint32_t rate, const PlaybackOptions& options) {
        if (!bus || bus->sample_rate() != rate) {
            const bool was_enabled = bus && bus->enabled();
            const float gain = bus ? bus->gain_db() : 0.0f;
            bus = std::make_unique<MonitorBus>(rate, options.monitor_capacity_ms, options.monitor_target_ms);
            bus->set_enabled(was_enabled);
            bus->set_gain_db(gain);
        }
    }
};

AudioEngine::AudioEngine() : impl_(std::make_unique<Impl>()) {
    impl_->bus = std::make_unique<MonitorBus>(48000);
}

AudioEngine::~AudioEngine() {
    detach_playback_contributor();
    close_capture();
    close_playback();
    if (impl_->context_ok) {
        ma_context_uninit(&impl_->context);
    }
}

bool AudioEngine::initialise(std::string& error) {
    if (impl_->context_ok) {
        return true;
    }
    const ma_result r = ma_context_init(nullptr, 0, nullptr, &impl_->context);
    if (r != MA_SUCCESS) {
        error = std::string("cannot initialise the audio system: ") + ma_result_description(r);
        return false;
    }
    impl_->context_ok = true;
    return true;
}

bool AudioEngine::initialised() const noexcept {
    return impl_->context_ok;
}

std::string AudioEngine::backend_name() const {
    return impl_->context_ok ? ma_get_backend_name(impl_->context.backend) : "none";
}

std::vector<DeviceInfo> AudioEngine::capture_devices(std::string& error) {
    return impl_->enumerate(error) ? Impl::to_list(impl_->capture_infos) : std::vector<DeviceInfo>{};
}

std::vector<DeviceInfo> AudioEngine::playback_devices(std::string& error) {
    return impl_->enumerate(error) ? Impl::to_list(impl_->playback_infos) : std::vector<DeviceInfo>{};
}

bool AudioEngine::open_capture(std::size_t capture_index, const CaptureOptions& options,
                               const RecorderOptions& recorder_options, std::string& error) {
    Impl& d = *impl_;
    const bool reopen_playback = d.playback_ok;
    const std::size_t playback_index = d.playback_index;
    const PlaybackOptions playback_options = d.playback_options;
    close_capture();
    close_playback();  // both stopped: the monitor bus may be replaced below
    const bool capture_ok = [&]() -> bool {
        if (!d.context_ok) {
            error = "audio system not initialised";
            return false;
        }
        if (capture_index >= d.capture_infos.size()) {
            error = "no input device with index " + std::to_string(capture_index) + " (enumerate first)";
            return false;
        }

        ma_device_config config = ma_device_config_init(ma_device_type_capture);
        config.capture.pDeviceID = &d.capture_infos[capture_index].id;  // explicit ID, never "default"
        config.capture.format = ma_format_f32;
        config.capture.channels = 0;   // native channel count: no down-mix
        config.sampleRate = 0;         // native rate: no resampling
        config.periodSizeInMilliseconds = options.period_ms;
        config.performanceProfile = ma_performance_profile_low_latency;
        config.dataCallback = &Impl::on_capture;
        config.notificationCallback = &Impl::on_capture_notification;
        config.pUserData = &d;
        config.wasapi.noAutoConvertSRC = MA_TRUE;
        config.wasapi.noDefaultQualitySRC = MA_TRUE;
        config.wasapi.noAutoStreamRouting = MA_TRUE;

        ma_result r = ma_device_init(&d.context, &config, &d.capture);
        if (r != MA_SUCCESS) {
            error = std::string("cannot open input device '") + d.capture_infos[capture_index].name +
                    "': " + ma_result_description(r);
            return false;
        }
        d.capture_ok = true;

        const ma_uint32 rate = d.capture.sampleRate;
        const ma_uint32 channels = d.capture.capture.channels;
        if (options.required_sample_rate != 0 && rate != options.required_sample_rate) {
            error = "input device runs at " + std::to_string(rate) + " Hz but " +
                    std::to_string(options.required_sample_rate) +
                    " Hz is required. Set it in Windows: Sound settings > More sound settings > "
                    "Recording > (device) > Properties > Advanced > Default Format.";
            close_capture();
            return false;
        }
        if (channels == 0 || channels > kMaxChannels) {
            error = "input device reports " + std::to_string(channels) + " channels (supported: 1.." +
                    std::to_string(kMaxChannels) + ")";
            close_capture();
            return false;
        }

        CaptureDescription& desc = d.capture_desc;
        desc = CaptureDescription{};
        desc.source_kind = "device";
        desc.backend = ma_get_backend_name(d.context.backend);
        desc.device_name = d.capture.capture.name;
        desc.sample_rate = rate;
        desc.channels = channels;
        desc.device_internal_format = ma_get_format_name(d.capture.capture.internalFormat);
        desc.device_internal_rate = d.capture.capture.internalSampleRate;
        desc.device_internal_channels = d.capture.capture.internalChannels;
        desc.device_period_frames = d.capture.capture.internalPeriodSizeInFrames;
        desc.device_periods = d.capture.capture.internalPeriods;
        if (d.capture.capture.internalFormat == ma_format_f32) {
            desc.conversion_notes.push_back("no sample-format conversion by miniaudio (device stream is float32)");
        } else {
            desc.conversion_notes.push_back(std::string("miniaudio converts the device's ") + desc.device_internal_format +
                                            " samples to float32 (exact for integer input, no dither)");
        }
        if (desc.device_internal_channels != channels) {
            desc.conversion_notes.push_back("channel conversion from " + std::to_string(desc.device_internal_channels) +
                                            " to " + std::to_string(channels) + " channels");
        }
        if (desc.device_internal_rate != rate) {
            desc.conversion_notes.push_back("resampled by miniaudio from " + std::to_string(desc.device_internal_rate) +
                                            " Hz to " + std::to_string(rate) + " Hz");
        }
        if (d.context.backend == ma_backend_wasapi) {
            desc.conversion_notes.push_back(
                "WASAPI shared mode: samples are the Windows audio engine's capture stream (after any "
                "driver/Windows processing), not raw converter data");
        }
        desc.conversion_notes.push_back("no gain, noise suppression, AGC, compression or limiting is applied by this app");

        // Everything the callback touches is allocated before the device starts.
        d.capture_channels = channels;
        d.tap.set_source_rate(rate);
        d.recreate_bus(rate, playback_options);
        d.ingest = std::make_unique<CaptureIngest>(channels, rate, options.ring_seconds);
        d.recorder = std::make_unique<TakeRecorder>(*d.ingest, recorder_options);
        d.recorder->start();

        d.capture_fault.store(0);
        d.capture_stopping_by_us.store(false);
        d.ingest->set_device_running(true);
        r = ma_device_start(&d.capture);
        if (r != MA_SUCCESS) {
            error = std::string("cannot start input device: ") + ma_result_description(r);
            close_capture();
            return false;
        }
        d.capture_opens.fetch_add(1);
        return true;
    }();

    // Restore the output whether or not the input opened (at the new rate if it did).
    if (reopen_playback) {
        std::string playback_error;
        if (!open_playback(playback_index, playback_options, playback_error) && capture_ok) {
            error = "input open; output could not be re-opened: " + playback_error;
        }
    }
    return capture_ok;
}

void AudioEngine::close_capture() {
    Impl& d = *impl_;
    if (d.recorder) {
        d.recorder->stop();  // finalises an active take while audio is still flowing
    }
    if (d.ingest) {
        d.ingest->set_device_running(false);
    }
    if (d.capture_ok) {
        d.capture_stopping_by_us.store(true);
        ma_device_uninit(&d.capture);  // stops the device; no callbacks after this returns
        d.capture_ok = false;
    }
    d.tap.set_source_rate(0);
    d.recorder.reset();
    d.ingest.reset();
}

bool AudioEngine::capture_open() const noexcept {
    return impl_->capture_ok && impl_->ingest != nullptr;
}

bool AudioEngine::open_playback(std::size_t playback_index, const PlaybackOptions& options, std::string& error) {
    Impl& d = *impl_;
    close_playback();
    if (!d.context_ok) {
        error = "audio system not initialised";
        return false;
    }
    if (playback_index >= d.playback_infos.size()) {
        error = "no output device with index " + std::to_string(playback_index) + " (enumerate first)";
        return false;
    }
    // Monitor rate = capture rate when the input is open; otherwise 48 kHz. The bus may only be
    // replaced while the capture callback is not running.
    const std::uint32_t rate = d.capture_ok ? d.capture.sampleRate : 48000;
    if (!d.capture_ok) {
        d.recreate_bus(rate, options);
    }

    ma_device_config config = ma_device_config_init(ma_device_type_playback);
    config.playback.pDeviceID = &d.playback_infos[playback_index].id;
    config.playback.format = ma_format_f32;
    config.playback.channels = 0;  // native output channels
    config.sampleRate = rate;      // monitor rate; miniaudio resamples the monitor if the device differs
    config.periodSizeInMilliseconds = options.period_ms;
    config.performanceProfile = ma_performance_profile_low_latency;
    config.dataCallback = &Impl::on_playback;
    config.notificationCallback = &Impl::on_playback_notification;
    config.pUserData = &d;
    config.wasapi.noAutoConvertSRC = MA_TRUE;
    config.wasapi.noDefaultQualitySRC = MA_TRUE;
    config.wasapi.noAutoStreamRouting = MA_TRUE;

    ma_result r = ma_device_init(&d.context, &config, &d.playback);
    if (r != MA_SUCCESS) {
        error = std::string("cannot open output device '") + d.playback_infos[playback_index].name +
                "': " + ma_result_description(r);
        return false;
    }
    d.playback_ok = true;
    d.playback_channels = d.playback.playback.channels;
    if (d.playback_channels == 0) {
        error = "output device reports 0 channels";
        close_playback();
        return false;
    }

    PlaybackDescription& desc = d.playback_desc;
    desc = PlaybackDescription{};
    desc.backend = ma_get_backend_name(d.context.backend);
    desc.device_name = d.playback.playback.name;
    desc.sample_rate = d.playback.sampleRate;
    desc.channels = d.playback_channels;
    desc.device_internal_format = ma_get_format_name(d.playback.playback.internalFormat);
    desc.device_internal_rate = d.playback.playback.internalSampleRate;
    desc.device_internal_channels = d.playback.playback.internalChannels;
    desc.device_period_frames = d.playback.playback.internalPeriodSizeInFrames;
    desc.device_periods = d.playback.playback.internalPeriods;
    if (desc.device_internal_rate != desc.sample_rate) {
        desc.notes.push_back("MONITOR resampled by miniaudio from " + std::to_string(desc.sample_rate) + " Hz to " +
                             std::to_string(desc.device_internal_rate) + " Hz (the master is not affected)");
    }
    if (d.capture_ok) {
        desc.notes.push_back("monitor channel map: input " + std::to_string(d.capture_channels) +
                             " ch -> stereo (1 ch: L=R; >2 ch: first two) -> output " +
                             std::to_string(d.playback_channels) +
                             (d.playback_channels == 1 ? " ch (average of L and R)"
                                                       : (d.playback_channels == 2 ? " ch (copied)"
                                                                                   : " ch (L/R, others silent)")));
    }
    desc.notes.push_back("monitor buffer target " + std::to_string(options.monitor_target_ms) + " ms, capacity " +
                         std::to_string(options.monitor_capacity_ms) +
                         " ms; underruns play silence; excess latency is trimmed (counted)");

    d.playback_index = playback_index;
    d.playback_options = options;
    d.playback_fault.store(0);
    d.playback_stopping_by_us.store(false);
    r = ma_device_start(&d.playback);
    if (r != MA_SUCCESS) {
        error = std::string("cannot start output device: ") + ma_result_description(r);
        close_playback();
        return false;
    }
    d.playback_opens.fetch_add(1);
    return true;
}

void AudioEngine::close_playback() {
    Impl& d = *impl_;
    if (d.playback_ok) {
        d.playback_stopping_by_us.store(true);
        ma_device_uninit(&d.playback);
        d.playback_ok = false;
    }
}

bool AudioEngine::playback_open() const noexcept {
    return impl_->playback_ok;
}

const CaptureDescription& AudioEngine::capture_description() const noexcept {
    return impl_->capture_desc;
}

const PlaybackDescription& AudioEngine::playback_description() const noexcept {
    return impl_->playback_desc;
}

CaptureIngest* AudioEngine::ingest() noexcept {
    return impl_->ingest.get();
}

const CaptureIngest* AudioEngine::ingest() const noexcept {
    return impl_->ingest.get();
}

TakeRecorder* AudioEngine::recorder() noexcept {
    return impl_->recorder.get();
}

MonitorBus& AudioEngine::monitor() noexcept {
    return *impl_->bus;
}

const MonitorBus& AudioEngine::monitor() const noexcept {
    return *impl_->bus;
}

LiveTap& AudioEngine::live_tap() noexcept {
    return impl_->tap;
}

const LiveTap& AudioEngine::live_tap() const noexcept {
    return impl_->tap;
}

void AudioEngine::attach_playback_contributor(PlaybackContributor* c) noexcept {
    detach_playback_contributor();
    impl_->contributor.store(c);
}

void AudioEngine::detach_playback_contributor() noexcept {
    impl_->contributor.store(nullptr);
    // Bounded by one playback callback (a few ms); the callback itself never waits.
    while (impl_->playback_in_contributor.load()) {
        std::this_thread::yield();
    }
}

std::uint32_t AudioEngine::playback_rate() const noexcept {
    return impl_->playback_ok ? impl_->playback.sampleRate : 0;
}

DeviceFault AudioEngine::capture_fault() const noexcept {
    return static_cast<DeviceFault>(impl_->capture_fault.load());
}

DeviceFault AudioEngine::playback_fault() const noexcept {
    return static_cast<DeviceFault>(impl_->playback_fault.load());
}

DeviceEventCounts AudioEngine::device_events() const noexcept {
    DeviceEventCounts c;
    c.capture_opens = impl_->capture_opens.load();
    c.capture_faults = impl_->capture_faults.load();
    c.playback_opens = impl_->playback_opens.load();
    c.playback_faults = impl_->playback_faults.load();
    return c;
}

}  // namespace rr::audio
