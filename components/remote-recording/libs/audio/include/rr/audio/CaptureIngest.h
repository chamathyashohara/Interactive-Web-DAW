#pragma once

#include <array>
#include <atomic>
#include <cstdint>

#include "rr/audio/SpscRing.h"
#include "rr/audio/WavFormat.h"

/**
 * A block the callback could not store (record ring full). Frames are absolute capture
 * frame indices since the device started.
 */
struct GapEvent
{
    uint64_t startFrame = 0;
    uint32_t frames = 0;
};

/**
 * Monotonic time at the entry of a capture callback and the capture frame index just after
 * that callback's block. Used to map a scheduled time to a sample index (ADR-010). The time is
 * when the callback ran, not when the sound hit the microphone: device input latency is not
 * included (and not known).
 */
struct CaptureStamp
{
    int64_t tNs = 0;
    uint64_t framesEnd = 0;
};

/** Why the device is no longer delivering audio (0 = it is fine). */
enum class DeviceFault : uint32_t
{
    None = 0,
    StoppedUnexpectedly = 1,  // miniaudio "stopped" notification we did not cause (e.g. unplug)
    Rerouted = 2,             // stream moved to another device (should not happen: routing disabled)
};

/** Levels for one channel accumulated since the previous takeLevels() call. */
struct ChannelLevels
{
    float peak = 0.0f;          // max |sample|
    float rms = 0.0f;           // sqrt(mean of squares) over the interval (approximate: see takeLevels)
    uint64_t clipped = 0;  // samples with |x| >= 0.999 in the interval
    uint64_t samples = 0;  // samples measured in the interval
};

struct IngestStats
{
    uint64_t framesCaptured = 0;
    uint64_t callbacks = 0;
    uint64_t overrunEvents = 0;
    uint64_t overrunFrames = 0;
    uint64_t gapEventsLost = 0;     // overruns whose position could not be recorded
    uint64_t timingAnomalies = 0;    // callback arrived > 3x its duration late (not proof of data loss)
    uint64_t clippedSamples = 0;     // |x| >= 0.999
    int64_t maxCallbackNs = 0;
    int64_t lastCallbackNs = 0;     // monotonic time of the latest callback, 0 = none yet
    uint64_t ringFillFrames = 0;    // record ring fill after the latest callback
    uint64_t ringMaxFillFrames = 0;
    uint64_t ringCapacityFrames = 0;
    uint64_t stampsLost = 0;         // stamp ring full (only matters for scheduled starts)
};

/**
 * The capture-callback side of the recording path (THREADING_AND_AUDIO_CALLBACKS.md §3).
 *
 * onBlock() is called on the real-time audio thread (or by a labelled test source in unit
 * tests). It copies the block into a preallocated ring and updates atomic counters. It never
 * allocates, locks, waits, logs or touches files. All memory is allocated in the constructor.
 * It does not know about takes: the recorder worker decides what goes into a file.
 */
class CaptureIngest
{
public:
    CaptureIngest(uint32_t channels, uint32_t sampleRate, uint32_t ringSeconds,
                  size_t gapEventCapacity = 1024);
    CaptureIngest(const CaptureIngest&) = delete;
    CaptureIngest& operator=(const CaptureIngest&) = delete;

    /** ---- real-time producer side ---- */
    void onBlock(const float* interleaved, uint32_t frames, int64_t nowNs) noexcept;

    /** ---- device health (set by the engine, read by the recorder) ---- */
    void setDeviceRunning(bool running) noexcept { deviceRunning.store(running, std::memory_order_release); }
    bool isDeviceRunning() const noexcept { return deviceRunning.load(std::memory_order_acquire); }
    void reportDeviceFault(DeviceFault fault) noexcept
    {
        deviceFault.store(static_cast<uint32_t>(fault), std::memory_order_release);
    }
    DeviceFault getDeviceFault() const noexcept
    {
        return static_cast<DeviceFault>(deviceFault.load(std::memory_order_acquire));
    }

    /** ---- consumer side (recorder worker thread only) ---- */
    SpscRing<float>& getSamples() noexcept { return samples; }
    SpscRing<GapEvent>& getGaps() noexcept { return gaps; }
    SpscRing<CaptureStamp>& getStamps() noexcept { return stamps; }

    /**
     * ---- any thread ----
     * Peak, RMS and clip count since the previous call (then reset). The three values are
     * read with separate atomic exchanges, so a block may straddle two intervals: fine for
     * meters, not a measurement instrument.
     */
    ChannelLevels takeLevels(uint32_t channel) noexcept;
    IngestStats stats() const noexcept;
    uint32_t getChannels() const noexcept { return channels; }
    uint32_t getSampleRate() const noexcept { return sampleRate; }
    size_t ringCapacityFrames() const noexcept { return samples.capacity() / channels; }

private:
    const uint32_t channels;
    const uint32_t sampleRate;
    SpscRing<float> samples;
    SpscRing<GapEvent> gaps;
    SpscRing<CaptureStamp> stamps;
    std::array<std::atomic<float>, kMaxChannels> peaks{};
    std::array<std::atomic<double>, kMaxChannels> sumSquares{};
    std::array<std::atomic<uint64_t>, kMaxChannels> levelSamples{};
    std::array<std::atomic<uint64_t>, kMaxChannels> clippedPerChannel{};
    std::atomic<uint64_t> ringFillFrames{0};
    std::atomic<uint64_t> stampsLost{0};
    std::atomic<uint64_t> ringMaxFillFrames{0};

    std::atomic<uint64_t> framesCaptured{0};
    std::atomic<uint64_t> callbacks{0};
    std::atomic<uint64_t> overrunEvents{0};
    std::atomic<uint64_t> overrunFrames{0};
    std::atomic<uint64_t> gapEventsLost{0};
    std::atomic<uint64_t> timingAnomalies{0};
    std::atomic<uint64_t> clippedSamples{0};
    std::atomic<int64_t> maxCallbackNs{0};
    std::atomic<int64_t> lastCallbackNs{0};
    std::atomic<bool> deviceRunning{false};
    std::atomic<uint32_t> deviceFault{0};
};

