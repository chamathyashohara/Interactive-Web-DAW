#pragma once

#include <atomic>
#include <cstdint>
#include <vector>

#include "rr/audio/spsc_ring.hpp"

namespace rr::audio {

struct LiveTapStats {
    std::uint64_t pushed_frames = 0;          // mono frames written for the live sender
    std::uint64_t overflow_events = 0;        // capture block dropped: tap ring full (sender not keeping up)
    std::uint64_t overflow_frames = 0;
    std::uint64_t wrong_rate_blocks = 0;      // capture rate is not 48 kHz: nothing tapped (Opus needs 48 kHz)
    std::uint32_t fill_frames = 0;            // after the latest push
    std::uint32_t capacity_frames = 0;
    std::uint32_t source_rate = 0;
};

// Capture -> live-sender hand-over for the live audio path (Stage 7, ADR-017).
//
//   capture callback --push_capture()--> [mono float SPSC ring] --ring()--> live sender thread
//
// Live-path-only processing (stated in the UI and the report): multi-channel input is
// averaged to mono. Nothing here touches the master recording, which has its own ring.
//
// Real-time rules: push_capture() runs on the capture callback and only uses preallocated
// memory, atomics and bounded loops. If the ring is full (the sender thread stalled) the
// WHOLE block is dropped and counted as an overflow; the sender sees a gap in the
// live-stream sample counter (live_frame_index), never a blocked callback.
// The tap is fed only while enabled AND while the capture rate is 48 kHz.
class LiveTap {
public:
    static constexpr std::uint32_t kRequiredRate = 48000;
    static constexpr std::uint32_t kMaxBlockFrames = 4096;  // larger blocks are processed in chunks

    explicit LiveTap(std::uint32_t capacity_frames = 24000);  // 500 ms at 48 kHz
    LiveTap(const LiveTap&) = delete;
    LiveTap& operator=(const LiveTap&) = delete;

    // ---- capture callback (real-time) ----
    void push_capture(const float* interleaved, std::uint32_t frames, std::uint32_t channels) noexcept;

    // ---- control (any non-real-time thread) ----
    void set_enabled(bool enabled) noexcept { enabled_.store(enabled, std::memory_order_release); }
    bool enabled() const noexcept { return enabled_.load(std::memory_order_acquire); }
    void set_source_rate(std::uint32_t rate) noexcept { source_rate_.store(rate, std::memory_order_release); }
    std::uint32_t source_rate() const noexcept { return source_rate_.load(std::memory_order_acquire); }
    LiveTapStats stats() const noexcept;

    // ---- consumer (the one live sender thread) ----
    SpscRing<float>& ring() noexcept { return ring_; }
    // Frames dropped by overflow so far (the sender adds the increase to its sample counter).
    std::uint64_t dropped_frames() const noexcept { return overflow_frames_.load(std::memory_order_acquire); }

private:
    SpscRing<float> ring_;
    std::vector<float> scratch_;  // capture side only
    std::atomic<bool> enabled_{false};
    std::atomic<std::uint32_t> source_rate_{0};
    std::atomic<std::uint64_t> pushed_frames_{0};
    std::atomic<std::uint64_t> overflow_events_{0};
    std::atomic<std::uint64_t> overflow_frames_{0};
    std::atomic<std::uint64_t> wrong_rate_blocks_{0};
    std::atomic<std::uint32_t> fill_frames_{0};
};

// Something the playback callback mixes into the output after the local monitor
// (the live receiver, ADR-017). render_add() runs on the playback callback: it must be
// real-time safe and ADD to `out` (interleaved, `channels` per frame) rather than overwrite it.
class PlaybackContributor {
public:
    virtual ~PlaybackContributor() = default;
    virtual void render_add(float* out, std::uint32_t frames, std::uint32_t channels,
                            std::uint32_t sample_rate) noexcept = 0;
};

}  // namespace rr::audio
