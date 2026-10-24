#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "rr/audio/CaptureIngest.h"
#include "rr/audio/LiveTap.h"
#include "rr/audio/MonitorBus.h"
#include "rr/audio/TakeMetadata.h"
#include "rr/audio/TakeRecorder.h"

struct DeviceInfo
{
    size_t index = 0;   // position in the latest enumeration
    std::string name;        // as Windows reports it
    bool isDefault = false;
};

struct CaptureOptions
{
    uint32_t requiredSampleRate = 48000;  // 0 = accept the device's native rate (diagnostics only)
    uint32_t periodMs = 10;                 // requested device period (a hint)
    uint32_t ringSeconds = 10;              // record ring capacity
};

struct PlaybackOptions
{
    uint32_t periodMs = 10;
    uint32_t monitorCapacityMs = 200;  // monitor buffer size
    uint32_t monitorTargetMs = 20;     // fill level before monitoring (re)starts
};

/** What the output device does with the monitor/tone signal. */
struct PlaybackDescription
{
    std::string backend;
    std::string deviceName;
    uint32_t sampleRate = 0;     // rate the app renders at (= monitor bus rate)
    uint32_t channels = 0;        // device-native output channels
    std::string deviceInternalFormat;
    uint32_t deviceInternalRate = 0;
    uint32_t deviceInternalChannels = 0;
    uint32_t devicePeriodFrames = 0;
    uint32_t devicePeriods = 0;
    std::vector<std::string> notes;    // monitor-path processing, stated plainly
};

/** Counters for device life-cycle events since the engine was created. */
struct DeviceEventCounts
{
    uint64_t captureOpens = 0;
    uint64_t captureFaults = 0;   // stopped/rerouted unexpectedly
    uint64_t playbackOpens = 0;
    uint64_t playbackFaults = 0;
};

/**
 * Owns the miniaudio context, the capture device, the playback device and the monitor bus
 * (ADR-003):
 * - devices are opened by explicit ID with WASAPI automatic stream routing disabled;
 * - capture runs at the device's native rate and channels (the master is never converted);
 * - playback renders the monitor bus at the capture rate; if the output device runs at a
 * different rate miniaudio resamples the MONITOR signal only, and this is reported;
 * - a playback fault never affects capture or recording.
 * Public methods are for one control thread (the UI thread).
 */
class AudioEngine
{
public:
    AudioEngine();
    ~AudioEngine();
    AudioEngine(const AudioEngine&) = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;

    bool initialise(std::string& error);
    bool initialised() const noexcept;
    std::string backendName() const;

    /** Re-enumerates. Indices refer to the latest enumeration of that kind. */
    std::vector<DeviceInfo> captureDevices(std::string& error);
    std::vector<DeviceInfo> playbackDevices(std::string& error);

    /**
     * Opens and starts the capture device; creates the record ring and starts the recorder.
     * If the output is open it is re-opened afterwards so monitoring runs at the new rate.
     */
    bool openCapture(size_t captureIndex, const CaptureOptions& options,
                      const RecorderOptions& recorderOptions, std::string& error);
    /** Finalises any active take (StopReason::Shutdown), stops the recorder and the device. */
    void closeCapture();
    bool captureOpen() const noexcept;

    bool openPlayback(size_t playbackIndex, const PlaybackOptions& options, std::string& error);
    void closePlayback();
    bool playbackOpen() const noexcept;

    const CaptureDescription& captureDescription() const noexcept;
    const PlaybackDescription& playbackDescription() const noexcept;
    CaptureIngest* ingest() noexcept;           // null when no capture device is open
    const CaptureIngest* ingest() const noexcept;
    TakeRecorder* recorder() noexcept;          // null when no capture device is open
    MonitorBus& monitor() noexcept;             // always valid
    const MonitorBus& monitor() const noexcept;
    /**
     * Live audio (Stage 7, ADR-017). The tap exists for the engine's whole life and is fed by
     * the capture callback while enabled and the capture rate is 48 kHz.
     */
    LiveTap& liveTap() noexcept;
    const LiveTap& liveTap() const noexcept;
    /**
     * Mixes `c` into the output after the monitor. Only one contributor at a time. detach
     * returns once the playback callback can no longer be inside c->renderAdd(), so `c` may
     * be destroyed afterwards. Both are for the control thread.
     */
    void attachPlaybackContributor(PlaybackContributor* c) noexcept;
    void detachPlaybackContributor() noexcept;
    uint32_t playbackRate() const noexcept;  // rate the output callback renders at (0 = closed)

    DeviceFault captureFault() const noexcept;
    DeviceFault playbackFault() const noexcept;
    DeviceEventCounts deviceEvents() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};

/**
 * Structured snapshot of everything above (for the diagnostics report). Read-only; safe to
 * call from the control thread while audio runs.
 */
std::string engineReportJson(const AudioEngine& engine);

