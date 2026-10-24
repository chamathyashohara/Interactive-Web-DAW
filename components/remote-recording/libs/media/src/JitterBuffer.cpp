#include "rr/media/JitterBuffer.h"

namespace
{

uint32_t clampTarget(uint32_t frames) noexcept
{
    if (frames < 1)
    {
        return 1;
    }
    return frames > JitterBuffer::kSlots / 2 ? JitterBuffer::kSlots / 2 : frames;
}

}  // namespace

JitterBuffer::JitterBuffer(uint32_t targetFrames, uint32_t stallLimit, uint32_t driftPulls)
    : target(clampTarget(targetFrames)),
      pendingTarget(target),
      stallLimit(stallLimit == 0 ? 1 : stallLimit),
      driftPulls(driftPulls == 0 ? 1 : driftPulls) {}

void JitterBuffer::setTarget(uint32_t frames) noexcept
{
    pendingTarget = clampTarget(frames);
    if (!playing)
    {
        target = pendingTarget;
    }
}

void JitterBuffer::clear() noexcept
{
    for (Slot& s : slotRing)
    {
        s.used = false;
    }
    held = 0;
    playing = false;
    consecutiveUnderruns = 0;
    consecutiveLate = 0;
    overTargetPulls = 0;
    target = pendingTarget;
}

void JitterBuffer::reset() noexcept
{
    clear();
    ++stats.resets;
}

void JitterBuffer::store(const JbPacket& p) noexcept
{
    Slot& s = slotRing[p.seq % kSlots];
    s.used = true;
    s.packet = p;
    ++held;
    ++stats.accepted;
}

bool JitterBuffer::lowestHeld(uint32_t& seq) const noexcept
{
    bool found = false;
    for (const Slot& s : slotRing)
    {
        if (s.used && (!found || diff(s.packet.seq, seq) < 0))
        {
            seq = s.packet.seq;
            found = true;
        }
    }
    return found;
}

JitterBuffer::Insert JitterBuffer::insert(const JbPacket& p) noexcept
{
    Slot& slot = slotRing[p.seq % kSlots];
    if (playing)
    {
        const int32_t d = diff(p.seq, nextSeq);
        if (d < 0)
        {
            ++stats.late;
            if (++consecutiveLate >= kResyncLate)
            {
                clear();
                ++stats.resyncs;
                store(p);
                if (held >= target)
                {
                    lowestHeld(nextSeq);
                    playing = true;
                }
            }
            return Insert::Late;
        }
        consecutiveLate = 0;
        if (d >= static_cast<int32_t>(kSlots))
        {
            clear();
            ++stats.tooEarlyResets;
            store(p);
            return Insert::TooEarlyReset;
        }
        if (slot.used && slot.packet.seq == p.seq)
        {
            ++stats.duplicates;
            return Insert::Duplicate;
        }
        // Any other occupant of this slot is older than nextSeq (cannot happen: slots are
        // cleared as they are played or skipped), so overwriting is safe.
        if (slot.used)
        {
            --held;
        }
        store(p);
        return Insert::Accepted;
    }

    // Filling.
    if (slot.used && slot.packet.seq == p.seq)
    {
        ++stats.duplicates;
        return Insert::Duplicate;
    }
    uint32_t low = 0;
    if (lowestHeld(low))
    {
        // Keep the held span inside the window; a packet far outside it starts a new fill.
        uint32_t high = low;
        for (const Slot& s : slotRing)
        {
            if (s.used && diff(s.packet.seq, high) > 0)
            {
                high = s.packet.seq;
            }
        }
        const uint32_t newLow = diff(p.seq, low) < 0 ? p.seq : low;
        const uint32_t newHigh = diff(p.seq, high) > 0 ? p.seq : high;
        if (diff(newHigh, newLow) >= static_cast<int32_t>(kSlots))
        {
            clear();
            ++stats.tooEarlyResets;
            store(p);
            return Insert::TooEarlyReset;
        }
    }
    if (slot.used)
    {
        --held;
    }
    store(p);
    if (held >= target)
    {
        lowestHeld(nextSeq);
        playing = true;
        consecutiveUnderruns = 0;
        overTargetPulls = 0;
    }
    return Insert::Accepted;
}

JitterBuffer::Pull JitterBuffer::pull(JbPacket& out) noexcept
{
    if (!playing)
    {
        return Pull::Filling;
    }
    // Catch-up: an excessive backlog is dropped down to the target at once.
    const uint32_t excessLimit = target + (target > 8 ? target : 8u);
    if (held > excessLimit)
    {
        while (held > target)
        {
            Slot& old = slotRing[nextSeq % kSlots];
            if (old.used && old.packet.seq == nextSeq)
            {
                old.used = false;
                --held;
                ++stats.catchupFrames;
            }
            ++nextSeq;
        }
        overTargetPulls = 0;
    }
    // Drift: persistently more buffered than the target -> drop the oldest frame once.
    if (held > target + 2)
    {
        if (++overTargetPulls >= driftPulls)
        {
            overTargetPulls = 0;
            Slot& skip = slotRing[nextSeq % kSlots];
            if (skip.used && skip.packet.seq == nextSeq)
            {
                skip.used = false;
                --held;
            }
            ++nextSeq;
            ++stats.driftSkips;
        }
    }
    else
    {
        overTargetPulls = 0;
    }

    Slot& slot = slotRing[nextSeq % kSlots];
    ++nextSeq;
    if (slot.used && slot.packet.seq == nextSeq - 1)
    {
        out = slot.packet;
        slot.used = false;
        --held;
        consecutiveUnderruns = 0;
        ++stats.played;
        return Pull::Packet;
    }
    if (held > 0)
    {
        consecutiveUnderruns = 0;
        ++stats.lost;
        return Pull::Lost;
    }
    ++stats.underruns;
    if (++consecutiveUnderruns >= stallLimit)
    {
        clear();
        ++stats.rebuffers;
    }
    return Pull::Underrun;
}

