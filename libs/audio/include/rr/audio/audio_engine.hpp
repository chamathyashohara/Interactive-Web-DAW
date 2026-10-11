#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "rr/audio/capture_ingest.hpp"
#include "rr/audio/monitor_bus.hpp"
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
    std::uint32_t ring_seconds = 10;              // record ring capacity
};

struct PlaybackOptions {
    std::uint32_t period_ms = 10;
    std::uint32_t monitor_capacity_ms = 200;  // monitor buffer size
    std::uint32_t monitor_target_ms = 20;     // fill level before monitoring (re)starts
};

// What the output device does with the monitor/tone signal.
struct PlaybackDescription {
    std::string backend;
    std::string device_name;
    std::uint32_t sample_rate = 0;     // rate the app renders at (= monitor bus rate)
    std::uint32_t channels = 0;        // device-native output channels
    std::string device_internal_format;
    std::uint32_t device_internal_rate = 0;
    std::uint32_t device_internal_channels = 0;
    std::uint32_t device_period_frames = 0;
    std::uint32_t device_periods = 0;
    std::vector<std::string> notes;    // monitor-path processing, stated plainly
};

// Counters for device life-cycle events since the engine was created.
struct DeviceEventCounts {
    std::uint64_t capture_opens = 0;
    std::uint64_t capture_faults = 0;   // stopped/rerouted unexpectedly
    std::uint64_t playback_opens = 0;
    std::uint64_t playback_faults = 0;
};

// Owns the miniaudio context, the capture device, the playback device and the monitor bus
// (ADR-003):
//  - devices are opened by explicit ID with WASAPI automatic stream routing disabled;
//  - capture runs at the device's native rate and channels (the master is never converted);
//  - playback renders the monitor bus at the capture rate; if the output device runs at a
//    different rate miniaudio resamples the MONITOR signal only, and this is reported;
//  - a playback fault never affects capture or recording.
// Public methods are for one control thread (the UI thread).
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

    // Opens and starts the capture device; creates the record ring and starts the recorder.
    // If the output is open it is re-opened afterwards so monitoring runs at the new rate.
    bool open_capture(std::size_t capture_index, const CaptureOptions& options,
                      const RecorderOptions& recorder_options, std::string& error);
    // Finalises any active take (StopReason::Shutdown), stops the recorder and the device.
    void close_capture();
    bool capture_open() const noexcept;

    bool open_playback(std::size_t playback_index, const PlaybackOptions& options, std::string& error);
    void close_playback();
    bool playback_open() const noexcept;

    const CaptureDescription& capture_description() const noexcept;
    const PlaybackDescription& playback_description() const noexcept;
    CaptureIngest* ingest() noexcept;           // null when no capture device is open
    const CaptureIngest* ingest() const noexcept;
    TakeRecorder* recorder() noexcept;          // null when no capture device is open
    MonitorBus& monitor() noexcept;             // always valid
    const MonitorBus& monitor() const noexcept;
    DeviceFault capture_fault() const noexcept;
    DeviceFault playback_fault() const noexcept;
    DeviceEventCounts device_events() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Structured snapshot of everything above (for the diagnostics report). Read-only; safe to
// call from the control thread while audio runs.
std::string engine_report_json(const AudioEngine& engine);

}  // namespace rr::audio
