#pragma once

#include <atomic>
#include <cstdint>
#include <vector>

#include "rr/audio/SpscRing.h"

struct LiveTapStats
{
    uint64_t pushedFrames = 0;          // mono frames written for the live sender
    uint64_t overflowEvents = 0;        // capture block dropped: tap ring full (sender not keeping up)
    uint64_t overflowFrames = 0;
    uint64_t wrongRateBlocks = 0;      // capture rate is not 48 kHz: nothing tapped (Opus needs 48 kHz)
    uint32_t fillFrames = 0;            // after the latest push
    uint32_t capacityFrames = 0;
    uint32_t sourceRate = 0;
};

/**
 * Capture -> live-sender hand-over for the live audio path (Stage 7, ADR-017).
 *
 * capture callback --pushCapture()--> [mono float SPSC ring] --ring()--> live sender thread
 *
 * Live-path-only processing (stated in the UI and the report): multi-channel input is
 * averaged to mono. Nothing here touches the master recording, which has its own ring.
 *
 * Real-time rules: pushCapture() runs on the capture callback and only uses preallocated
 * memory, atomics and bounded loops. If the ring is full (the sender thread stalled) the
 * WHOLE block is dropped and counted as an overflow; the sender sees a gap in the
 * live-stream sample counter (live_frame_index), never a blocked callback.
 * The tap is fed only while enabled AND while the capture rate is 48 kHz.
 */
class LiveTap
{
public:
    static constexpr uint32_t kRequiredRate = 48000;
    static constexpr uint32_t kMaxBlockFrames = 4096;  // larger blocks are processed in chunks

    explicit LiveTap(uint32_t capacityFrames = 24000);  // 500 ms at 48 kHz
    LiveTap(const LiveTap&) = delete;
    LiveTap& operator=(const LiveTap&) = delete;

    /** ---- capture callback (real-time) ---- */
    void pushCapture(const float* interleaved, uint32_t frames, uint32_t channels) noexcept;

    /** ---- control (any non-real-time thread) ---- */
    void setEnabled(bool on) noexcept { enabled.store(on, std::memory_order_release); }
    bool isEnabled() const noexcept { return enabled.load(std::memory_order_acquire); }
    void setSourceRate(uint32_t rate) noexcept { sourceRate.store(rate, std::memory_order_release); }
    uint32_t getSourceRate() const noexcept { return sourceRate.load(std::memory_order_acquire); }
    LiveTapStats stats() const noexcept;

    /** ---- consumer (the one live sender thread) ---- */
    SpscRing<float>& getRing() noexcept { return ring; }
    /** Frames dropped by overflow so far (the sender adds the increase to its sample counter). */
    uint64_t droppedFrames() const noexcept { return overflowFrames.load(std::memory_order_acquire); }

private:
    SpscRing<float> ring;
    std::vector<float> scratch;  // capture side only
    std::atomic<bool> enabled{false};
    std::atomic<uint32_t> sourceRate{0};
    std::atomic<uint64_t> pushedFrames{0};
    std::atomic<uint64_t> overflowEvents{0};
    std::atomic<uint64_t> overflowFrames{0};
    std::atomic<uint64_t> wrongRateBlocks{0};
    std::atomic<uint32_t> fillFrames{0};
};

/**
 * Something the playback callback mixes into the output after the local monitor
 * (the live receiver, ADR-017). renderAdd() runs on the playback callback: it must be
 * real-time safe and ADD to `out` (interleaved, `channels` per frame) rather than overwrite it.
 */
class PlaybackContributor
{
public:
    virtual ~PlaybackContributor() = default;
    virtual void renderAdd(float* out, uint32_t frames, uint32_t channels,
                            uint32_t sampleRate) noexcept = 0;
};

