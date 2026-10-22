#include "rr/audio/CaptureIngest.h"

#include <cmath>

#include "rr/shared/Clock.h"
#include "rr/shared/RealtimeGuard.h"

// The callback must never fall back to a lock-based atomic.
static_assert(std::atomic<float>::is_always_lock_free, "atomic<float> must be lock-free");
static_assert(std::atomic<uint64_t>::is_always_lock_free, "atomic<uint64_t> must be lock-free");
static_assert(std::atomic<int64_t>::is_always_lock_free, "atomic<int64_t> must be lock-free");
static_assert(std::atomic<size_t>::is_always_lock_free, "atomic<size_t> must be lock-free");
static_assert(std::atomic<double>::is_always_lock_free, "atomic<double> must be lock-free");

CaptureIngest::CaptureIngest(uint32_t channels, uint32_t sampleRate, uint32_t ringSeconds,
                             size_t gapEventCapacity)
    : channels(channels == 0 ? 1 : (channels > kMaxChannels ? kMaxChannels : channels)),
      sampleRate(sampleRate),
      samples(static_cast<size_t>(sampleRate) * (ringSeconds == 0 ? 1 : ringSeconds) *
               (channels == 0 ? 1 : (channels > kMaxChannels ? kMaxChannels : channels))),
      gaps(gapEventCapacity),
      stamps(1024)
      {
    for (size_t c = 0; c < kMaxChannels; ++c)
    {
        peaks[c].store(0.0f, std::memory_order_relaxed);
        sumSquares[c].store(0.0, std::memory_order_relaxed);
        levelSamples[c].store(0, std::memory_order_relaxed);
        clippedPerChannel[c].store(0, std::memory_order_relaxed);
    }
}

void CaptureIngest::onBlock(const float* interleaved, uint32_t frames, int64_t nowNs) noexcept
{
    ScopedRealtimeThread realtime;  // anything that may block (e.g. the logger) now refuses
    if (interleaved == nullptr || frames == 0)
    {
        return;
    }
    const uint64_t startFrame = framesCaptured.load(std::memory_order_relaxed);
    const size_t sampleCount = static_cast<size_t>(frames) * channels;

    // Meters: per-channel block peak, sum of squares and clip count, merged into the shared
    // values with a bounded number of atomic operations per channel (no locks).
    std::array<float, kMaxChannels> blockPeak{};
    std::array<double, kMaxChannels> blockSumsq{};
    std::array<uint64_t, kMaxChannels> blockClipped{};
    for (size_t i = 0; i < sampleCount; ++i)
    {
        const size_t c = i % channels;
        const float x = interleaved[i];
        const float a = std::fabs(x);
        if (a > blockPeak[c])
        {
            blockPeak[c] = a;
        }
        blockSumsq[c] += static_cast<double>(x) * static_cast<double>(x);
        if (a >= 0.999f)
        {
            ++blockClipped[c];
        }
    }
    uint64_t clippedTotal = 0;
    for (uint32_t c = 0; c < channels; ++c)
    {
        float current = peaks[c].load(std::memory_order_relaxed);
        while (blockPeak[c] > current &&
               !peaks[c].compare_exchange_weak(current, blockPeak[c], std::memory_order_relaxed)) {
        }
        double sum = sumSquares[c].load(std::memory_order_relaxed);
        while (!sumSquares[c].compare_exchange_weak(sum, sum + blockSumsq[c], std::memory_order_relaxed))
        {
        }
        levelSamples[c].fetch_add(frames, std::memory_order_relaxed);
        if (blockClipped[c] != 0)
        {
            clippedPerChannel[c].fetch_add(blockClipped[c], std::memory_order_relaxed);
            clippedTotal += blockClipped[c];
        }
    }
    if (clippedTotal != 0)
    {
        clippedSamples.fetch_add(clippedTotal, std::memory_order_relaxed);
    }

    // Store the block whole or not at all. A dropped block becomes a gap event whose
    // position the recorder fills with silence and reports (REC-05).
    if (!samples.tryWriteAll(interleaved, sampleCount))
    {
        overrunEvents.fetch_add(1, std::memory_order_relaxed);
        overrunFrames.fetch_add(frames, std::memory_order_relaxed);
        const GapEvent gap{startFrame, frames};
        if (!gaps.tryWriteAll(&gap, 1))
        {
            gapEventsLost.fetch_add(1, std::memory_order_relaxed);
        }
    }
    const uint64_t fill = (samples.capacity() - samples.writeAvailable()) / channels;
    ringFillFrames.store(fill, std::memory_order_relaxed);
    if (fill > ringMaxFillFrames.load(std::memory_order_relaxed))
    {
        ringMaxFillFrames.store(fill, std::memory_order_relaxed);
    }

    // Timing note: a callback much later than its own duration suggests the device or the
    // OS stalled. This is reported, not treated as proof that sampleCount were lost.
    const int64_t last = lastCallbackNs.load(std::memory_order_relaxed);
    if (last != 0 && sampleRate != 0)
    {
        const int64_t expectedNs =
            static_cast<int64_t>(frames) * 1'000'000'000LL / static_cast<int64_t>(sampleRate);
        const int64_t interval = nowNs - last;
        if (interval > 3 * expectedNs && interval > 20'000'000LL)
        {
            timingAnomalies.fetch_add(1, std::memory_order_relaxed);
        }
    }
    lastCallbackNs.store(nowNs, std::memory_order_relaxed);
    const CaptureStamp stamp{nowNs, startFrame + frames};
    if (!stamps.tryWriteAll(&stamp, 1))
    {
        stampsLost.fetch_add(1, std::memory_order_relaxed);
    }
    framesCaptured.store(startFrame + frames, std::memory_order_release);
    callbacks.fetch_add(1, std::memory_order_relaxed);

    const int64_t duration = monotonicNs() - nowNs;
    int64_t maxSeen = maxCallbackNs.load(std::memory_order_relaxed);
    while (duration > maxSeen &&
           !maxCallbackNs.compare_exchange_weak(maxSeen, duration, std::memory_order_relaxed)) {
    }
}

ChannelLevels CaptureIngest::takeLevels(uint32_t channel) noexcept
{
    ChannelLevels levels;
    if (channel >= channels)
    {
        return levels;
    }
    levels.peak = peaks[channel].exchange(0.0f, std::memory_order_relaxed);
    const double sum = sumSquares[channel].exchange(0.0, std::memory_order_relaxed);
    levels.samples = levelSamples[channel].exchange(0, std::memory_order_relaxed);
    levels.clipped = clippedPerChannel[channel].exchange(0, std::memory_order_relaxed);
    levels.rms = levels.samples ? static_cast<float>(std::sqrt(sum / static_cast<double>(levels.samples))) : 0.0f;
    return levels;
}

IngestStats CaptureIngest::stats() const noexcept
{
    IngestStats s;
    s.framesCaptured = framesCaptured.load(std::memory_order_acquire);
    s.callbacks = callbacks.load(std::memory_order_relaxed);
    s.overrunEvents = overrunEvents.load(std::memory_order_relaxed);
    s.overrunFrames = overrunFrames.load(std::memory_order_relaxed);
    s.gapEventsLost = gapEventsLost.load(std::memory_order_relaxed);
    s.timingAnomalies = timingAnomalies.load(std::memory_order_relaxed);
    s.clippedSamples = clippedSamples.load(std::memory_order_relaxed);
    s.maxCallbackNs = maxCallbackNs.load(std::memory_order_relaxed);
    s.lastCallbackNs = lastCallbackNs.load(std::memory_order_relaxed);
    s.ringFillFrames = ringFillFrames.load(std::memory_order_relaxed);
    s.ringMaxFillFrames = ringMaxFillFrames.load(std::memory_order_relaxed);
    s.ringCapacityFrames = ringCapacityFrames();
    s.stampsLost = stampsLost.load(std::memory_order_relaxed);
    return s;
}

