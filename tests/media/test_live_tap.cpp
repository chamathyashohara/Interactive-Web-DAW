// Capture -> live sender hand-over (ADR-017) and arrival statistics.
// TEST SIGNAL - blocks are fed through LiveTap::push_capture(), the same entry point the real
// capture callback uses. No audio hardware is involved.

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <vector>

#include "rr/audio/live_tap.hpp"
#include "rr/media/arrival_stats.hpp"

using rr::audio::LiveTap;
using rr::media::ArrivalStats;

TEST_CASE("The live tap averages channels to mono and is fed only while enabled at 48 kHz", "[media][tap]") {
    LiveTap tap(1024);
    std::vector<float> stereo{0.2f, 0.4f, -0.5f, 0.1f, 1.0f, 1.0f};  // 3 frames
    tap.push_capture(stereo.data(), 3, 2);
    CHECK(tap.ring().read_available() == 0);  // disabled
    tap.set_enabled(true);
    tap.push_capture(stereo.data(), 3, 2);
    CHECK(tap.ring().read_available() == 0);  // rate unknown (no capture device)
    CHECK(tap.stats().wrong_rate_blocks == 1);
    tap.set_source_rate(44100);
    tap.push_capture(stereo.data(), 3, 2);
    CHECK(tap.stats().wrong_rate_blocks == 2);
    tap.set_source_rate(48000);
    tap.push_capture(stereo.data(), 3, 2);
    float mono[3] = {};
    REQUIRE(tap.ring().read(mono, 3) == 3);
    CHECK_THAT(mono[0], Catch::Matchers::WithinAbs(0.3, 1e-6));
    CHECK_THAT(mono[1], Catch::Matchers::WithinAbs(-0.2, 1e-6));
    CHECK_THAT(mono[2], Catch::Matchers::WithinAbs(1.0, 1e-6));
    CHECK(tap.stats().pushed_frames == 3);
}

TEST_CASE("A full live tap drops whole blocks and counts them; it never blocks", "[media][tap]") {
    LiveTap tap(8);  // capacity 8 frames
    tap.set_source_rate(48000);
    tap.set_enabled(true);
    std::vector<float> block(5, 0.5f);
    tap.push_capture(block.data(), 5, 1);
    tap.push_capture(block.data(), 5, 1);  // only 3 free: the whole block is dropped
    CHECK(tap.ring().read_available() == 5);
    CHECK(tap.stats().overflow_events == 1);
    CHECK(tap.stats().overflow_frames == 5);
    CHECK(tap.dropped_frames() == 5);
}

TEST_CASE("Arrival statistics: loss estimate, reordering, duplicates and restarts", "[media][arrival]") {
    ArrivalStats a;
    std::int64_t t = 1000000000;
    auto arrive = [&](std::uint32_t seq) { return a.on_packet(seq, static_cast<std::uint64_t>(seq) * 480, t + seq * 10000000ll); };
    for (std::uint32_t s = 0; s < 10; ++s) {
        CHECK(arrive(s) == ArrivalStats::Result::New);
    }
    CHECK(a.snapshot().lost_estimate == 0);
    CHECK(a.snapshot().jitter_ms < 0.001);  // perfectly paced
    arrive(12);
    CHECK(a.snapshot().lost_estimate == 2);
    CHECK(arrive(11) == ArrivalStats::Result::New);  // late but not lost after all
    CHECK(a.snapshot().lost_estimate == 1);
    CHECK(a.snapshot().reordered == 1);
    CHECK(arrive(11) == ArrivalStats::Result::Duplicate);
    CHECK(arrive(5) == ArrivalStats::Result::Duplicate);
    CHECK(a.snapshot().duplicates == 2);
    CHECK(a.snapshot().received == 12);
    // Sender restarted its stream (sequence back to 0 after a long run).
    for (std::uint32_t s = 13; s < 2000; ++s) {
        arrive(s);
    }
    CHECK(arrive(0) == ArrivalStats::Result::Restart);
    CHECK(a.snapshot().stream_restarts == 1);
    CHECK(a.snapshot().lost_estimate == 1);  // the old stream's loss is kept
}

TEST_CASE("Arrival jitter grows with irregular arrival and survives the 2^32 wrap", "[media][arrival]") {
    ArrivalStats a;
    std::int64_t t = 0;
    std::uint32_t seq = 0xFFFFFFF0u;
    for (int i = 0; i < 64; ++i) {
        t += (i % 2 == 0) ? 6000000 : 14000000;  // alternating 6 / 14 ms instead of 10 ms
        a.on_packet(seq++, static_cast<std::uint64_t>(i) * 480, t);
    }
    const auto s = a.snapshot();
    CHECK(s.lost_estimate == 0);
    CHECK(s.received == 64);
    CHECK(s.jitter_ms > 3.0);
    CHECK(s.jitter_ms < 4.5);
    CHECK_THAT(s.max_gap_ms, Catch::Matchers::WithinAbs(14.0, 1e-6));
}
