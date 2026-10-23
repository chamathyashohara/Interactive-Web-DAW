// Capture -> live sender hand-over (ADR-017) and arrival statistics.
// TEST SIGNAL - blocks are fed through LiveTap::pushCapture(), the same entry point the real
// capture callback uses. No audio hardware is involved.

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <vector>

#include "rr/audio/LiveTap.h"
#include "rr/media/ArrivalStats.h"

TEST_CASE("The live tap averages channels to mono and is fed only while enabled at 48 kHz", "[media][tap]")
{
    LiveTap tap(1024);
    std::vector<float> stereo{0.2f, 0.4f, -0.5f, 0.1f, 1.0f, 1.0f};  // 3 frames
    tap.pushCapture(stereo.data(), 3, 2);
    CHECK(tap.getRing().readAvailable() == 0);  // disabled
    tap.setEnabled(true);
    tap.pushCapture(stereo.data(), 3, 2);
    CHECK(tap.getRing().readAvailable() == 0);  // rate unknown (no capture device)
    CHECK(tap.stats().wrongRateBlocks == 1);
    tap.setSourceRate(44100);
    tap.pushCapture(stereo.data(), 3, 2);
    CHECK(tap.stats().wrongRateBlocks == 2);
    tap.setSourceRate(48000);
    tap.pushCapture(stereo.data(), 3, 2);
    float mono[3] = {};
    REQUIRE(tap.getRing().read(mono, 3) == 3);
    CHECK_THAT(mono[0], Catch::Matchers::WithinAbs(0.3, 1e-6));
    CHECK_THAT(mono[1], Catch::Matchers::WithinAbs(-0.2, 1e-6));
    CHECK_THAT(mono[2], Catch::Matchers::WithinAbs(1.0, 1e-6));
    CHECK(tap.stats().pushedFrames == 3);
}

TEST_CASE("A full live tap drops whole blocks and counts them; it never blocks", "[media][tap]")
{
    LiveTap tap(8);  // capacity 8 frames
    tap.setSourceRate(48000);
    tap.setEnabled(true);
    std::vector<float> block(5, 0.5f);
    tap.pushCapture(block.data(), 5, 1);
    tap.pushCapture(block.data(), 5, 1);  // only 3 free: the whole block is dropped
    CHECK(tap.getRing().readAvailable() == 5);
    CHECK(tap.stats().overflowEvents == 1);
    CHECK(tap.stats().overflowFrames == 5);
    CHECK(tap.droppedFrames() == 5);
}

TEST_CASE("Arrival statistics: loss estimate, reordering, duplicates and restarts", "[media][arrival]")
{
    ArrivalStats a;
    int64_t t = 1000000000;
    auto arrive = [&](uint32_t seq) { return a.onPacket(seq, static_cast<uint64_t>(seq) * 480, t + seq * 10000000ll); };
    for (uint32_t s = 0; s < 10; ++s)
    {
        CHECK(arrive(s) == ArrivalStats::Result::New);
    }
    CHECK(a.snapshot().lostEstimate == 0);
    CHECK(a.snapshot().jitterMs < 0.001);  // perfectly paced
    arrive(12);
    CHECK(a.snapshot().lostEstimate == 2);
    CHECK(arrive(11) == ArrivalStats::Result::New);  // late but not lost after all
    CHECK(a.snapshot().lostEstimate == 1);
    CHECK(a.snapshot().reordered == 1);
    CHECK(arrive(11) == ArrivalStats::Result::Duplicate);
    CHECK(arrive(5) == ArrivalStats::Result::Duplicate);
    CHECK(a.snapshot().duplicates == 2);
    CHECK(a.snapshot().received == 12);
    // Sender restarted its stream (sequence back to 0 after a long run).
    for (uint32_t s = 13; s < 2000; ++s)
    {
        arrive(s);
    }
    CHECK(arrive(0) == ArrivalStats::Result::Restart);
    CHECK(a.snapshot().streamRestarts == 1);
    CHECK(a.snapshot().lostEstimate == 1);  // the old stream's loss is kept
}

TEST_CASE("Arrival jitter grows with irregular arrival and survives the 2^32 wrap", "[media][arrival]")
{
    ArrivalStats a;
    int64_t t = 0;
    uint32_t seq = 0xFFFFFFF0u;
    for (int i = 0; i < 64; ++i)
    {
        t += (i % 2 == 0) ? 6000000 : 14000000;  // alternating 6 / 14 ms instead of 10 ms
        a.onPacket(seq++, static_cast<uint64_t>(i) * 480, t);
    }
    const auto s = a.snapshot();
    CHECK(s.lostEstimate == 0);
    CHECK(s.received == 64);
    CHECK(s.jitterMs > 3.0);
    CHECK(s.jitterMs < 4.5);
    CHECK_THAT(s.maxGapMs, Catch::Matchers::WithinAbs(14.0, 1e-6));
}

TEST_CASE("A sender restart only 100 packets after its start is a new stream, not 'duplicates'", "[media][arrival]")
{
    ArrivalStats a;
    int64_t t = 0;
    for (uint32_t s = 0; s < 100; ++s)
    {
        a.onPacket(s, s * 480ull, t += 10000000);
    }
    CHECK(a.onPacket(60, 60 * 480ull, t += 10000000) == ArrivalStats::Result::Duplicate);  // recent: a duplicate
    CHECK(a.onPacket(0, 0, t += 10000000) == ArrivalStats::Result::Restart);              // 99 back: a restart
    CHECK(a.onPacket(1, 480, t += 10000000) == ArrivalStats::Result::New);
    CHECK(a.snapshot().duplicates == 1);
    CHECK(a.snapshot().streamRestarts == 1);
}
