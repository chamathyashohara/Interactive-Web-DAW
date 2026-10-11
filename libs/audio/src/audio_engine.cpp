#include "rr/audio/audio_engine.hpp"

#include <atomic>
#include <cstring>

#include "miniaudio.h"
#include "rr/shared/clock.hpp"

namespace rr::audio {

struct AudioEngine::Impl {
    ma_context context{};
    bool context_ok = false;
    std::vector<ma_device_info> capture_infos;   // copies: valid across re-enumeration
    std::vector<ma_device_info> playback_infos;

    ma_device device{};
    bool device_ok = false;
    std::atomic<bool> stopping_by_us{false};

    std::unique_ptr<CaptureIngest> ingest;
    std::unique_ptr<TakeRecorder> recorder;
    CaptureDescription description;

    static void on_data(ma_device* device, void* /*output*/, const void* input, ma_uint32 frames) {
        // Real-time thread. Only hands the block to the ingest (no I/O, no locks).
        auto* self = static_cast<Impl*>(device->pUserData);
        self->ingest->on_block(static_cast<const float*>(input), frames, time::monotonic_ns());
    }

    static void on_notification(const ma_device_notification* n) {
        // miniaudio thread. Sets flags only; the recorder worker reacts.
        auto* self = static_cast<Impl*>(n->pDevice->pUserData);
        if (!self->ingest) {
            return;
        }
        if (n->type == ma_device_notification_type_stopped && !self->stopping_by_us.load()) {
            self->ingest->report_device_fault(DeviceFault::StoppedUnexpectedly);
        } else if (n->type == ma_device_notification_type_rerouted) {
            self->ingest->report_device_fault(DeviceFault::Rerouted);
        }
    }

    bool enumerate(std::string& error) {
        if (!context_ok) {
            error = "audio system not initialised";
            return false;
        }
        ma_device_info* playback = nullptr;
        ma_device_info* capture = nullptr;
        ma_uint32 playback_count = 0;
        ma_uint32 capture_count = 0;
        const ma_result r = ma_context_get_devices(&context, &playback, &playback_count, &capture, &capture_count);
        if (r != MA_SUCCESS) {
            error = std::string("device enumeration failed: ") + ma_result_description(r);
            return false;
        }
        capture_infos.assign(capture, capture + capture_count);
        playback_infos.assign(playback, playback + playback_count);
        return true;
    }

    static std::vector<DeviceInfo> to_list(const std::vector<ma_device_info>& infos) {
        std::vector<DeviceInfo> list;
        for (std::size_t i = 0; i < infos.size(); ++i) {
            list.push_back(DeviceInfo{i, infos[i].name, infos[i].isDefault != 0});
        }
        return list;
    }
};

AudioEngine::AudioEngine() : impl_(std::make_unique<Impl>()) {}

AudioEngine::~AudioEngine() {
    close_capture();
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
    close_capture();
    Impl& d = *impl_;
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
    config.dataCallback = &Impl::on_data;
    config.notificationCallback = &Impl::on_notification;
    config.pUserData = &d;
    config.wasapi.noAutoConvertSRC = MA_TRUE;
    config.wasapi.noDefaultQualitySRC = MA_TRUE;
    config.wasapi.noAutoStreamRouting = MA_TRUE;

    ma_result r = ma_device_init(&d.context, &config, &d.device);
    if (r != MA_SUCCESS) {
        error = std::string("cannot open input device '") + d.capture_infos[capture_index].name +
                "': " + ma_result_description(r);
        return false;
    }
    d.device_ok = true;

    const ma_uint32 rate = d.device.sampleRate;
    const ma_uint32 channels = d.device.capture.channels;
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

    CaptureDescription& desc = d.description;
    desc = CaptureDescription{};
    desc.source_kind = "device";
    desc.backend = ma_get_backend_name(d.context.backend);
    desc.device_name = d.device.capture.name;
    desc.sample_rate = rate;
    desc.channels = channels;
    desc.device_internal_format = ma_get_format_name(d.device.capture.internalFormat);
    desc.device_internal_rate = d.device.capture.internalSampleRate;
    desc.device_internal_channels = d.device.capture.internalChannels;
    desc.device_period_frames = d.device.capture.internalPeriodSizeInFrames;
    desc.device_periods = d.device.capture.internalPeriods;
    if (d.device.capture.internalFormat == ma_format_f32) {
        desc.conversion_notes.push_back("no sample-format conversion by miniaudio (device stream is float32)");
    } else {
        desc.conversion_notes.push_back(std::string("miniaudio converts the device's ") +
                                        desc.device_internal_format +
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

    // Everything the callback touches is allocated before the device starts.
    d.ingest = std::make_unique<CaptureIngest>(channels, rate, options.ring_seconds);
    d.recorder = std::make_unique<TakeRecorder>(*d.ingest, recorder_options);
    d.recorder->start();

    d.stopping_by_us.store(false);
    d.ingest->set_device_running(true);
    r = ma_device_start(&d.device);
    if (r != MA_SUCCESS) {
        error = std::string("cannot start input device: ") + ma_result_description(r);
        close_capture();
        return false;
    }
    return true;
}

void AudioEngine::close_capture() {
    Impl& d = *impl_;
    if (d.recorder) {
        d.recorder->stop();  // finalises an active take while audio is still flowing
    }
    if (d.ingest) {
        d.ingest->set_device_running(false);
    }
    if (d.device_ok) {
        d.stopping_by_us.store(true);
        ma_device_uninit(&d.device);  // stops the device; no callbacks after this returns
        d.device_ok = false;
    }
    d.recorder.reset();
    d.ingest.reset();
}

bool AudioEngine::capture_open() const noexcept {
    return impl_->device_ok && impl_->ingest != nullptr;
}

const CaptureDescription& AudioEngine::capture_description() const noexcept {
    return impl_->description;
}

CaptureIngest* AudioEngine::ingest() noexcept {
    return impl_->ingest.get();
}

TakeRecorder* AudioEngine::recorder() noexcept {
    return impl_->recorder.get();
}

}  // namespace rr::audio
