#pragma once

#include <array>
#include <atomic>
#include <cstdint>

#include "rr/audio/spsc_ring.hpp"
#include "rr/audio/wav_format.hpp"

namespace rr::audio {

// A block the callback could not store (record ring full). Frames are absolute capture
// frame indices since the device started.
struct GapEvent {
    std::uint64_t start_frame = 0;
    std::uint32_t frames = 0;
};

// Monotonic time at the entry of a capture callback and the capture frame index just after
// that callback's block. Used to map a scheduled time to a sample index (ADR-010). The time is
// when the callback ran, not when the sound hit the microphone: device input latency is not
// included (and not known).
struct CaptureStamp {
    std::int64_t t_ns = 0;
    std::uint64_t frames_end = 0;
};

// Why the device is no longer delivering audio (0 = it is fine).
enum class DeviceFault : std::uint32_t {
    None = 0,
    StoppedUnexpectedly = 1,  // miniaudio "stopped" notification we did not cause (e.g. unplug)
    Rerouted = 2,             // stream moved to another device (should not happen: routing disabled)
};

// Levels for one channel accumulated since the previous take_levels() call.
struct ChannelLevels {
    float peak = 0.0f;          // max |sample|
    float rms = 0.0f;           // sqrt(mean of squares) over the interval (approximate: see take_levels)
    std::uint64_t clipped = 0;  // samples with |x| >= 0.999 in the interval
    std::uint64_t samples = 0;  // samples measured in the interval
};

struct IngestStats {
    std::uint64_t frames_captured = 0;
    std::uint64_t callbacks = 0;
    std::uint64_t overrun_events = 0;
    std::uint64_t overrun_frames = 0;
    std::uint64_t gap_events_lost = 0;     // overruns whose position could not be recorded
    std::uint64_t timing_anomalies = 0;    // callback arrived > 3x its duration late (not proof of data loss)
    std::uint64_t clipped_samples = 0;     // |x| >= 0.999
    std::int64_t max_callback_ns = 0;
    std::int64_t last_callback_ns = 0;     // monotonic time of the latest callback, 0 = none yet
    std::uint64_t ring_fill_frames = 0;    // record ring fill after the latest callback
    std::uint64_t ring_max_fill_frames = 0;
    std::uint64_t ring_capacity_frames = 0;
    std::uint64_t stamps_lost = 0;         // stamp ring full (only matters for scheduled starts)
};

// The capture-callback side of the recording path (THREADING_AND_AUDIO_CALLBACKS.md §3).
//
// on_block() is called on the real-time audio thread (or by a labelled test source in unit
// tests). It copies the block into a preallocated ring and updates atomic counters. It never
// allocates, locks, waits, logs or touches files. All memory is allocated in the constructor.
// It does not know about takes: the recorder worker decides what goes into a file.
class CaptureIngest {
public:
    CaptureIngest(std::uint32_t channels, std::uint32_t sample_rate, std::uint32_t ring_seconds,
                  std::size_t gap_event_capacity = 1024);
    CaptureIngest(const CaptureIngest&) = delete;
    CaptureIngest& operator=(const CaptureIngest&) = delete;

    // ---- real-time producer side ----
    void on_block(const float* interleaved, std::uint32_t frames, std::int64_t now_ns) noexcept;

    // ---- device health (set by the engine, read by the recorder) ----
    void set_device_running(bool running) noexcept { device_running_.store(running, std::memory_order_release); }
    bool device_running() const noexcept { return device_running_.load(std::memory_order_acquire); }
    void report_device_fault(DeviceFault fault) noexcept {
        device_fault_.store(static_cast<std::uint32_t>(fault), std::memory_order_release);
    }
    DeviceFault device_fault() const noexcept {
        return static_cast<DeviceFault>(device_fault_.load(std::memory_order_acquire));
    }

    // ---- consumer side (recorder worker thread only) ----
    SpscRing<float>& samples() noexcept { return samples_; }
    SpscRing<GapEvent>& gaps() noexcept { return gaps_; }
    SpscRing<CaptureStamp>& stamps() noexcept { return stamps_; }

    // ---- any thread ----
    // Peak, RMS and clip count since the previous call (then reset). The three values are
    // read with separate atomic exchanges, so a block may straddle two intervals: fine for
    // meters, not a measurement instrument.
    ChannelLevels take_levels(std::uint32_t channel) noexcept;
    IngestStats stats() const noexcept;
    std::uint32_t channels() const noexcept { return channels_; }
    std::uint32_t sample_rate() const noexcept { return sample_rate_; }
    std::size_t ring_capacity_frames() const noexcept { return samples_.capacity() / channels_; }

private:
    const std::uint32_t channels_;
    const std::uint32_t sample_rate_;
    SpscRing<float> samples_;
    SpscRing<GapEvent> gaps_;
    SpscRing<CaptureStamp> stamps_;
    std::array<std::atomic<float>, kMaxChannels> peaks_{};
    std::array<std::atomic<double>, kMaxChannels> sum_squares_{};
    std::array<std::atomic<std::uint64_t>, kMaxChannels> level_samples_{};
    std::array<std::atomic<std::uint64_t>, kMaxChannels> clipped_per_channel_{};
    std::atomic<std::uint64_t> ring_fill_frames_{0};
    std::atomic<std::uint64_t> stamps_lost_{0};
    std::atomic<std::uint64_t> ring_max_fill_frames_{0};

    std::atomic<std::uint64_t> frames_captured_{0};
    std::atomic<std::uint64_t> callbacks_{0};
    std::atomic<std::uint64_t> overrun_events_{0};
    std::atomic<std::uint64_t> overrun_frames_{0};
    std::atomic<std::uint64_t> gap_events_lost_{0};
    std::atomic<std::uint64_t> timing_anomalies_{0};
    std::atomic<std::uint64_t> clipped_samples_{0};
    std::atomic<std::int64_t> max_callback_ns_{0};
    std::atomic<std::int64_t> last_callback_ns_{0};
    std::atomic<bool> device_running_{false};
    std::atomic<std::uint32_t> device_fault_{0};
};

}  // namespace rr::audio
