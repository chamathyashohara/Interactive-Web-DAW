// Fixed-depth jitter buffer policy (ADR-011, ADR-017): filling, loss, reordering, duplicates,
// lateness, underrun/rebuffer, too-early reset, 2^32 wrap and drift skips.

#include <catch2/catch_test_macros.hpp>

#include <vector>

#include "rr/media/JitterBuffer.h"

using Pull = JitterBuffer::Pull;
using Insert = JitterBuffer::Insert;

namespace
{

JbPacket packet(uint32_t seq)
{
    JbPacket p;
    p.seq = seq;
    p.len = 1;
    p.data[0] = static_cast<uint8_t>(seq);
    return p;
}

}  // namespace

TEST_CASE("Jitter buffer fills to its target, then plays in sequence order", "[media][jitter]")
{
    JitterBuffer jb(3, 20);
    JbPacket out;
    CHECK(jb.pull(out) == Pull::Filling);
    CHECK(jb.insert(packet(10)) == Insert::Accepted);
    CHECK(jb.insert(packet(12)) == Insert::Accepted);
    CHECK(jb.pull(out) == Pull::Filling);
    CHECK_FALSE(jb.isPlaying());
    CHECK(jb.insert(packet(11)) == Insert::Accepted);  // reordered within the depth
    CHECK(jb.isPlaying());
    for (uint32_t s = 10; s <= 12; ++s)
    {
        REQUIRE(jb.pull(out) == Pull::Packet);
        CHECK(out.seq == s);
    }
    CHECK(jb.getStats().played == 3);
}

TEST_CASE("A missing packet with later ones held is Lost; with nothing held it is an Underrun", "[media][jitter]")
{
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
    CHECK(jb.isPlaying());
    CHECK(jb.pull(out) == Pull::Underrun);  // stall limit 3 reached
    CHECK_FALSE(jb.isPlaying());
    CHECK(jb.getStats().lost == 1);
    CHECK(jb.getStats().underruns == 3);
    CHECK(jb.getStats().rebuffers == 1);
    CHECK(jb.pull(out) == Pull::Filling);
}

TEST_CASE("Late and duplicate arrivals are dropped and counted", "[media][jitter]")
{
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
    CHECK(jb.getStats().late == 2);
    CHECK(jb.getStats().duplicates == 2);
}

TEST_CASE("A packet far ahead of the window resets the buffer to filling", "[media][jitter]")
{
    JitterBuffer jb(2, 20);
    JbPacket out;
    jb.insert(packet(0));
    jb.insert(packet(1));
    REQUIRE(jb.isPlaying());
    CHECK(jb.insert(packet(0 + JitterBuffer::kSlots)) == Insert::TooEarlyReset);
    CHECK_FALSE(jb.isPlaying());
    CHECK(jb.getHeld() == 1);
    CHECK(jb.getStats().tooEarlyResets == 1);
    // While filling, a packet that would stretch the held span past the window also restarts.
    CHECK(jb.insert(packet(1000)) == Insert::TooEarlyReset);
    CHECK(jb.getHeld() == 1);
}

TEST_CASE("Sequence numbers wrap at 2^32 without disturbing playout", "[media][jitter]")
{
    JitterBuffer jb(3, 20);
    JbPacket out;
    const uint32_t start = 0xFFFFFFFEu;
    for (uint32_t i = 0; i < 3; ++i)
    {
        jb.insert(packet(start + i));
    }
    std::vector<uint32_t> played;
    for (uint32_t i = 3; i < 8; ++i)
    {
        jb.insert(packet(start + i));
        REQUIRE(jb.pull(out) == Pull::Packet);
        played.push_back(out.seq);
    }
    CHECK(played == std::vector<uint32_t>{0xFFFFFFFEu, 0xFFFFFFFFu, 0u, 1u, 2u});
    CHECK(jb.insert(packet(0xFFFFFFFFu)) == Insert::Late);
}

TEST_CASE("A buffer that stays above target+2 skips one frame per drift period", "[media][jitter]")
{
    JitterBuffer jb(2, 20, 10);
    JbPacket out;
    uint32_t next = 0;
    for (; next < 6; ++next)
    {
        jb.insert(packet(next));
    }
    // Keep 5-6 packets held (target 2 + 2 = 4 is exceeded) for 10 pulls.
    for (int i = 0; i < 10; ++i)
    {
        jb.insert(packet(next++));
        jb.pull(out);
    }
    CHECK(jb.getStats().driftSkips == 1);
    CHECK(jb.getStats().lost == 0);  // the skipped frame was present: dropped, not concealed
}

TEST_CASE("A new target applies at the next fill, not mid-stream", "[media][jitter]")
{
    JitterBuffer jb(2, 2);
    JbPacket out;
    jb.insert(packet(0));
    jb.insert(packet(1));
    REQUIRE(jb.isPlaying());
    jb.setTarget(5);
    CHECK(jb.getTarget() == 2);
    jb.pull(out);
    jb.pull(out);
    jb.pull(out);
    jb.pull(out);  // two underruns -> refill
    REQUIRE_FALSE(jb.isPlaying());
    CHECK(jb.getTarget() == 5);
    for (uint32_t s = 10; s < 14; ++s)
    {
        jb.insert(packet(s));
    }
    CHECK_FALSE(jb.isPlaying());
    jb.insert(packet(14));
    CHECK(jb.isPlaying());
    jb.setTarget(0);
    jb.reset();
    CHECK(jb.getTarget() == 1);  // clamped
}

TEST_CASE("An excessive backlog (playback stall) is cut back to the target at once", "[media][jitter]")
{
    JitterBuffer jb(3, 20);
    JbPacket out;
    uint32_t next = 0;
    for (; next < 3; ++next)
    {
        jb.insert(packet(next));
    }
    REQUIRE(jb.isPlaying());
    // Playback stalls for 300 ms at 10 ms frames: 30 packets pile up.
    for (int i = 0; i < 30; ++i)
    {
        jb.insert(packet(next++));
    }
    CHECK(jb.getHeld() == 33);
    REQUIRE(jb.pull(out) == Pull::Packet);
    CHECK(jb.getHeld() == 2);                     // target 3, then one was played
    CHECK(jb.getStats().catchupFrames == 30);
    CHECK(out.seq == 30);                      // the newest audio is played, not 300 ms old audio
    CHECK(jb.getStats().lost == 0);
    // Up to target + 8 is tolerated (bursty arrival is normal).
    for (int i = 0; i < 9; ++i)
    {
        jb.insert(packet(next++));
    }
    jb.pull(out);
    CHECK(jb.getStats().catchupFrames == 30);
}

TEST_CASE("A sender pause (sequence stops, playout continues) resyncs after 3 late arrivals", "[media][jitter]")
{
    JitterBuffer jb(2, 20);
    JbPacket out;
    jb.insert(packet(0));
    jb.insert(packet(1));
    jb.pull(out);
    jb.pull(out);
    for (int i = 0; i < 6; ++i)
    {
        CHECK(jb.pull(out) == Pull::Underrun);  // the sender paused for 60 ms
    }
    // It resumes with seq 2, 3, 4 ... (it never sent 2..7 before): all behind next_seq.
    CHECK(jb.insert(packet(2)) == Insert::Late);
    CHECK(jb.insert(packet(3)) == Insert::Late);
    CHECK(jb.insert(packet(4)) == Insert::Late);  // third in a row: resync, 4 is kept
    CHECK(jb.getStats().resyncs == 1);
    CHECK_FALSE(jb.isPlaying());
    jb.insert(packet(5));
    REQUIRE(jb.isPlaying());
    REQUIRE(jb.pull(out) == Pull::Packet);
    CHECK(out.seq == 4);
    CHECK(jb.getStats().underruns == 6);  // not 20: no wait for the stall limit
}

TEST_CASE("Isolated late packets (reordering) do not resync", "[media][jitter]")
{
    JitterBuffer jb(2, 20);
    JbPacket out;
    for (uint32_t s = 0; s < 4; ++s)
    {
        jb.insert(packet(s));
    }
    jb.pull(out);
    jb.pull(out);
    CHECK(jb.insert(packet(0)) == Insert::Late);
    CHECK(jb.insert(packet(4)) == Insert::Accepted);
    CHECK(jb.insert(packet(1)) == Insert::Late);
    CHECK(jb.insert(packet(5)) == Insert::Accepted);
    CHECK(jb.getStats().resyncs == 0);
    CHECK(jb.isPlaying());
}
