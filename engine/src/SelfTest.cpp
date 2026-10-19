#include "SelfTest.h"
#include "AudioEngine.h"
#include "Sequencer.h"
#include <juce_events/juce_events.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <vector>

namespace
{
struct Recorded
{
    bool on;
    int slot;
    int64_t sample; // absolute
    int pitch;
};

struct Recorder : SequencerSink
{
    int64_t blockBase = 0;
    std::vector<Recorded> events;
    void noteOn(int slot, int, int o, int p, int) override { events.push_back({ true, slot, blockBase + o, p }); }
    void noteOff(int slot, int o, int p) override { events.push_back({ false, slot, blockBase + o, p }); }
};

struct Case
{
    double bpm;
    double sr;
    int block;
};

int64_t expectedSample(double tick, const Case& c, int ppq)
{
    return static_cast<int64_t>(std::ceil(tick * 60.0 * c.sr / (c.bpm * ppq) - 1e-9));
}

TrackModel makeTrack(int slot, int instrument, float gain, float pan, const std::vector<int64_t>& starts, int firstPitch, int64_t loop, int64_t dur = 240)
{
    TrackModel t;
    t.slot = slot;
    t.instrument = instrument;
    t.gain = gain;
    t.pan = pan;
    int pitch = firstPitch;
    for (auto s : starts)
    {
        NoteEvent e;
        e.startTick = s;
        e.endTick = std::min<int64_t>(s + dur, loop);
        e.pitch = pitch++;
        e.velocity = 100;
        t.notes.push_back(e);
    }
    return t;
}

int failures = 0;
void expect(bool ok, const char* what)
{
    if (!ok)
    {
        ++failures;
        std::fprintf(stderr, "FAIL: %s\n", what);
    }
}

struct Energy
{
    double l = 0, r = 0;
    float peak[kMaxSlots] = {};
    float masterPeak = 0;
};

/** Renders `blocks` blocks offline through the real AudioEngine render path. */
Energy renderOffline(const PlaybackModel& model, double bpm, int blocks, int block = 256, double sr = 48000.0)
{
    AudioEngine eng;
    eng.prepare(sr, block);
    eng.sequencer.setModel(&model);
    eng.sequencer.setBpm(bpm);
    eng.sequencer.setPlaying(true);
    std::vector<float> l(static_cast<size_t>(block)), r(static_cast<size_t>(block));
    float* out[2] = { l.data(), r.data() };
    Energy e;
    for (int b = 0; b < blocks; ++b)
    {
        eng.process(out, 2, block);
        for (int i = 0; i < block; ++i)
        {
            e.l += static_cast<double>(l[static_cast<size_t>(i)]) * l[static_cast<size_t>(i)];
            e.r += static_cast<double>(r[static_cast<size_t>(i)]) * r[static_cast<size_t>(i)];
        }
    }
    for (int s = 0; s < kMaxSlots; ++s) e.peak[s] = eng.slotPeak[s].load();
    e.masterPeak = std::max(eng.masterPeakL.load(), eng.masterPeakR.load());
    eng.sequencer.setModel(nullptr);
    return e;
}
} // namespace

int runSelfTest()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    const int ppq = 960;
    const int64_t loop = 4 * 4 * ppq;

    // ---- 1. Sequencer timing across tempos, sample rates and block sizes, two tracks ----
    PlaybackModel model;
    model.ppq = ppq;
    model.loopTicks = loop;
    const std::vector<int64_t> starts = { 0, 240, 480, 960, 1920, 2400, 3840, 7777, 11520, 15000 };
    model.tracks.push_back(makeTrack(0, kSynth, 0.6f, 0, starts, 48, loop));
    // Second track: same ticks, same pitches => must not interfere (active notes are per slot).
    model.tracks.push_back(makeTrack(3, kDrums, 0.6f, 0, starts, 48, loop));

    const Case cases[] = { { 60, 48000, 256 }, { 90, 48000, 480 }, { 120, 44100, 512 }, { 150, 48000, 333 }, { 200, 96000, 1024 }, { 60.5, 48000, 128 } };
    int checked = 0;
    int64_t worst = 0;

    for (const auto& c : cases)
    {
        Sequencer seq;
        seq.prepare(c.sr);
        seq.setModel(&model);
        seq.setBpm(c.bpm);
        seq.setPlaying(true);

        const double loopSamples = loop * 60.0 * c.sr / (c.bpm * ppq);
        const int passes = 3;
        const int64_t total = static_cast<int64_t>(loopSamples * passes) + c.block;

        Recorder rec;
        for (int64_t done = 0; done < total; done += c.block)
        {
            rec.blockBase = done;
            seq.process(c.block, rec);
        }

        for (const auto& tr : model.tracks)
        {
            for (int pass = 0; pass < passes; ++pass)
            {
                for (const auto& n : tr.notes)
                {
                    const double tick = pass * static_cast<double>(loop) + static_cast<double>(n.startTick);
                    const int64_t want = expectedSample(tick, c, ppq);
                    if (want >= total - c.block) continue;
                    ++checked;
                    bool found = false;
                    for (const auto& e : rec.events)
                    {
                        if (e.on && e.slot == tr.slot && e.pitch == n.pitch && std::llabs(e.sample - want) <= 1)
                        {
                            worst = std::max<int64_t>(worst, std::llabs(e.sample - want));
                            found = true;
                            break;
                        }
                    }
                    if (!found)
                    {
                        ++failures;
                        std::fprintf(stderr, "MISS bpm=%.1f sr=%.0f block=%d slot=%d pass=%d pitch=%d expected=%lld\n", c.bpm, c.sr, c.block, tr.slot, pass, n.pitch, static_cast<long long>(want));
                    }
                }
            }
        }

        int onCount = 0, offCount = 0;
        for (const auto& e : rec.events) (e.on ? onCount : offCount)++;
        expect(offCount >= onCount - static_cast<int>(2 * starts.size()), "no stuck notes");
    }

    // ---- 2. Tempo change mid-playback must not skip or double notes in a pass ----
    {
        Sequencer seq;
        seq.prepare(48000);
        seq.setModel(&model);
        seq.setBpm(120);
        seq.setPlaying(true);
        Recorder rec;
        const int block = 256;
        int64_t done = 0;
        for (int i = 0; i < 400; ++i, done += block)
        {
            if (i == 100) seq.setBpm(180);
            if (i == 200) seq.setBpm(90);
            rec.blockBase = done;
            seq.process(block, rec);
        }
        int ons[kMaxSlots][128] = {};
        for (const auto& e : rec.events)
            if (e.on) ++ons[e.slot][e.pitch];
        for (const auto& tr : model.tracks)
            for (const auto& n : tr.notes)
                expect(ons[tr.slot][n.pitch] <= 1, "tempo change: note played twice in one pass");
    }

    // ---- 3. Mixer through the real render path ----
    const std::vector<int64_t> one = { 0 };
    {
        // Pan hard left: right channel exactly silent, left audible.
        PlaybackModel m;
        m.ppq = ppq; m.loopTicks = loop; m.masterGain = 0.8f;
        m.tracks.push_back(makeTrack(0, kSynth, 0.8f, -1.0f, one, 60, loop, 3840));
        const Energy e = renderOffline(m, 120, 40);
        expect(e.l > 1e-4, "pan left: left channel has signal");
        expect(e.r < 1e-12, "pan left: right channel silent");
        expect(e.peak[0] > 0.01f, "meter: active slot reports a peak");
        expect(e.peak[1] == 0.0f, "meter: idle slot reports zero");
    }
    {
        // Pan hard right mirrors it.
        PlaybackModel m;
        m.ppq = ppq; m.loopTicks = loop; m.masterGain = 0.8f;
        m.tracks.push_back(makeTrack(0, kSynth, 0.8f, 1.0f, one, 60, loop, 3840));
        const Energy e = renderOffline(m, 120, 40);
        expect(e.r > 1e-4 && e.l < 1e-12, "pan right: only right channel");
    }
    {
        // Centre pan is equal in both channels.
        PlaybackModel m;
        m.ppq = ppq; m.loopTicks = loop; m.masterGain = 0.8f;
        m.tracks.push_back(makeTrack(0, kSynth, 0.8f, 0.0f, one, 60, loop, 3840));
        const Energy e = renderOffline(m, 120, 40);
        expect(std::fabs(e.l - e.r) < 1e-9 * (1.0 + e.l), "centre pan: L == R");
    }
    {
        // Muted track (gain 0 after host resolves mute/solo): silence, but its notes still advance.
        PlaybackModel m;
        m.ppq = ppq; m.loopTicks = loop; m.masterGain = 0.8f;
        m.tracks.push_back(makeTrack(0, kSynth, 0.0f, 0.0f, one, 60, loop, 3840));
        const Energy e = renderOffline(m, 120, 40);
        expect(e.l + e.r < 1e-12, "gain 0: silent");
    }
    {
        // Master gain 0 silences everything.
        PlaybackModel m;
        m.ppq = ppq; m.loopTicks = loop; m.masterGain = 0.0f;
        m.tracks.push_back(makeTrack(0, kSynth, 0.8f, 0.0f, one, 60, loop, 3840));
        const Energy e = renderOffline(m, 120, 40);
        expect(e.l + e.r < 1e-9, "master 0: silent");
    }
    {
        // Drum kit: every GM drum pitch we map makes sound; kick is audible.
        for (int pitch : { 36, 38, 39, 42, 46, 41, 50 })
        {
            PlaybackModel m;
            m.ppq = ppq; m.loopTicks = loop; m.masterGain = 0.8f;
            m.tracks.push_back(makeTrack(2, kDrums, 0.8f, 0.0f, one, pitch, loop, 480));
            const Energy e = renderOffline(m, 120, 60);
            if (e.l < 1e-6)
            {
                std::fprintf(stderr, "drum pitch %d silent\n", pitch);
                ++failures;
            }
            expect(e.peak[2] > 0.001f, "drum meter reports on its slot");
        }
    }
    {
        // Two tracks: loudness adds, and each meter reflects its own slot.
        PlaybackModel m;
        m.ppq = ppq; m.loopTicks = loop; m.masterGain = 0.8f;
        m.tracks.push_back(makeTrack(0, kSynth, 0.8f, 0.0f, one, 60, loop, 3840));
        m.tracks.push_back(makeTrack(5, kDrums, 0.8f, 0.0f, one, 36, loop, 480));
        const Energy e = renderOffline(m, 120, 40);
        expect(e.peak[0] > 0.01f && e.peak[5] > 0.01f && e.peak[1] == 0.0f, "per-slot meters are independent");
    }

    std::printf("{\"t\":\"selftest\",\"pass\":%s,\"checked\":%d,\"failures\":%d,\"worstSampleError\":%lld}\n", failures == 0 ? "true" : "false",
                checked, failures, static_cast<long long>(worst));
    std::fflush(stdout);
    return failures == 0 ? 0 : 1;
}

int runBenchmark()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    const int ppq = 960;
    const int64_t loop = 4 * 4 * ppq;
    const double sr = 48000.0;

    // Heavy project: 8 tracks (6 synth, 2 drums), 16th-note density, long notes => many simultaneous voices.
    PlaybackModel m;
    m.ppq = ppq; m.loopTicks = loop; m.masterGain = 0.8f;
    std::vector<int64_t> starts;
    for (int i = 0; i < 64; ++i) starts.push_back(i * 240);
    for (int s = 0; s < 8; ++s)
        m.tracks.push_back(makeTrack(s, s < 6 ? kSynth : kDrums, 0.7f, (s - 3.5f) / 4.0f, starts, 36 + s * 3, loop, s < 6 ? 960 : 120));

    std::printf("{\"t\":\"benchmark\",\"sampleRate\":48000,\"tracks\":8,\"results\":[\n");
    const int blockSizes[] = { 64, 128, 256, 512, 1024 };
    bool first = true;
    for (int block : blockSizes)
    {
        AudioEngine eng;
        eng.prepare(sr, block);
        eng.sequencer.setModel(&m);
        eng.sequencer.setBpm(140);
        eng.sequencer.setPlaying(true);
        std::vector<float> l(static_cast<size_t>(block)), r(static_cast<size_t>(block));
        float* out[2] = { l.data(), r.data() };

        const int blocks = static_cast<int>(sr * 20.0 / block); // 20 seconds of audio
        std::vector<double> loads;
        loads.reserve(static_cast<size_t>(blocks));
        const double budget = block / sr;
        for (int b = 0; b < blocks; ++b)
        {
            const auto t0 = std::chrono::steady_clock::now();
            eng.process(out, 2, block);
            const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
            loads.push_back(dt / budget);
        }
        std::sort(loads.begin(), loads.end());
        double sum = 0;
        for (double v : loads) sum += v;
        const double avg = sum / static_cast<double>(loads.size());
        const double p99 = loads[static_cast<size_t>(static_cast<double>(loads.size()) * 0.99)];
        const double mx = loads.back();
        int over = 0;
        for (double v : loads) if (v > 1.0) ++over;
        std::printf("%s  {\"block\":%d,\"budgetMs\":%.3f,\"avgLoadPct\":%.2f,\"p99LoadPct\":%.2f,\"maxLoadPct\":%.2f,\"overBudget\":%d,\"blocks\":%d}",
                    first ? "" : ",\n", block, budget * 1000.0, avg * 100.0, p99 * 100.0, mx * 100.0, over, static_cast<int>(loads.size()));
        first = false;
        eng.sequencer.setModel(nullptr);
    }
    std::printf("\n]}\n");
    std::fflush(stdout);
    return 0;
}
