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

CaptureIngest::CaptureIngest(std::uint32_t channels, std::uint32_t sample_rate, std::uint32_t ring_seconds,
                             std::size_t gap_event_capacity)
    : channels_(channels == 0 ? 1 : (channels > kMaxChannels ? kMaxChannels : channels)),
      sample_rate_(sample_rate),
      samples_(static_cast<std::size_t>(sample_rate) * (ring_seconds == 0 ? 1 : ring_seconds) *
               (channels == 0 ? 1 : (channels > kMaxChannels ? kMaxChannels : channels))),
      gaps_(gap_event_capacity) {
    for (auto& p : peaks_) {
        p.store(0.0f, std::memory_order_relaxed);
    }
}

void CaptureIngest::on_block(const float* interleaved, std::uint32_t frames, std::int64_t now_ns) noexcept {
    rt::ScopedRealtimeThread realtime;  // anything that may block (e.g. the logger) now refuses
    if (interleaved == nullptr || frames == 0) {
        return;
    }
    const std::uint64_t start_frame = frames_captured_.load(std::memory_order_relaxed);
    const std::size_t samples = static_cast<std::size_t>(frames) * channels_;

    // Meters: per-channel block peak, merged into the shared max with one CAS per channel.
    std::array<float, kMaxChannels> block_peak{};
    std::uint64_t clipped = 0;
    for (std::size_t i = 0; i < samples; ++i) {
        const float a = std::fabs(interleaved[i]);
        float& peak = block_peak[i % channels_];
        if (a > peak) {
            peak = a;
        }
        if (a >= 0.999f) {
            ++clipped;
        }
    }
    for (std::uint32_t c = 0; c < channels_; ++c) {
        float current = peaks_[c].load(std::memory_order_relaxed);
        while (block_peak[c] > current &&
               !peaks_[c].compare_exchange_weak(current, block_peak[c], std::memory_order_relaxed)) {
        }
    }
    if (clipped != 0) {
        clipped_samples_.fetch_add(clipped, std::memory_order_relaxed);
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

float CaptureIngest::take_peak(std::uint32_t channel) noexcept {
    if (channel >= channels_) {
        return 0.0f;
    }
    return peaks_[channel].exchange(0.0f, std::memory_order_relaxed);
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
    return s;
}

}  // namespace rr::audio
