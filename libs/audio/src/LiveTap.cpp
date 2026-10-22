#include "rr/audio/LiveTap.h"

LiveTap::LiveTap(uint32_t capacityFrames) : ring(capacityFrames), scratch(kMaxBlockFrames) {}

void LiveTap::pushCapture(const float* interleaved, uint32_t frames, uint32_t channels) noexcept
{
    if (!enabled.load(std::memory_order_acquire) || interleaved == nullptr || channels == 0)
    {
        return;
    }
    if (sourceRate.load(std::memory_order_acquire) != kRequiredRate)
    {
        wrongRateBlocks.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    // All-or-nothing per block, so a drop is one contiguous gap.
    if (ring.writeAvailable() < frames)
    {
        overflowEvents.fetch_add(1, std::memory_order_relaxed);
        overflowFrames.fetch_add(frames, std::memory_order_release);
        return;
    }
    const float scale = 1.0f / static_cast<float>(channels);
    uint32_t done = 0;
    while (done < frames)
    {
        const uint32_t n = (frames - done) < kMaxBlockFrames ? (frames - done) : kMaxBlockFrames;
        const float* in = interleaved + static_cast<size_t>(done) * channels;
        for (uint32_t f = 0; f < n; ++f)
        {
            float sum = 0.0f;
            for (uint32_t c = 0; c < channels; ++c)
            {
                sum += in[static_cast<size_t>(f) * channels + c];
            }
            scratch[f] = sum * scale;
        }
        ring.tryWriteAll(scratch.data(), n);  // room was checked above (single producer)
        done += n;
    }
    pushedFrames.fetch_add(frames, std::memory_order_relaxed);
    fillFrames.store(static_cast<uint32_t>(ring.capacity() - ring.writeAvailable()),
                       std::memory_order_relaxed);
}

LiveTapStats LiveTap::stats() const noexcept
{
    LiveTapStats s;
    s.pushedFrames = pushedFrames.load(std::memory_order_relaxed);
    s.overflowEvents = overflowEvents.load(std::memory_order_relaxed);
    s.overflowFrames = overflowFrames.load(std::memory_order_relaxed);
    s.wrongRateBlocks = wrongRateBlocks.load(std::memory_order_relaxed);
    s.fillFrames = fillFrames.load(std::memory_order_relaxed);
    s.capacityFrames = static_cast<uint32_t>(ring.capacity());
    s.sourceRate = sourceRate.load(std::memory_order_relaxed);
    return s;
}

