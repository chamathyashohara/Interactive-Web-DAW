#include "rr/audio/live_tap.hpp"

namespace rr::audio {

LiveTap::LiveTap(std::uint32_t capacity_frames) : ring_(capacity_frames), scratch_(kMaxBlockFrames) {}

void LiveTap::push_capture(const float* interleaved, std::uint32_t frames, std::uint32_t channels) noexcept {
    if (!enabled_.load(std::memory_order_acquire) || interleaved == nullptr || channels == 0) {
        return;
    }
    if (source_rate_.load(std::memory_order_acquire) != kRequiredRate) {
        wrong_rate_blocks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    // All-or-nothing per block, so a drop is one contiguous gap.
    if (ring_.write_available() < frames) {
        overflow_events_.fetch_add(1, std::memory_order_relaxed);
        overflow_frames_.fetch_add(frames, std::memory_order_release);
        return;
    }
    const float scale = 1.0f / static_cast<float>(channels);
    std::uint32_t done = 0;
    while (done < frames) {
        const std::uint32_t n = (frames - done) < kMaxBlockFrames ? (frames - done) : kMaxBlockFrames;
        const float* in = interleaved + static_cast<std::size_t>(done) * channels;
        for (std::uint32_t f = 0; f < n; ++f) {
            float sum = 0.0f;
            for (std::uint32_t c = 0; c < channels; ++c) {
                sum += in[static_cast<std::size_t>(f) * channels + c];
            }
            scratch_[f] = sum * scale;
        }
        ring_.try_write_all(scratch_.data(), n);  // room was checked above (single producer)
        done += n;
    }
    pushed_frames_.fetch_add(frames, std::memory_order_relaxed);
    fill_frames_.store(static_cast<std::uint32_t>(ring_.capacity() - ring_.write_available()),
                       std::memory_order_relaxed);
}

LiveTapStats LiveTap::stats() const noexcept {
    LiveTapStats s;
    s.pushed_frames = pushed_frames_.load(std::memory_order_relaxed);
    s.overflow_events = overflow_events_.load(std::memory_order_relaxed);
    s.overflow_frames = overflow_frames_.load(std::memory_order_relaxed);
    s.wrong_rate_blocks = wrong_rate_blocks_.load(std::memory_order_relaxed);
    s.fill_frames = fill_frames_.load(std::memory_order_relaxed);
    s.capacity_frames = static_cast<std::uint32_t>(ring_.capacity());
    s.source_rate = source_rate_.load(std::memory_order_relaxed);
    return s;
}

}  // namespace rr::audio
