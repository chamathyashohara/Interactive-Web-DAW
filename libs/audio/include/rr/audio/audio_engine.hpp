#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "rr/audio/capture_ingest.hpp"
#include "rr/audio/take_metadata.hpp"
#include "rr/audio/take_recorder.hpp"

namespace rr::audio {

struct DeviceInfo {
    std::size_t index = 0;   // position in the latest enumeration
    std::string name;        // as Windows reports it
    bool is_default = false;
};

struct CaptureOptions {
    std::uint32_t required_sample_rate = 48000;  // 0 = accept the device's native rate (diagnostics only)
    std::uint32_t period_ms = 10;                 // requested device period (a hint)
    std::uint32_t ring_seconds = 10;              // capture ring capacity
};

// Owns the miniaudio context and the capture device (ADR-003):
//  - the device is opened by its explicit ID, never "default", with WASAPI automatic stream
//    routing disabled, so an unplug ends the stream instead of silently switching microphone;
//  - native sample rate and channel count (no resampling, no down-mix);
//  - capture only. The output device is enumerated and selectable but not opened until the
//    live-audio stage.
// Public methods are for one control thread (the UI thread); the audio callback and the
// recorder worker are internal.
class AudioEngine {
public:
    AudioEngine();
    ~AudioEngine();
    AudioEngine(const AudioEngine&) = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;

    bool initialise(std::string& error);
    bool initialised() const noexcept;
    std::string backend_name() const;

    // Re-enumerates. Indices refer to the latest enumeration of that kind.
    std::vector<DeviceInfo> capture_devices(std::string& error);
    std::vector<DeviceInfo> playback_devices(std::string& error);

    // Opens and starts the capture device; creates the capture ring and starts the recorder.
    bool open_capture(std::size_t capture_index, const CaptureOptions& options,
                      const RecorderOptions& recorder_options, std::string& error);
    // Finalises any active take (StopReason::Shutdown), stops the recorder and the device.
    void close_capture();
    bool capture_open() const noexcept;

    const CaptureDescription& capture_description() const noexcept;
    CaptureIngest* ingest() noexcept;       // null when no device is open
    TakeRecorder* recorder() noexcept;      // null when no device is open

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace rr::audio
