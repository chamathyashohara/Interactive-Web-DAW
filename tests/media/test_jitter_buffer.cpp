// Fixed-depth jitter buffer policy (ADR-011, ADR-017): filling, loss, reordering, duplicates,
// lateness, underrun/rebuffer, too-early reset, 2^32 wrap and drift skips.

#include <catch2/catch_test_macros.hpp>

#include <vector>

#include "rr/media/jitter_buffer.hpp"

using namespace rr::media;
using Pull = JitterBuffer::Pull;
using Insert = JitterBuffer::Insert;

namespace {

JbPacket packet(std::uint32_t seq) {
    JbPacket p;
    p.seq = seq;
    p.len = 1;
    p.data[0] = static_cast<std::uint8_t>(seq);
    return p;
}

}  // namespace

TEST_CASE("Jitter buffer fills to its target, then plays in sequence order", "[media][jitter]") {
    JitterBuffer jb(3, 20);
    JbPacket out;
    CHECK(jb.pull(out) == Pull::Filling);
    CHECK(jb.insert(packet(10)) == Insert::Accepted);
    CHECK(jb.insert(packet(12)) == Insert::Accepted);
    CHECK(jb.pull(out) == Pull::Filling);
    CHECK_FALSE(jb.playing());
    CHECK(jb.insert(packet(11)) == Insert::Accepted);  // reordered within the depth
    CHECK(jb.playing());
    for (std::uint32_t s = 10; s <= 12; ++s) {
        REQUIRE(jb.pull(out) == Pull::Packet);
        CHECK(out.seq == s);
    }
    CHECK(jb.stats().played == 3);
}

TEST_CASE("A missing packet with later ones held is Lost; with nothing held it is an Underrun", "[media][jitter]") {
    JitterBuffer jb(2, 3);
    JbPacket out;
    jb.insert(packet(0));
    jb.insert(packet(1));
    jb.insert(packet(3));
    CHECK(jb.pull(out) == Pull::Packet);
    CHECK(jb.pull(out) == Pull::Packet);
    CHECK(jb.pull(out) == Pull::Lost);  // 2 missing, 3 held
    CHECK(jb.pull(out) == Pull::Packet);
    CHECK(out.seq == 3);
    CHECK(jb.pull(out) == Pull::Underrun);
    CHECK(jb.pull(out) == Pull::Underrun);
    CHECK(jb.playing());
    CHECK(jb.pull(out) == Pull::Underrun);  // stall limit 3 reached
    CHECK_FALSE(jb.playing());
    CHECK(jb.stats().lost == 1);
    CHECK(jb.stats().underruns == 3);
    CHECK(jb.stats().rebuffers == 1);
    CHECK(jb.pull(out) == Pull::Filling);
}

TEST_CASE("Late and duplicate arrivals are dropped and counted", "[media][jitter]") {
    JitterBuffer jb(2, 20);
    JbPacket out;
    jb.insert(packet(5));
    CHECK(jb.insert(packet(5)) == Insert::Duplicate);  // while filling
    jb.insert(packet(6));
    CHECK(jb.insert(packet(6)) == Insert::Duplicate);  // while playing
    CHECK(jb.pull(out) == Pull::Packet);
    CHECK(jb.pull(out) == Pull::Packet);
    CHECK(jb.pull(out) == Pull::Underrun);  // 7 not there in time
    CHECK(jb.insert(packet(7)) == Insert::Late);
    CHECK(jb.insert(packet(4)) == Insert::Late);
    CHECK(jb.stats().late == 2);
    CHECK(jb.stats().duplicates == 2);
}

TEST_CASE("A packet far ahead of the window resets the buffer to filling", "[media][jitter]") {
    JitterBuffer jb(2, 20);
    JbPacket out;
    jb.insert(packet(0));
    jb.insert(packet(1));
    REQUIRE(jb.playing());
    CHECK(jb.insert(packet(0 + JitterBuffer::kSlots)) == Insert::TooEarlyReset);
    CHECK_FALSE(jb.playing());
    CHECK(jb.held() == 1);
    CHECK(jb.stats().too_early_resets == 1);
    // While filling, a packet that would stretch the held span past the window also restarts.
    CHECK(jb.insert(packet(1000)) == Insert::TooEarlyReset);
    CHECK(jb.held() == 1);
}

TEST_CASE("Sequence numbers wrap at 2^32 without disturbing playout", "[media][jitter]") {
    JitterBuffer jb(3, 20);
    JbPacket out;
    const std::uint32_t start = 0xFFFFFFFEu;
    for (std::uint32_t i = 0; i < 3; ++i) {
        jb.insert(packet(start + i));
    }
    std::vector<std::uint32_t> played;
    for (std::uint32_t i = 3; i < 8; ++i) {
        jb.insert(packet(start + i));
        REQUIRE(jb.pull(out) == Pull::Packet);
        played.push_back(out.seq);
    }
    CHECK(played == std::vector<std::uint32_t>{0xFFFFFFFEu, 0xFFFFFFFFu, 0u, 1u, 2u});
    CHECK(jb.insert(packet(0xFFFFFFFFu)) == Insert::Late);
}

TEST_CASE("A buffer that stays above target+2 skips one frame per drift period", "[media][jitter]") {
    JitterBuffer jb(2, 20, 10);
    JbPacket out;
    std::uint32_t next = 0;
    for (; next < 6; ++next) {
        jb.insert(packet(next));
    }
    // Keep 5-6 packets held (target 2 + 2 = 4 is exceeded) for 10 pulls.
    for (int i = 0; i < 10; ++i) {
        jb.insert(packet(next++));
        jb.pull(out);
    }
    CHECK(jb.stats().drift_skips == 1);
    CHECK(jb.stats().lost == 0);  // the skipped frame was present: dropped, not concealed
}

TEST_CASE("A new target applies at the next fill, not mid-stream", "[media][jitter]") {
    JitterBuffer jb(2, 2);
    JbPacket out;
    jb.insert(packet(0));
    jb.insert(packet(1));
    REQUIRE(jb.playing());
    jb.set_target(5);
    CHECK(jb.target() == 2);
    jb.pull(out);
    jb.pull(out);
    jb.pull(out);
    jb.pull(out);  // two underruns -> refill
    REQUIRE_FALSE(jb.playing());
    CHECK(jb.target() == 5);
    for (std::uint32_t s = 10; s < 14; ++s) {
        jb.insert(packet(s));
    }
    CHECK_FALSE(jb.playing());
    jb.insert(packet(14));
    CHECK(jb.playing());
    jb.set_target(0);
    jb.reset();
    CHECK(jb.target() == 1);  // clamped
}

TEST_CASE("An excessive backlog (playback stall) is cut back to the target at once", "[media][jitter]") {
    JitterBuffer jb(3, 20);
    JbPacket out;
    std::uint32_t next = 0;
    for (; next < 3; ++next) {
        jb.insert(packet(next));
    }
    REQUIRE(jb.playing());
    // Playback stalls for 300 ms at 10 ms frames: 30 packets pile up.
    for (int i = 0; i < 30; ++i) {
        jb.insert(packet(next++));
    }
    CHECK(jb.held() == 33);
    REQUIRE(jb.pull(out) == Pull::Packet);
    CHECK(jb.held() == 2);                     // target 3, then one was played
    CHECK(jb.stats().catchup_frames == 30);
    CHECK(out.seq == 30);                      // the newest audio is played, not 300 ms old audio
    CHECK(jb.stats().lost == 0);
    // Up to target + 8 is tolerated (bursty arrival is normal).
    for (int i = 0; i < 9; ++i) {
        jb.insert(packet(next++));
    }
    jb.pull(out);
    CHECK(jb.stats().catchup_frames == 30);
}

TEST_CASE("A sender pause (sequence stops, playout continues) resyncs after 3 late arrivals", "[media][jitter]") {
    JitterBuffer jb(2, 20);
    JbPacket out;
    jb.insert(packet(0));
    jb.insert(packet(1));
    jb.pull(out);
    jb.pull(out);
    for (int i = 0; i < 6; ++i) {
        CHECK(jb.pull(out) == Pull::Underrun);  // the sender paused for 60 ms
    }
    // It resumes with seq 2, 3, 4 ... (it never sent 2..7 before): all behind next_seq.
    CHECK(jb.insert(packet(2)) == Insert::Late);
    CHECK(jb.insert(packet(3)) == Insert::Late);
    CHECK(jb.insert(packet(4)) == Insert::Late);  // third in a row: resync, 4 is kept
    CHECK(jb.stats().resyncs == 1);
    CHECK_FALSE(jb.playing());
    jb.insert(packet(5));
    REQUIRE(jb.playing());
    REQUIRE(jb.pull(out) == Pull::Packet);
    CHECK(out.seq == 4);
    CHECK(jb.stats().underruns == 6);  // not 20: no wait for the stall limit
}

TEST_CASE("Isolated late packets (reordering) do not resync", "[media][jitter]") {
    JitterBuffer jb(2, 20);
    JbPacket out;
    for (std::uint32_t s = 0; s < 4; ++s) {
        jb.insert(packet(s));
    }
    jb.pull(out);
    jb.pull(out);
    CHECK(jb.insert(packet(0)) == Insert::Late);
    CHECK(jb.insert(packet(4)) == Insert::Accepted);
    CHECK(jb.insert(packet(1)) == Insert::Late);
    CHECK(jb.insert(packet(5)) == Insert::Accepted);
    CHECK(jb.stats().resyncs == 0);
    CHECK(jb.playing());
}
