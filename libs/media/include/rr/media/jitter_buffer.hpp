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
//      missing, nothing held         -> Underrun (conceal; counted); after `stall_limit`
//                                       consecutive underruns -> back to Filling (rebuffer)
//    Drift: if more than target+2 packets stay held for `drift_pulls` consecutive pulls (the
//    sender's capture clock runs faster than this playback clock), one frame is skipped (counted).
//    Catch-up (Stage 8): if more than target + max(8, target) packets are held (a backlog after a
//    playback stall or a burst after a network stall), the oldest are dropped at once down to the
//    target (counted in catchup_frames), so live delay never stays inflated for long.
// Arrivals: seq < next_seq -> Late (dropped); already held -> Duplicate (dropped);
//           seq >= next_seq + kSlots -> TooEarly: reset to Filling with this packet.
//           Resync (Stage 8): kResyncLate consecutive Late arrivals mean the SENDER paused
//           (its sequence numbers stopped while playout kept advancing, e.g. its input device
//           was re-opened): refill from the arriving packet instead of dropping everything until
//           the stall limit (found by run D5: a 60 ms sender pause cost 20 underruns + 18 late).
// Sequence numbers are compared with serial arithmetic int32(a - b), so 2^32 wrap is harmless.

#include <array>
#include <cstdint>

namespace rr::media {

constexpr std::size_t kMaxOpusPacketBytes = 1276;  // TOC + 1275 (RFC 6716 §3.2.1)

// One received packet, trivially copyable (it travels through an SPSC ring).
struct JbPacket {
    enum Kind : std::uint8_t { Audio = 0, StreamReset = 1 };
    std::uint32_t seq = 0;
    std::uint16_t len = 0;
    std::uint8_t kind = Audio;
    std::uint8_t pad = 0;
    std::uint64_t media_index = 0;
    std::int64_t arrival_ns = 0;
    std::uint8_t data[kMaxOpusPacketBytes] = {};
};

struct JitterStats {
    std::uint64_t accepted = 0;
    std::uint64_t late = 0;
    std::uint64_t duplicates = 0;
    std::uint64_t too_early_resets = 0;
    std::uint64_t played = 0;        // Packet pulls
    std::uint64_t lost = 0;          // Lost pulls (concealed)
    std::uint64_t underruns = 0;     // Underrun pulls (concealed)
    std::uint64_t rebuffers = 0;     // Playing -> Filling after the stall limit
    std::uint64_t drift_skips = 0;
    std::uint64_t catchup_frames = 0; // frames dropped to bring an excessive backlog back to the target
    std::uint64_t resyncs = 0;        // refills after kResyncLate consecutive late arrivals
    std::uint64_t resets = 0;        // explicit reset() (end of stream, new stream)
};

class JitterBuffer {
public:
    static constexpr std::uint32_t kSlots = 64;
    static constexpr std::uint32_t kResyncLate = 3;

    enum class Insert { Accepted, Late, Duplicate, TooEarlyReset };
    enum class Pull { Packet, Lost, Underrun, Filling };

    JitterBuffer(std::uint32_t target_frames = 3, std::uint32_t stall_limit = 20, std::uint32_t drift_pulls = 100);

    // Takes effect at the next refill (a running stream is not disturbed). Clamped to 1..kSlots/2.
    void set_target(std::uint32_t frames) noexcept;
    void set_drift_pulls(std::uint32_t pulls) noexcept { drift_pulls_ = pulls == 0 ? 1 : pulls; }
    Insert insert(const JbPacket& packet) noexcept;
    // One frame period. On Packet, `out` receives the packet.
    Pull pull(JbPacket& out) noexcept;
    void reset() noexcept;  // drop everything, back to Filling (counted in resets)

    bool playing() const noexcept { return playing_; }
    std::uint32_t held() const noexcept { return held_; }
    std::uint32_t target() const noexcept { return target_; }
    const JitterStats& stats() const noexcept { return stats_; }

private:
    static std::int32_t diff(std::uint32_t a, std::uint32_t b) noexcept { return static_cast<std::int32_t>(a - b); }
    void clear() noexcept;
    void store(const JbPacket& p) noexcept;
    bool lowest_held(std::uint32_t& seq) const noexcept;

    struct Slot {
        bool used = false;
        JbPacket packet;
    };
    std::array<Slot, kSlots> slots_{};
    std::uint32_t target_;
    std::uint32_t pending_target_;
    std::uint32_t stall_limit_;
    std::uint32_t drift_pulls_;
    bool playing_ = false;
    std::uint32_t next_seq_ = 0;
    std::uint32_t held_ = 0;
    std::uint32_t consecutive_underruns_ = 0;
    std::uint32_t consecutive_late_ = 0;
    std::uint32_t over_target_pulls_ = 0;
    JitterStats stats_;
};

}  // namespace rr::media
