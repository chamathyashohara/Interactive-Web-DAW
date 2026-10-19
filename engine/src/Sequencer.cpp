#include "Sequencer.h"
#include <algorithm>
#include <cmath>

void Sequencer::releaseAll(int offset, SequencerSink& sink)
{
    for (int s = 0; s < kMaxSlots; ++s)
    {
        if (activeCount[s] == 0)
            continue;
        for (int p = 0; p < 128; ++p)
        {
            if (active[s][p].on)
            {
                sink.noteOff(s, offset, p);
                active[s][p].on = false;
            }
        }
        activeCount[s] = 0;
    }
}

void Sequencer::process(int numSamples, SequencerSink& sink)
{
    const PlaybackModel* m = model.load(std::memory_order_acquire);
    const bool play = playing.load(std::memory_order_acquire);

    const double seek = seekTick.exchange(-1.0, std::memory_order_acq_rel);
    if (seek >= 0.0)
    {
        releaseAll(0, sink);
        pos = seek;
        justWrapped = false;
    }

    if (m == nullptr || m->loopTicks <= 0)
    {
        posMirror.store(pos, std::memory_order_relaxed);
        return;
    }

    if (!play)
    {
        if (wasPlaying)
            releaseAll(0, sink);
        wasPlaying = false;
        posMirror.store(pos, std::memory_order_relaxed);
        return;
    }
    wasPlaying = true;

    const double loop = static_cast<double>(m->loopTicks);
    int done = 0;

    while (done < numSamples)
    {
        const double tps = bpm.load(std::memory_order_acquire) * m->ppq / (60.0 * sr); // ticks per sample
        if (tps <= 0.0)
            break;

        while (pos >= loop)
            pos -= loop;

        auto samplesToEnd = static_cast<int64_t>(std::ceil((loop - pos) / tps));
        if (samplesToEnd < 1)
            samplesToEnd = 1;
        const int n = static_cast<int>(std::min<int64_t>(numSamples - done, samplesToEnd));

        const double blockStart = pos;
        const double blockEnd = pos + n * tps;
        const double eventFrom = justWrapped ? 0.0 : blockStart; // include ticks the overshoot skipped over
        justWrapped = false;

        auto offsetFor = [&](double tick) {
            const double rel = std::ceil((tick - blockStart) / tps);
            const int o = rel < 0.0 ? 0 : (rel > n - 1 ? n - 1 : static_cast<int>(rel));
            return done + o;
        };

        // Note-offs due inside this segment.
        for (int s = 0; s < kMaxSlots; ++s)
        {
            if (activeCount[s] == 0)
                continue;
            for (int p = 0; p < 128; ++p)
            {
                Active& a = active[s][p];
                if (a.on && a.endTick < blockEnd && a.endTick < loop)
                {
                    sink.noteOff(s, offsetFor(a.endTick), p);
                    a.on = false;
                    --activeCount[s];
                }
            }
        }

        // Note-ons whose start falls in [eventFrom, min(blockEnd, loop)).
        const double eventTo = std::min(blockEnd, loop);
        for (const TrackModel& tr : m->tracks)
        {
            const int slot = std::clamp(tr.slot, 0, kMaxSlots - 1);
            auto it = std::lower_bound(tr.notes.begin(), tr.notes.end(), eventFrom,
                                       [](const NoteEvent& e, double t) { return static_cast<double>(e.startTick) < t; });
            for (; it != tr.notes.end() && static_cast<double>(it->startTick) < eventTo; ++it)
            {
                const int off = offsetFor(static_cast<double>(it->startTick));
                Active& a = active[slot][it->pitch];
                if (a.on)
                {
                    sink.noteOff(slot, off, it->pitch); // retrigger
                    --activeCount[slot];
                }
                sink.noteOn(slot, tr.instrument, off, it->pitch, it->velocity);
                a.on = true;
                a.endTick = static_cast<double>(it->endTick);
                ++activeCount[slot];
            }
        }

        pos = blockEnd;
        done += n;

        if (pos >= loop)
        {
            // All notes end at or before the loop boundary (the model clips them).
            releaseAll(std::min(done, numSamples - 1), sink);
            pos -= loop;
            justWrapped = true;
        }
    }

    posMirror.store(pos, std::memory_order_relaxed);
}
