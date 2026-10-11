#include "rr/audio/capture_ingest.hpp"

#include <cmath>

#include "rr/shared/clock.hpp"
#include "rr/shared/realtime_guard.hpp"

namespace rr::audio {

// The callback must never fall back to a lock-based atomic.
static_assert(std::atomic<float>::is_always_lock_free, "atomic<float> must be lock-free");
static_assert(std::atomic<std::uint64_t>::is_always_lock_free, "atomic<uint64_t> must be lock-free");
static_assert(std::atomic<std::int64_t>::is_always_lock_free, "atomic<int64_t> must be lock-free");
static_assert(std::atomic<std::size_t>::is_always_lock_free, "atomic<size_t> must be lock-free");
static_assert(std::atomic<double>::is_always_lock_free, "atomic<double> must be lock-free");

CaptureIngest::CaptureIngest(std::uint32_t channels, std::uint32_t sample_rate, std::uint32_t ring_seconds,
                             std::size_t gap_event_capacity)
    : channels_(channels == 0 ? 1 : (channels > kMaxChannels ? kMaxChannels : channels)),
      sample_rate_(sample_rate),
      samples_(static_cast<std::size_t>(sample_rate) * (ring_seconds == 0 ? 1 : ring_seconds) *
               (channels == 0 ? 1 : (channels > kMaxChannels ? kMaxChannels : channels))),
      gaps_(gap_event_capacity) {
    for (std::size_t c = 0; c < kMaxChannels; ++c) {
        peaks_[c].store(0.0f, std::memory_order_relaxed);
        sum_squares_[c].store(0.0, std::memory_order_relaxed);
        level_samples_[c].store(0, std::memory_order_relaxed);
        clipped_per_channel_[c].store(0, std::memory_order_relaxed);
    }
}

void CaptureIngest::on_block(const float* interleaved, std::uint32_t frames, std::int64_t now_ns) noexcept {
    rt::ScopedRealtimeThread realtime;  // anything that may block (e.g. the logger) now refuses
    if (interleaved == nullptr || frames == 0) {
        return;
    }
    const std::uint64_t start_frame = frames_captured_.load(std::memory_order_relaxed);
    const std::size_t samples = static_cast<std::size_t>(frames) * channels_;

    // Meters: per-channel block peak, sum of squares and clip count, merged into the shared
    // values with a bounded number of atomic operations per channel (no locks).
    std::array<float, kMaxChannels> block_peak{};
    std::array<double, kMaxChannels> block_sumsq{};
    std::array<std::uint64_t, kMaxChannels> block_clipped{};
    for (std::size_t i = 0; i < samples; ++i) {
        const std::size_t c = i % channels_;
        const float x = interleaved[i];
        const float a = std::fabs(x);
        if (a > block_peak[c]) {
            block_peak[c] = a;
        }
        block_sumsq[c] += static_cast<double>(x) * static_cast<double>(x);
        if (a >= 0.999f) {
            ++block_clipped[c];
        }
    }
    std::uint64_t clipped_total = 0;
    for (std::uint32_t c = 0; c < channels_; ++c) {
        float current = peaks_[c].load(std::memory_order_relaxed);
        while (block_peak[c] > current &&
               !peaks_[c].compare_exchange_weak(current, block_peak[c], std::memory_order_relaxed)) {
        }
        double sum = sum_squares_[c].load(std::memory_order_relaxed);
        while (!sum_squares_[c].compare_exchange_weak(sum, sum + block_sumsq[c], std::memory_order_relaxed)) {
        }
        level_samples_[c].fetch_add(frames, std::memory_order_relaxed);
        if (block_clipped[c] != 0) {
            clipped_per_channel_[c].fetch_add(block_clipped[c], std::memory_order_relaxed);
            clipped_total += block_clipped[c];
        }
    }
    if (clipped_total != 0) {
        clipped_samples_.fetch_add(clipped_total, std::memory_order_relaxed);
    }

    // Store the block whole or not at all. A dropped block becomes a gap event whose
    // position the recorder fills with silence and reports (REC-05).
    if (!samples_.try_write_all(interleaved, samples)) {
        overrun_events_.fetch_add(1, std::memory_order_relaxed);
        overrun_frames_.fetch_add(frames, std::memory_order_relaxed);
        const GapEvent gap{start_frame, frames};
        if (!gaps_.try_write_all(&gap, 1)) {
            gap_events_lost_.fetch_add(1, std::memory_order_relaxed);
        }
    }
    const std::uint64_t fill = (samples_.capacity() - samples_.write_available()) / channels_;
    ring_fill_frames_.store(fill, std::memory_order_relaxed);
    if (fill > ring_max_fill_frames_.load(std::memory_order_relaxed)) {
        ring_max_fill_frames_.store(fill, std::memory_order_relaxed);
    }

    // Timing note: a callback much later than its own duration suggests the device or the
    // OS stalled. This is reported, not treated as proof that samples were lost.
    const std::int64_t last = last_callback_ns_.load(std::memory_order_relaxed);
    if (last != 0 && sample_rate_ != 0) {
        const std::int64_t expected_ns =
            static_cast<std::int64_t>(frames) * 1'000'000'000LL / static_cast<std::int64_t>(sample_rate_);
        const std::int64_t interval = now_ns - last;
        if (interval > 3 * expected_ns && interval > 20'000'000LL) {
            timing_anomalies_.fetch_add(1, std::memory_order_relaxed);
        }
    }
    last_callback_ns_.store(now_ns, std::memory_order_relaxed);
    frames_captured_.store(start_frame + frames, std::memory_order_release);
    callbacks_.fetch_add(1, std::memory_order_relaxed);

    const std::int64_t duration = time::monotonic_ns() - now_ns;
    std::int64_t max_seen = max_callback_ns_.load(std::memory_order_relaxed);
    while (duration > max_seen &&
           !max_callback_ns_.compare_exchange_weak(max_seen, duration, std::memory_order_relaxed)) {
    }
}

ChannelLevels CaptureIngest::take_levels(std::uint32_t channel) noexcept {
    ChannelLevels levels;
    if (channel >= channels_) {
        return levels;
    }
    levels.peak = peaks_[channel].exchange(0.0f, std::memory_order_relaxed);
    const double sum = sum_squares_[channel].exchange(0.0, std::memory_order_relaxed);
    levels.samples = level_samples_[channel].exchange(0, std::memory_order_relaxed);
    levels.clipped = clipped_per_channel_[channel].exchange(0, std::memory_order_relaxed);
    levels.rms = levels.samples ? static_cast<float>(std::sqrt(sum / static_cast<double>(levels.samples))) : 0.0f;
    return levels;
}

IngestStats CaptureIngest::stats() const noexcept {
    IngestStats s;
    s.frames_captured = frames_captured_.load(std::memory_order_acquire);
    s.callbacks = callbacks_.load(std::memory_order_relaxed);
    s.overrun_events = overrun_events_.load(std::memory_order_relaxed);
    s.overrun_frames = overrun_frames_.load(std::memory_order_relaxed);
    s.gap_events_lost = gap_events_lost_.load(std::memory_order_relaxed);
    s.timing_anomalies = timing_anomalies_.load(std::memory_order_relaxed);
    s.clipped_samples = clipped_samples_.load(std::memory_order_relaxed);
    s.max_callback_ns = max_callback_ns_.load(std::memory_order_relaxed);
    s.last_callback_ns = last_callback_ns_.load(std::memory_order_relaxed);
    s.ring_fill_frames = ring_fill_frames_.load(std::memory_order_relaxed);
    s.ring_max_fill_frames = ring_max_fill_frames_.load(std::memory_order_relaxed);
    s.ring_capacity_frames = ring_capacity_frames();
    return s;
}

}  // namespace rr::audio
