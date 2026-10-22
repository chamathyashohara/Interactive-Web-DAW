#include "rr/network/ClockOffset.h"

ClockOffsetEstimator::ClockOffsetEstimator(size_t window, int64_t maxDeltaNs)
    : window(window == 0 ? 1 : window), maxDelta(maxDeltaNs) {}

bool ClockOffsetEstimator::addSample(int64_t t1, int64_t t2, int64_t t3, int64_t t4)
{
    const int64_t delta = (t4 - t1) - (t3 - t2);
    if (t4 < t1 || t3 < t2 || delta < 0 || delta > maxDelta)
    {
        ++rejected;
        return false;
    }
    // Integer halves: exact to 1 ns, which is far below anything measured here.
    const int64_t theta = ((t2 - t1) + (t3 - t4)) / 2;
    samples.push_back(Sample{theta, delta});
    if (samples.size() > window)
    {
        samples.pop_front();
    }
    lastDelta = delta;
    return true;
}

int64_t ClockOffsetEstimator::thetaNs() const noexcept
{
    if (samples.empty())
    {
        return 0;
    }
    const Sample* best = &samples.front();
    for (const Sample& s : samples)
    {
        if (s.delta < best->delta)
        {
            best = &s;
        }
    }
    return best->theta;
}

int64_t ClockOffsetEstimator::bestDeltaNs() const noexcept
{
    if (samples.empty())
    {
        return -1;
    }
    int64_t minDelta = samples.front().delta;
    for (const Sample& s : samples)
    {
        if (s.delta < minDelta)
        {
            minDelta = s.delta;
        }
    }
    return minDelta;
}

int64_t ClockOffsetEstimator::uncertaintyNs() const noexcept
{
    const int64_t minDelta = bestDeltaNs();
    return minDelta < 0 ? -1 : minDelta / 2;
}

void ClockOffsetEstimator::reset()
{
    samples.clear();
    lastDelta = -1;
}

