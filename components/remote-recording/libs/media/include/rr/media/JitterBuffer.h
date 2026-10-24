#pragma once

// Fixed-depth jitter buffer (ADR-011, PROTOCOL_OVERVIEW §3.3; as built: ADR-017).
//
// Single-threaded: owned by whoever plays the stream (the playback callback in the apps, the
// test directly). All storage is a fixed array of kSlots packets; nothing allocates.
//
// States:
//  - Filling: collect packets until `target` are held, then play from the lowest sequence number.
//  - Playing: one pull() per frame period:
//      slot next_seq present         -> Packet (decode)
//      missing, later packets held   -> Lost (conceal; counted)
//      missing, nothing held         -> Underrun (conceal; counted); after `stallLimit`
//                                       consecutive underruns -> back to Filling (rebuffer)
//    Drift: if more than target+2 packets stay held for `driftPulls` consecutive pulls (the
//    sender's capture clock runs faster than this playback clock), one frame is skipped (counted).
//    Catch-up (Stage 8): if more than target + max(8, target) packets are held (a backlog after a
//    playback stall or a burst after a network stall), the oldest are dropped at once down to the
//    target (counted in catchupFrames), so live delay never stays inflated for long.
// Arrivals: seq < next_seq -> Late (dropped); already held -> Duplicate (dropped);
//           seq >= next_seq + kSlots -> TooEarly: reset to Filling with this packet.
//           Resync (Stage 8): kResyncLate consecutive Late arrivals mean the SENDER paused
//           (its sequence numbers stopped while playout kept advancing, e.g. its input device
//           was re-opened): refill from the arriving packet instead of dropping everything until
//           the stall limit (found by run D5: a 60 ms sender pause cost 20 underruns + 18 late).
// Sequence numbers are compared with serial arithmetic int32(a - b), so 2^32 wrap is harmless.

#include <array>
#include <cstdint>

constexpr size_t kMaxOpusPacketBytes = 1276;  // TOC + 1275 (RFC 6716 §3.2.1)

/** One received packet, trivially copyable (it travels through an SPSC ring). */
struct JbPacket
{
    enum Kind : uint8_t { Audio = 0, StreamReset = 1 };
    uint32_t seq = 0;
    uint16_t len = 0;
    uint8_t kind = Audio;
    uint8_t pad = 0;
    uint64_t mediaIndex = 0;
    int64_t arrivalNs = 0;
    uint8_t data[kMaxOpusPacketBytes] = {};
};

struct JitterStats
{
    uint64_t accepted = 0;
    uint64_t late = 0;
    uint64_t duplicates = 0;
    uint64_t tooEarlyResets = 0;
    uint64_t played = 0;        // Packet pulls
    uint64_t lost = 0;          // Lost pulls (concealed)
    uint64_t underruns = 0;     // Underrun pulls (concealed)
    uint64_t rebuffers = 0;     // Playing -> Filling after the stall limit
    uint64_t driftSkips = 0;
    uint64_t catchupFrames = 0; // frames dropped to bring an excessive backlog back to the target
    uint64_t resyncs = 0;        // refills after kResyncLate consecutive late arrivals
    uint64_t resets = 0;        // explicit reset() (end of stream, new stream)
};

class JitterBuffer
{
public:
    static constexpr uint32_t kSlots = 64;
    static constexpr uint32_t kResyncLate = 3;

    enum class Insert { Accepted, Late, Duplicate, TooEarlyReset };
    enum class Pull { Packet, Lost, Underrun, Filling };

    JitterBuffer(uint32_t targetFrames = 3, uint32_t stallLimit = 20, uint32_t driftPulls = 100);

    /** Takes effect at the next refill (a running stream is not disturbed). Clamped to 1..kSlots/2. */
    void setTarget(uint32_t frames) noexcept;
    void setDriftPulls(uint32_t pulls) noexcept { driftPulls = pulls == 0 ? 1 : pulls; }
    Insert insert(const JbPacket& packet) noexcept;
    /** One frame period. On Packet, `out` receives the packet. */
    Pull pull(JbPacket& out) noexcept;
    void reset() noexcept;  // drop everything, back to Filling (counted in resets)

    bool isPlaying() const noexcept { return playing; }
    uint32_t getHeld() const noexcept { return held; }
    uint32_t getTarget() const noexcept { return target; }
    const JitterStats& getStats() const noexcept { return stats; }

private:
    static int32_t diff(uint32_t a, uint32_t b) noexcept { return static_cast<int32_t>(a - b); }
    void clear() noexcept;
    void store(const JbPacket& p) noexcept;
    bool lowestHeld(uint32_t& seq) const noexcept;

    struct Slot
    {
        bool used = false;
        JbPacket packet;
    };
    std::array<Slot, kSlots> slotRing{};
    uint32_t target;
    uint32_t pendingTarget;
    uint32_t stallLimit;
    uint32_t driftPulls;
    bool playing = false;
    uint32_t nextSeq = 0;
    uint32_t held = 0;
    uint32_t consecutiveUnderruns = 0;
    uint32_t consecutiveLate = 0;
    uint32_t overTargetPulls = 0;
    JitterStats stats;
};

