#pragma once

#include <cstdint>
#include <deque>

/**
 * Four-timestamp offset estimation (ADR-010, SYSTEM_ARCHITECTURE §4).
 * t1 requester send, t2 responder receive, t3 responder send, t4 requester receive
 * delta = (t4 - t1) - (t3 - t2)            round trip excluding the responder's work
 * theta = ((t2 - t1) + (t3 - t4)) / 2      estimate of (responder clock - requester clock)
 * The estimate reported is theta of the sample with the smallest delta among the last
 * `window`; its uncertainty is delta_min / 2 (the true offset lies within theta +/- u if the
 * timestamps are exact, whatever the path asymmetry).
 *
 * In Stage 6 the samples come from TCP heartbeats stamped on the control thread, so delta
 * includes TCP and thread-scheduling time: the uncertainty is reported as it is, not hidden.
 *
 * Stage 12: `maxDeltaNs` is a sanity ceiling, NOT a quality filter. The estimate is already the
 * best sample of the window, so a slow sample cannot pull theta: it only sits in the deque until
 * a better one replaces it. The ceiling was 100 ms, which is below the ordinary round trip of a
 * shared Wi-Fi link, so on Wi-Fi every sample was rejected, `sampleCount()` never reached the
 * readiness threshold and the performer could never become ready. It is now 1 s, which still
 * rejects a stalled link while letting a normal wireless link converge. Link quality is expressed
 * through the reported uncertainty (and therefore the minimum start lead), not by refusing to
 * measure at all.
 */
class ClockOffsetEstimator
{
public:
    explicit ClockOffsetEstimator(size_t window = 16, int64_t maxDeltaNs = 1'000'000'000);

    /** Returns false (and ignores the sample) if it is inconsistent or delta exceeds the limit. */
    bool addSample(int64_t t1, int64_t t2, int64_t t3, int64_t t4);

    bool hasEstimate() const noexcept { return !samples.empty(); }
    size_t sampleCount() const noexcept { return samples.size(); }
    int64_t thetaNs() const noexcept;        // responder - requester
    int64_t uncertaintyNs() const noexcept;  // delta_min / 2
    int64_t lastDeltaNs() const noexcept { return lastDelta; }
    /**
     * Smallest round trip in the window, i.e. the delta of the sample theta_ns() came from.
     * -1 when there is no estimate. This is the stable figure to plan a schedule against: the
     * latest round trip swings with every Wi-Fi hiccup, this one does not.
     */
    int64_t bestDeltaNs() const noexcept;
    uint64_t getRejected() const noexcept { return rejected; }
    void reset();

private:
    struct Sample
    {
        int64_t theta;
        int64_t delta;
    };
    size_t window;
    int64_t maxDelta;
    std::deque<Sample> samples;
    int64_t lastDelta = -1;
    uint64_t rejected = 0;
};

