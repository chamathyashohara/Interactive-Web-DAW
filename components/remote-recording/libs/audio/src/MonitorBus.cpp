#include "rr/audio/MonitorBus.h"

#include <cmath>

#include "rr/shared/Clock.h"
#include "rr/shared/RealtimeGuard.h"

namespace
{

constexpr double kTwoPi = 6.283185307179586;

uint32_t msToFrames(uint32_t rate, uint32_t ms)
{
    return static_cast<uint32_t>(static_cast<uint64_t>(rate) * ms / 1000);
}

}  // namespace

MonitorBus::MonitorBus(uint32_t sampleRate, uint32_t capacityMs, uint32_t targetMs)
    : sampleRate(sampleRate == 0 ? 48000 : sampleRate),
      targetFrames(msToFrames(sampleRate, targetMs == 0 ? 1 : targetMs)),
      ring(static_cast<size_t>(msToFrames(sampleRate, capacityMs < 2 * targetMs ? 2 * targetMs : capacityMs)) * 2),
      captureScratch(static_cast<size_t>(kMaxBlockFrames) * 2, 0.0f),
      renderScratch(static_cast<size_t>(kMaxBlockFrames) * 2, 0.0f) {}

void MonitorBus::setGainDb(float db) noexcept
{
    if (db < -60.0f)
    {
        db = -60.0f;
    }
    if (db > 12.0f)
    {
        db = 12.0f;
    }
    gainDb.store(db, std::memory_order_relaxed);
    gainLinear.store(std::pow(10.0f, db / 20.0f), std::memory_order_relaxed);
}

void MonitorBus::startTestTone(float frequencyHz, float levelDbfs, float seconds) noexcept
{
    toneFrequency.store(frequencyHz, std::memory_order_relaxed);
    toneAmplitude.store(std::pow(10.0f, levelDbfs / 20.0f), std::memory_order_relaxed);
    toneFramesLeft.store(static_cast<uint64_t>(seconds * static_cast<float>(sampleRate)),
                            std::memory_order_release);
}

void MonitorBus::pushCapture(const float* in, uint32_t frames, uint32_t channels) noexcept
{
    if (!enabled.load(std::memory_order_acquire) || in == nullptr || channels == 0)
    {
        return;
    }
    ScopedRealtimeThread realtime;
    uint32_t done = 0;
    while (done < frames)
    {
        const uint32_t n = (frames - done) < kMaxBlockFrames ? (frames - done) : kMaxBlockFrames;
        const float* src = in + static_cast<size_t>(done) * channels;
        for (uint32_t f = 0; f < n; ++f)
        {
            const float l = src[static_cast<size_t>(f) * channels];
            const float r = channels >= 2 ? src[static_cast<size_t>(f) * channels + 1] : l;
            captureScratch[2 * static_cast<size_t>(f)] = l;
            captureScratch[2 * static_cast<size_t>(f) + 1] = r;
        }
        if (!ring.tryWriteAll(captureScratch.data(), static_cast<size_t>(n) * 2))
        {
            overflowEvents.fetch_add(1, std::memory_order_relaxed);
            overflowFrames.fetch_add(n, std::memory_order_relaxed);
        }
        pushedFrames.fetch_add(n, std::memory_order_relaxed);
        done += n;
    }
}

void MonitorBus::render(float* out, uint32_t frames, uint32_t outChannels) noexcept
{
    if (out == nullptr || outChannels == 0)
    {
        return;
    }
    ScopedRealtimeThread realtime;
    const int64_t start = monotonicNs();
    const bool on = enabled.load(std::memory_order_acquire);
    const float gain = gainLinear.load(std::memory_order_relaxed);
    const size_t samplesOut = static_cast<size_t>(frames) * outChannels;
    for (size_t i = 0; i < samplesOut; ++i)
    {
        out[i] = 0.0f;
    }

    if (!on)
    {
        // Not monitoring: discard anything buffered so re-enabling starts fresh and short.
        size_t available = ring.readAvailable();
        while (available > 0)
        {
            const size_t got = ring.read(renderScratch.data(),
                                               available < renderScratch.size() ? available : renderScratch.size());
            if (got == 0)
            {
                break;
            }
            available -= got;
        }
        playing = false;
        overTargetRenders = 0;
    }
    else
    {
        size_t availableFrames = ring.readAvailable() / 2;
        if (!playing)
        {
            if (availableFrames >= targetFrames)
            {
                playing = true;
                prefillEvents.fetch_add(1, std::memory_order_relaxed);
                // Start exactly at the target latency: audio that piled up while the output was
                // not running (device (re)start, underrun recovery) is older than needed. Dropping
                // it here keeps monitor delay at the target instead of carrying the backlog.
                size_t excess = availableFrames - targetFrames;
                if (excess > 0)
                {
                    startTrimFrames.fetch_add(excess, std::memory_order_relaxed);
                }
                while (excess > 0)
                {
                    const size_t chunk = excess < kMaxBlockFrames ? excess : kMaxBlockFrames;
                    const size_t got = ring.read(renderScratch.data(), chunk * 2) / 2;
                    if (got == 0)
                    {
                        break;
                    }
                    excess -= got;
                }
                availableFrames = ring.readAvailable() / 2;
            }
        }
        if (playing)
        {
            // Drift: if more than target + 4 blocks stays buffered for 50 renders in a row, drop
            // the excess down to the target (counted). Keeps monitor latency bounded.
            if (availableFrames > static_cast<size_t>(targetFrames) + 4u * frames)
            {
                if (++overTargetRenders >= 50)
                {
                    size_t excess = availableFrames - targetFrames;
                    driftTrimEvents.fetch_add(1, std::memory_order_relaxed);
                    driftTrimFrames.fetch_add(excess, std::memory_order_relaxed);
                    while (excess > 0)
                    {
                        const size_t chunk = excess < kMaxBlockFrames ? excess : kMaxBlockFrames;
                        const size_t got = ring.read(renderScratch.data(), chunk * 2) / 2;
                        if (got == 0)
                        {
                            break;
                        }
                        excess -= got;
                    }
                    availableFrames = ring.readAvailable() / 2;
                    overTargetRenders = 0;
                }
            }
            else
            {
                overTargetRenders = 0;
            }

            uint32_t written = 0;
            while (written < frames)
            {
                const uint32_t want = (frames - written) < kMaxBlockFrames ? (frames - written) : kMaxBlockFrames;
                const uint32_t got =
                    static_cast<uint32_t>(ring.read(renderScratch.data(), static_cast<size_t>(want) * 2) / 2);
                for (uint32_t f = 0; f < got; ++f)
                {
                    const float l = renderScratch[2 * static_cast<size_t>(f)] * gain;
                    const float r = renderScratch[2 * static_cast<size_t>(f) + 1] * gain;
                    float* o = out + static_cast<size_t>(written + f) * outChannels;
                    if (outChannels == 1)
                    {
                        o[0] = 0.5f * (l + r);
                    }
                    else
                    {
                        o[0] = l;
                        o[1] = r;
                    }
                }
                written += got;
                if (got < want)
                {
                    // Ran dry: the rest of this block stays silent; refill to the target first.
                    underrunEvents.fetch_add(1, std::memory_order_relaxed);
                    underrunFrames.fetch_add(frames - written, std::memory_order_relaxed);
                    playing = false;
                    overTargetRenders = 0;
                    break;
                }
            }
        }
    }

    // Output test tone (mixed on top; independent of monitoring).
    uint64_t toneLeft = toneFramesLeft.load(std::memory_order_acquire);
    if (toneLeft > 0)
    {
        const uint32_t n = toneLeft < frames ? static_cast<uint32_t>(toneLeft) : frames;
        const double step = kTwoPi * static_cast<double>(toneFrequency.load(std::memory_order_relaxed)) / sampleRate;
        const float amplitude = toneAmplitude.load(std::memory_order_relaxed);
        for (uint32_t f = 0; f < n; ++f)
        {
            const float v = amplitude * static_cast<float>(std::sin(tonePhase));
            tonePhase += step;
            if (tonePhase > kTwoPi)
            {
                tonePhase -= kTwoPi;
            }
            float* o = out + static_cast<size_t>(f) * outChannels;
            for (uint32_t c = 0; c < outChannels && c < 2; ++c)
            {
                o[c] += v;
            }
        }
        // A new tone requested meanwhile wins; otherwise count down.
        toneFramesLeft.compare_exchange_strong(toneLeft, toneLeft - n, std::memory_order_acq_rel);
    }

    const auto fill = static_cast<uint32_t>(ring.readAvailable() / 2);
    fillFrames.store(fill, std::memory_order_relaxed);
    if (fill > maxFillFrames.load(std::memory_order_relaxed))
    {
        maxFillFrames.store(fill, std::memory_order_relaxed);
    }
    playedFrames.fetch_add(frames, std::memory_order_relaxed);
    renderCallbacks.fetch_add(1, std::memory_order_relaxed);
    const int64_t duration = monotonicNs() - start;
    if (duration > maxRenderNs.load(std::memory_order_relaxed))
    {
        maxRenderNs.store(duration, std::memory_order_relaxed);
    }
}

MonitorStats MonitorBus::stats() const noexcept
{
    MonitorStats s;
    s.pushedFrames = pushedFrames.load(std::memory_order_relaxed);
    s.overflowEvents = overflowEvents.load(std::memory_order_relaxed);
    s.overflowFrames = overflowFrames.load(std::memory_order_relaxed);
    s.playedFrames = playedFrames.load(std::memory_order_relaxed);
    s.renderCallbacks = renderCallbacks.load(std::memory_order_relaxed);
    s.underrunEvents = underrunEvents.load(std::memory_order_relaxed);
    s.underrunFrames = underrunFrames.load(std::memory_order_relaxed);
    s.prefillEvents = prefillEvents.load(std::memory_order_relaxed);
    s.startTrimFrames = startTrimFrames.load(std::memory_order_relaxed);
    s.driftTrimEvents = driftTrimEvents.load(std::memory_order_relaxed);
    s.driftTrimFrames = driftTrimFrames.load(std::memory_order_relaxed);
    s.fillFrames = fillFrames.load(std::memory_order_relaxed);
    s.maxFillFrames = maxFillFrames.load(std::memory_order_relaxed);
    s.targetFrames = targetFrames;
    s.capacityFrames = static_cast<uint32_t>(ring.capacity() / 2);
    s.maxRenderNs = maxRenderNs.load(std::memory_order_relaxed);
    return s;
}

