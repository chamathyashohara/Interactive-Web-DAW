#include "rr/media/jitter_buffer.hpp"

namespace rr::media {
namespace {

std::uint32_t clamp_target(std::uint32_t frames) noexcept {
    if (frames < 1) {
        return 1;
    }
    return frames > JitterBuffer::kSlots / 2 ? JitterBuffer::kSlots / 2 : frames;
}

}  // namespace

JitterBuffer::JitterBuffer(std::uint32_t target_frames, std::uint32_t stall_limit, std::uint32_t drift_pulls)
    : target_(clamp_target(target_frames)),
      pending_target_(target_),
      stall_limit_(stall_limit == 0 ? 1 : stall_limit),
      drift_pulls_(drift_pulls == 0 ? 1 : drift_pulls) {}

void JitterBuffer::set_target(std::uint32_t frames) noexcept {
    pending_target_ = clamp_target(frames);
    if (!playing_) {
        target_ = pending_target_;
    }
}

void JitterBuffer::clear() noexcept {
    for (Slot& s : slots_) {
        s.used = false;
    }
    held_ = 0;
    playing_ = false;
    consecutive_underruns_ = 0;
    over_target_pulls_ = 0;
    target_ = pending_target_;
}

void JitterBuffer::reset() noexcept {
    clear();
    ++stats_.resets;
}

void JitterBuffer::store(const JbPacket& p) noexcept {
    Slot& s = slots_[p.seq % kSlots];
    s.used = true;
    s.packet = p;
    ++held_;
    ++stats_.accepted;
}

bool JitterBuffer::lowest_held(std::uint32_t& seq) const noexcept {
    bool found = false;
    for (const Slot& s : slots_) {
        if (s.used && (!found || diff(s.packet.seq, seq) < 0)) {
            seq = s.packet.seq;
            found = true;
        }
    }
    return found;
}

JitterBuffer::Insert JitterBuffer::insert(const JbPacket& p) noexcept {
    Slot& slot = slots_[p.seq % kSlots];
    if (playing_) {
        const std::int32_t d = diff(p.seq, next_seq_);
        if (d < 0) {
            ++stats_.late;
            return Insert::Late;
        }
        if (d >= static_cast<std::int32_t>(kSlots)) {
            clear();
            ++stats_.too_early_resets;
            store(p);
            return Insert::TooEarlyReset;
        }
        if (slot.used && slot.packet.seq == p.seq) {
            ++stats_.duplicates;
            return Insert::Duplicate;
        }
        // Any other occupant of this slot is older than next_seq_ (cannot happen: slots are
        // cleared as they are played or skipped), so overwriting is safe.
        if (slot.used) {
            --held_;
        }
        store(p);
        return Insert::Accepted;
    }

    // Filling.
    if (slot.used && slot.packet.seq == p.seq) {
        ++stats_.duplicates;
        return Insert::Duplicate;
    }
    std::uint32_t low = 0;
    if (lowest_held(low)) {
        // Keep the held span inside the window; a packet far outside it starts a new fill.
        std::uint32_t high = low;
        for (const Slot& s : slots_) {
            if (s.used && diff(s.packet.seq, high) > 0) {
                high = s.packet.seq;
            }
        }
        const std::uint32_t new_low = diff(p.seq, low) < 0 ? p.seq : low;
        const std::uint32_t new_high = diff(p.seq, high) > 0 ? p.seq : high;
        if (diff(new_high, new_low) >= static_cast<std::int32_t>(kSlots)) {
            clear();
            ++stats_.too_early_resets;
            store(p);
            return Insert::TooEarlyReset;
        }
    }
    if (slot.used) {
        --held_;
    }
    store(p);
    if (held_ >= target_) {
        lowest_held(next_seq_);
        playing_ = true;
        consecutive_underruns_ = 0;
        over_target_pulls_ = 0;
    }
    return Insert::Accepted;
}

JitterBuffer::Pull JitterBuffer::pull(JbPacket& out) noexcept {
    if (!playing_) {
        return Pull::Filling;
    }
    // Drift: persistently more buffered than the target -> drop the oldest frame once.
    if (held_ > target_ + 2) {
        if (++over_target_pulls_ >= drift_pulls_) {
            over_target_pulls_ = 0;
            Slot& skip = slots_[next_seq_ % kSlots];
            if (skip.used && skip.packet.seq == next_seq_) {
                skip.used = false;
                --held_;
            }
            ++next_seq_;
            ++stats_.drift_skips;
        }
    } else {
        over_target_pulls_ = 0;
    }

    Slot& slot = slots_[next_seq_ % kSlots];
    ++next_seq_;
    if (slot.used && slot.packet.seq == next_seq_ - 1) {
        out = slot.packet;
        slot.used = false;
        --held_;
        consecutive_underruns_ = 0;
        ++stats_.played;
        return Pull::Packet;
    }
    if (held_ > 0) {
        consecutive_underruns_ = 0;
        ++stats_.lost;
        return Pull::Lost;
    }
    ++stats_.underruns;
    if (++consecutive_underruns_ >= stall_limit_) {
        clear();
        ++stats_.rebuffers;
    }
    return Pull::Underrun;
}

}  // namespace rr::media
