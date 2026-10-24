#include "rr/media/ArrivalStats.h"

#include <cmath>

#include "rr/media/LiveSettings.h"

void ArrivalStats::begin(uint32_t seq) noexcept
{
    // Close the previous stream's loss account.
    if (started)
    {
        const uint64_t expected = highestExt - firstExt + 1;
        expectedClosed += expected;
        lostClosed += expected > streamReceived ? expected - streamReceived : 0;
    }
    started = true;
    // Extended sequence numbers start at 2^32 so a backward step never underflows.
    firstExt = (uint64_t{1} << 32) + seq;
    highestExt = firstExt;
    seen.reset();
    havePrev = false;
    streamReceived = 0;
}

ArrivalStats::Result ArrivalStats::onPacket(uint32_t seq, uint64_t mediaIndex, int64_t arrivalNs) noexcept
{
    Result result = Result::New;
    if (!started)
    {
        begin(seq);
    }
    else
    {
        const auto d = static_cast<int32_t>(seq - static_cast<uint32_t>(highestExt));
        if (d <= -static_cast<int32_t>(kRestartBack))
        {
            begin(seq);
            ++totals.streamRestarts;
            result = Result::Restart;
        }
        else if (d > 0)
        {
            // Advance: clear the window bits for the skipped numbers.
            const uint32_t steps = static_cast<uint32_t>(d) < kWindow ? static_cast<uint32_t>(d) : kWindow;
            for (uint32_t i = 1; i <= steps; ++i)
            {
                seen.reset(static_cast<size_t>((highestExt + i) % kWindow));
            }
            highestExt += static_cast<uint64_t>(d);
        }
        else
        {
            const uint64_t ext = highestExt - static_cast<uint64_t>(-static_cast<int64_t>(d));
            if (ext < firstExt || seen.test(static_cast<size_t>(ext % kWindow)))
            {
                ++totals.duplicates;  // seen before (or older than the stream start)
                return Result::Duplicate;
            }
            if (d < 0)
            {
                ++totals.reordered;
            }
        }
    }
    const uint64_t ext = highestExt - static_cast<uint64_t>(
        -static_cast<int64_t>(static_cast<int32_t>(seq - static_cast<uint32_t>(highestExt))));
    seen.set(static_cast<size_t>(ext % kWindow));
    ++streamReceived;
    ++totals.received;

    // RFC 3550 jitter over consecutive arrivals.
    if (havePrev)
    {
        const double arrivalDelta = static_cast<double>(arrivalNs - prevArrivalNs);
        const double mediaDelta =
            (static_cast<double>(mediaIndex) - static_cast<double>(prevMedia)) * 1e9 / kLiveSampleRate;
        const double dd = std::fabs(arrivalDelta - mediaDelta);
        jitterNs += (dd - jitterNs) / 16.0;
        if (arrivalDelta > maxGapNs)
        {
            maxGapNs = arrivalDelta;
        }
    }
    havePrev = true;
    prevArrivalNs = arrivalNs;
    prevMedia = mediaIndex;
    return result;
}

void ArrivalStats::onEndOfStream() noexcept
{
    if (started)
    {
        const uint64_t expected = highestExt - firstExt + 1;
        expectedClosed += expected;
        lostClosed += expected > streamReceived ? expected - streamReceived : 0;
    }
    started = false;
    havePrev = false;
}

ArrivalSnapshot ArrivalStats::snapshot() const noexcept
{
    ArrivalSnapshot s = totals;
    uint64_t expected = expectedClosed;
    uint64_t lost = lostClosed;
    if (started)
    {
        const uint64_t e = highestExt - firstExt + 1;
        expected += e;
        lost += e > streamReceived ? e - streamReceived : 0;
    }
    s.expected = expected;
    s.lostEstimate = lost;
    s.jitterMs = jitterNs / 1e6;
    s.maxGapMs = maxGapNs / 1e6;
    return s;
}

