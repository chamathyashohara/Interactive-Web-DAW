#pragma once

#include <atomic>
#include <cstdint>
#include <vector>

#include "rr/audio/spsc_ring.hpp"

namespace rr::audio {

struct MonitorStats {
    std::uint64_t pushed_frames = 0;        // frames offered by the capture side while enabled
    std::uint64_t overflow_events = 0;      // capture block dropped: monitor buffer full
    std::uint64_t overflow_frames = 0;
    std::uint64_t played_frames = 0;        // frames rendered to the output (any source)
    std::uint64_t render_callbacks = 0;
    std::uint64_t underrun_events = 0;      // buffer ran dry while monitoring (gap in what you hear)
    std::uint64_t underrun_frames = 0;
    std::uint64_t prefill_events = 0;       // (re)starts of monitoring after filling to the target
    std::uint64_t start_trim_frames = 0;    // backlog dropped at a (re)start so delay starts at the target
    std::uint64_t drift_trim_events = 0;    // excess latency removed (capture clock faster than playback)
    std::uint64_t drift_trim_frames = 0;
    std::uint32_t fill_frames = 0;          // frames buffered after the latest render
    std::uint32_t max_fill_frames = 0;
    std::uint32_t target_frames = 0;        // prefill target
    std::uint32_t capacity_frames = 0;
    std::int64_t max_render_ns = 0;
};

// Local software monitoring path ("hear yourself") and output test tone.
//
// Capture callback --push_capture()--> [stereo SPSC ring] --render()--> playback callback.
//
// Monitor-only processing, all stated in the UI and the diagnostics report (MONITOR_PATH.md):
//   1. channel map into the ring: 1 ch -> L=R; 2 ch -> copied; >2 ch -> first two channels;
//   2. channel map to the output: stereo -> 1 ch average; 2 ch copy; >2 ch L/R then silence;
//   3. monitor gain (default 0 dB);
//   4. silence for underruns / while filling, trimming of the backlog at each (re)start and
//      of persistently excess buffered audio (clock drift).
// None of this touches the master recording: the record path has its own ring.
//
// Real-time rules: push_capture() runs on the capture callback, render() on the playback
// callback. Both use only preallocated memory, atomics and bounded loops. The control
// functions (set_enabled, set_gain_db, start_test_tone, stats) may be called from any
// other thread.
class MonitorBus {
public:
    static constexpr std::uint32_t kMaxBlockFrames = 4096;  // larger blocks are processed in chunks

    MonitorBus(std::uint32_t sample_rate, std::uint32_t capacity_ms = 200, std::uint32_t target_ms = 20);
    MonitorBus(const MonitorBus&) = delete;
    MonitorBus& operator=(const MonitorBus&) = delete;

    // ---- capture callback (real-time) ----
    void push_capture(const float* interleaved, std::uint32_t frames, std::uint32_t channels) noexcept;

    // ---- playback callback (real-time) ----
    void render(float* out, std::uint32_t frames, std::uint32_t out_channels) noexcept;

    // ---- control (any non-real-time thread) ----
    void set_enabled(bool enabled) noexcept { enabled_.store(enabled, std::memory_order_release); }
    bool enabled() const noexcept { return enabled_.load(std::memory_order_acquire); }
    void set_gain_db(float db) noexcept;
    float gain_db() const noexcept { return gain_db_.load(std::memory_order_relaxed); }
    // Mixes a sine into the output for `seconds` (independent of monitoring).
    void start_test_tone(float frequency_hz, float level_dbfs, float seconds) noexcept;
    bool test_tone_active() const noexcept { return tone_frames_left_.load(std::memory_order_relaxed) > 0; }
    std::uint32_t sample_rate() const noexcept { return sample_rate_; }
    MonitorStats stats() const noexcept;

private:
    const std::uint32_t sample_rate_;
    const std::uint32_t target_frames_;
    SpscRing<float> ring_;                 // interleaved stereo frames
    std::vector<float> capture_scratch_;   // capture side only
    std::vector<float> render_scratch_;    // playback side only

    std::atomic<bool> enabled_{false};
    std::atomic<float> gain_db_{0.0f};
    std::atomic<float> gain_linear_{1.0f};
    std::atomic<std::uint64_t> tone_frames_left_{0};
    std::atomic<float> tone_frequency_{440.0f};
    std::atomic<float> tone_amplitude_{0.1f};

    // Playback-side state (touched only inside render()).
    bool playing_ = false;
    double tone_phase_ = 0.0;
    std::uint32_t over_target_renders_ = 0;

    std::atomic<std::uint64_t> pushed_frames_{0};
    std::atomic<std::uint64_t> overflow_events_{0};
    std::atomic<std::uint64_t> overflow_frames_{0};
    std::atomic<std::uint64_t> played_frames_{0};
    std::atomic<std::uint64_t> render_callbacks_{0};
    std::atomic<std::uint64_t> underrun_events_{0};
    std::atomic<std::uint64_t> underrun_frames_{0};
    std::atomic<std::uint64_t> prefill_events_{0};
    std::atomic<std::uint64_t> start_trim_frames_{0};
    std::atomic<std::uint64_t> drift_trim_events_{0};
    std::atomic<std::uint64_t> drift_trim_frames_{0};
    std::atomic<std::uint32_t> fill_frames_{0};
    std::atomic<std::uint32_t> max_fill_frames_{0};
    std::atomic<std::int64_t> max_render_ns_{0};
};

}  // namespace rr::audio
