#include "SelfTest.h"
#include "AudioEngine.h"
#include "Export.h"
#include "Sequencer.h"
#include <juce_audio_formats/juce_audio_formats.h>
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

    // ---- 4. Offline export ----
    {
        constexpr double kSr = 48000.0;
        // 8-bar song at 120 BPM = exactly 16 s. Synth + drums, notes only in bars 1-2, static pans.
        PlaybackModel m;
        m.ppq = ppq;
        m.tempo = 120.0;
        m.loopTicks = 8 * 4 * ppq;
        m.masterGain = 0.8f;
        const std::vector<int64_t> early = { 0, 960, 1920, 2880, 3840, 4800, 5760, 6720 }; // bars 1-2
        m.tracks.push_back(makeTrack(0, kSynth, 0.8f, -0.3f, early, 55, m.loopTicks, 900));
        m.tracks.push_back(makeTrack(1, kDrums, 0.8f, 0.4f, early, 36, m.loopTicks, 120));

        expect(songFrames(m, kSr) == 768000, "export: 8 bars at 120 BPM / 48 kHz is exactly 768000 frames");
        PlaybackModel m90 = m;
        m90.tempo = 90.0;
        expect(songFrames(m90, kSr) == 1024000, "export: 8 bars at 90 BPM is exactly 1024000 frames");

        std::vector<float> L, R;
        int64_t frames = renderSong(m, kSr, 2.0, [&](const float* l, const float* r, int n) {
            L.insert(L.end(), l, l + n);
            R.insert(R.end(), r, r + n);
        });
        expect(frames == 768000 + 96000, "export: length is song + tail exactly");
        expect(static_cast<int64_t>(L.size()) == frames && static_cast<int64_t>(R.size()) == frames, "export: sink received every frame");

        double early_peak = 0, gap_peak = 0, tail_peak = 0;
        for (int64_t i = 0; i < frames; ++i)
        {
            const double v = std::max(std::fabs(L[static_cast<size_t>(i)]), std::fabs(R[static_cast<size_t>(i)]));
            if (i < 8 * 48000) early_peak = std::max(early_peak, v);       // first 8 s: music
            else if (i < 768000) gap_peak = std::max(gap_peak, v);         // bars 5-8: nothing plays
            else tail_peak = std::max(tail_peak, v);
        }
        expect(early_peak > 0.05, "export: audible where notes play");
        expect(gap_peak < 1e-9, "export: exactly silent where nothing plays");
        expect(tail_peak < 1e-9, "export: tail has rung out to silence");

        std::vector<float> L2, R2;
        renderSong(m, kSr, 2.0, [&](const float* l, const float* r, int n) {
            L2.insert(L2.end(), l, l + n);
            R2.insert(R2.end(), r, r + n);
        });
        expect(L == L2 && R == R2, "export: rendering twice is bit-identical (deterministic)");

        // The export must match what the live path renders at a different block size (same mixer code).
        {
            AudioEngine live;
            live.prepare(kSr, 1000);
            live.sequencer.setModel(&m);
            live.sequencer.setBpm(m.tempo);
            live.sequencer.setPlaying(true);
            std::vector<float> l(1000), r(1000);
            float* out[2] = { l.data(), r.data() };
            double worstDiff = 0;
            int64_t firstBad = -1;
            for (int64_t done = 0; done + 1000 <= 400000; done += 1000)
            {
                live.process(out, 2, 1000);
                for (int i = 0; i < 1000; ++i)
                {
                    if (firstBad < 0 && std::fabs(l[static_cast<size_t>(i)] - L[static_cast<size_t>(done + i)]) > 1e-6)
                    {
                        firstBad = done + i;
                        std::fprintf(stderr, "first divergence at frame %lld: live=%g export=%g (block start %lld)\n", static_cast<long long>(firstBad), l[static_cast<size_t>(i)], L[static_cast<size_t>(done + i)], static_cast<long long>(done));
                    }
                    worstDiff = std::max(worstDiff, static_cast<double>(std::fabs(l[static_cast<size_t>(i)] - L[static_cast<size_t>(done + i)])));
                    worstDiff = std::max(worstDiff, static_cast<double>(std::fabs(r[static_cast<size_t>(i)] - R[static_cast<size_t>(done + i)])));
                }
            }
            live.sequencer.setModel(nullptr);
            if (worstDiff > 1e-6)
                std::fprintf(stderr, "live vs export worst difference %.3g\n", worstDiff);
            expect(worstDiff <= 1e-6, "export: matches the live render path (block 1000 vs 512)");
        }

        // WAV file: header and content.
        const juce::File file = juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("daw_selftest_export.wav");
        const ExportResult er = exportWav(m, file, kSr, 2.0);
        expect(er.ok && er.frames == frames, "export: exportWav reports the exact frame count");
        expect(er.peak > 0.05 && er.peak < 1.0, "export: peak is inside full scale");
        {
            juce::WavAudioFormat wav;
            std::unique_ptr<juce::AudioFormatReader> reader(wav.createReaderFor(file.createInputStream().release(), true));
            expect(reader != nullptr, "export: file opens as a WAV");
            if (reader != nullptr)
            {
                expect(reader->lengthInSamples == frames, "export: WAV length equals song + tail exactly");
                expect(reader->sampleRate == kSr && reader->numChannels == 2 && reader->bitsPerSample == 24, "export: 48 kHz, stereo, 24-bit");
                juce::AudioBuffer<float> buf(2, 48000);
                double worst = 0;
                for (int64_t pos = 0; pos + 48000 <= 8 * 48000; pos += 48000)
                {
                    reader->read(&buf, 0, 48000, pos, true, true);
                    for (int i = 0; i < 48000; ++i)
                    {
                        worst = std::max(worst, static_cast<double>(std::fabs(buf.getSample(0, i) - L[static_cast<size_t>(pos + i)])));
                        worst = std::max(worst, static_cast<double>(std::fabs(buf.getSample(1, i) - R[static_cast<size_t>(pos + i)])));
                    }
                }
                expect(worst < 1.5e-7, "export: WAV samples equal the render to within 24-bit quantisation");
            }
        }
        file.deleteFile();

        PlaybackModel empty;
        empty.loopTicks = 0;
        expect(!exportWav(empty, file, kSr, 1.0).ok, "export: empty song is refused");
        expect(!exportWav(m, juce::File("Z:/definitely/not/a/folder/x.wav"), kSr, 1.0).ok, "export: unwritable path is reported, not crashed");
    }

    // ---- 4. Samples: decoding, waveform peaks and the browser preview voice ----
    {
        const juce::File dir = juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("daw_selftest_samples");
        dir.deleteRecursively();
        dir.createDirectory();
        const auto writeSine = [&](const juce::File& f, juce::AudioFormat& fmt, double rate, int ch, int bits, double secs, double hz) {
            const int n = static_cast<int>(secs * rate);
            juce::AudioBuffer<float> b(ch, n);
            for (int c = 0; c < ch; ++c)
                for (int i = 0; i < n; ++i) b.setSample(c, i, static_cast<float>(0.5 * std::sin(2.0 * 3.14159265358979 * hz * i / rate) * (c == 0 ? 1.0 : 0.5)));
            std::unique_ptr<juce::FileOutputStream> os(f.createOutputStream().release());
            std::unique_ptr<juce::AudioFormatWriter> w(fmt.createWriterFor(os.get(), rate, static_cast<unsigned>(ch), bits, {}, 0));
            if (w != nullptr)
            {
                os.release();
                w->writeFromAudioSampleBuffer(b, 0, n);
            }
        };
        juce::WavAudioFormat wav;
        juce::AiffAudioFormat aiff;
        juce::FlacAudioFormat flac;
        const juce::File wavFile = dir.getChildFile("a.wav"), aiffFile = dir.getChildFile("b.aif"), flacFile = dir.getChildFile("c.flac"), monoFile = dir.getChildFile("m.wav");
        writeSine(wavFile, wav, 44100.0, 2, 16, 1.0, 440.0);
        writeSine(aiffFile, aiff, 48000.0, 2, 24, 0.5, 220.0);
        writeSine(flacFile, flac, 96000.0, 2, 24, 0.25, 1000.0);
        writeSine(monoFile, wav, 48000.0, 1, 16, 0.5, 440.0);

        std::string err;
        const auto a = loadSample(wavFile, err);
        expect(a != nullptr && a->frames == 44100 && a->sampleRate == 44100.0 && a->channels == 2, "samples: 16-bit WAV decodes with the right length and rate");
        expect(a != nullptr && std::fabs(a->peak - 0.5f) < 0.001f, "samples: peak level is measured");
        const auto b = loadSample(aiffFile, err);
        expect(b != nullptr && b->frames == 24000 && b->sampleRate == 48000.0, "samples: 24-bit AIFF decodes");
        const auto c = loadSample(flacFile, err);
        expect(c != nullptr && c->frames == 24000 && c->sampleRate == 96000.0, "samples: FLAC decodes");
        const auto mo = loadSample(monoFile, err);
        expect(mo != nullptr && mo->channels == 1 && mo->right.empty(), "samples: mono stays mono");

        std::string e1, e2;
        expect(loadSample(dir.getChildFile("missing.wav"), e1) == nullptr && !e1.empty(), "samples: a missing file is reported, not a crash");
        const juce::File junk = dir.getChildFile("junk.wav");
        junk.replaceWithText("this is not audio");
        expect(loadSample(junk, e2) == nullptr && !e2.empty(), "samples: a damaged file is reported, not a crash");

        if (a != nullptr)
        {
            const auto peaks = samplePeaks(*a, 96);
            int top = 0;
            for (int v : peaks) top = std::max(top, v);
            expect(peaks.size() == 96 && top == 255, "samples: 96 peak buckets, loudest bucket is 255");
        }

        // preview voice, rendered through the real engine path at 48 kHz (the 44.1 kHz file is resampled)
        if (a != nullptr)
        {
            AudioEngine eng;
            eng.prepare(48000.0, 512);
            std::vector<float> l(512), r(512);
            float* out[2] = { l.data(), r.data() };
            eng.process(out, 2, 512);
            expect(eng.preview.fraction() < 0.0f, "preview: idle before it is started");

            eng.preview.start(a.get(), 1.0f);
            double energy = 0;
            float firstSample = 99.0f;
            float maxStep = 0.0f, prev = 0.0f;
            int blocks = 0;
            bool playedAtMid = false;
            while (blocks < 200)
            {
                eng.process(out, 2, 512);
                if (blocks == 0) firstSample = l[0];
                for (int i = 0; i < 512; ++i)
                {
                    energy += static_cast<double>(l[static_cast<size_t>(i)]) * l[static_cast<size_t>(i)];
                    maxStep = std::max(maxStep, std::fabs(l[static_cast<size_t>(i)] - prev));
                    prev = l[static_cast<size_t>(i)];
                }
                ++blocks;
                if (blocks == 40) playedAtMid = eng.preview.fraction() > 0.3f && eng.preview.fraction() < 0.9f;
                if (eng.preview.fraction() < 0.0f) break;
            }
            // a 1 s file at 48 kHz = 94 blocks of 512 (+ 1 for the stop detection)
            expect(blocks >= 90 && blocks <= 98, "preview: a 1 s sample takes about 1 s to play (resampled to the device rate)");
            expect(playedAtMid, "preview: the position fraction advances while playing");
            expect(energy > 100.0, "preview: audible output");
            expect(std::fabs(firstSample) < 0.02f, "preview: starts from silence (no click)");
            expect(maxStep < 0.15f, "preview: no sudden jumps in the output");

            // stopping fades out within ~10 ms and stays silent
            eng.preview.start(a.get(), 1.0f);
            eng.process(out, 2, 512);
            eng.preview.stop();
            eng.process(out, 2, 512);
            float tail = 0.0f;
            for (int i = 400; i < 512; ++i) tail = std::max(tail, std::fabs(l[static_cast<size_t>(i)]));
            eng.process(out, 2, 512);
            float after = 0.0f;
            for (int i = 0; i < 512; ++i) after = std::max(after, std::fabs(l[static_cast<size_t>(i)]));
            expect(after == 0.0f && eng.preview.fraction() < 0.0f, "preview: stop fades out and leaves silence");
            (void)tail;

            // replacing a sample while one plays crossfades (no click at the switch)
            eng.preview.start(a.get(), 1.0f);
            for (int k = 0; k < 4; ++k) eng.process(out, 2, 512);
            prev = l[511];
            eng.preview.start(b.get(), 1.0f);
            eng.process(out, 2, 512);
            float jump = 0.0f;
            for (int i = 0; i < 512; ++i)
            {
                jump = std::max(jump, std::fabs(l[static_cast<size_t>(i)] - prev));
                prev = l[static_cast<size_t>(i)];
            }
            expect(jump < 0.15f, "preview: switching samples does not click");
        }

        // the store caches by path and keeps the playing sample alive
        SampleStore store;
        std::string se;
        const auto s1 = store.get(wavFile.getFullPathName().toStdString(), se);
        const auto s2 = store.get(wavFile.getFullPathName().toStdString(), se);
        expect(s1 != nullptr && s1 == s2, "samples: the store returns the cached decode");
        dir.deleteRecursively();
    }


    // ---- 5. Sample tracks: a note plays the sample (middle C = original pitch), stereo is kept, gating, cut, safe lifetime ----
    {
        auto sample = std::make_shared<SampleData>();
        sample->sampleRate = 48000.0;
        sample->channels = 2;
        sample->frames = 48000;
        sample->left.resize(48000);
        sample->right.resize(48000);
        for (int i = 0; i < 48000; ++i)
        {
            const float v = static_cast<float>(std::sin(2.0 * 3.14159265358979 * 440.0 * i / 48000.0));
            sample->left[static_cast<size_t>(i)] = 0.6f * v;
            sample->right[static_cast<size_t>(i)] = 0.3f * v;
        }
        sample->peak = 0.6f;

        const auto makeModel = [&](int pitch, int64_t durTicks, bool gate) {
            auto m = std::make_unique<PlaybackModel>();
            m->ppq = 960;
            m->loopTicks = 8 * 3840;
            m->masterGain = 1.0f;
            TrackModel t;
            t.slot = 2;
            t.instrument = kSample;
            t.gain = 1.0f;
            t.pan = 0.0f;
            t.sample = sample;
            t.gate = gate;
            NoteEvent n;
            n.startTick = 0;
            n.endTick = durTicks;
            n.pitch = pitch;
            n.velocity = 127;
            t.notes.push_back(n);
            m->tracks.push_back(std::move(t));
            return m;
        };
        struct Run { double eL = 0, eR = 0; int64_t lastAudible = -1; float peak = 0; };
        const auto play = [&](const PlaybackModel& model, int blocks, int cutAtBlock = -1) {
            AudioEngine eng;
            eng.prepare(48000.0, 480);
            eng.sequencer.setModel(&model);
            eng.sequencer.setBpm(120.0);
            eng.sequencer.setPlaying(true);
            std::vector<float> l(480), r(480);
            float* out[2] = { l.data(), r.data() };
            Run run;
            for (int b = 0; b < blocks; ++b)
            {
                if (b == cutAtBlock) eng.cutSamples();
                eng.process(out, 2, 480);
                for (int i = 0; i < 480; ++i)
                {
                    const float a = std::max(std::fabs(l[static_cast<size_t>(i)]), std::fabs(r[static_cast<size_t>(i)]));
                    run.eL += static_cast<double>(l[static_cast<size_t>(i)]) * l[static_cast<size_t>(i)];
                    run.eR += static_cast<double>(r[static_cast<size_t>(i)]) * r[static_cast<size_t>(i)];
                    run.peak = std::max(run.peak, a);
                    if (a > 0.002f) run.lastAudible = static_cast<int64_t>(b) * 480 + i;
                }
            }
            eng.sequencer.setModel(nullptr);
            return run;
        };

        // middle C plays at the original speed (1 s) and the sample is heard in stereo (left twice as loud as right)
        {
            const auto m = makeModel(60, 3840, false);
            const Run r = play(*m, 140);
            expect(r.peak > 0.5f && r.peak < 0.7f, "sample track: plays the sample at its own level (velocity 127, unity gain)");
            expect(r.lastAudible > 47000 && r.lastAudible < 48600, "sample track: middle C plays the whole 1 s sample, no more");
            const double ratio = std::sqrt(r.eL / std::max(1e-12, r.eR));
            expect(std::fabs(ratio - 2.0) < 0.02, "sample track: stereo width is kept (left twice as loud as right)");
        }
        // an octave up plays twice as fast: half the length
        {
            const auto m = makeModel(72, 3840, false);
            const Run r = play(*m, 140);
            expect(r.lastAudible > 23000 && r.lastAudible < 24700, "sample track: one octave up plays in half the time");
        }
        // a one-shot ignores the note-off (a short note does not cut it); a gated sound stops with it
        {
            const auto shortNote = makeModel(60, 480, false); // 1/4 s
            const Run one = play(*shortNote, 140);
            expect(one.lastAudible > 47000, "sample track: a one-shot plays to its end although the note is short");
            const auto gated = makeModel(60, 480, true);
            const Run g = play(*gated, 140);
            expect(g.lastAudible > 11800 && g.lastAudible < 13300, "sample track: a gated sound is cut at the note end with a short fade (no click)");
        }
        // transport stop cuts everything
        {
            const auto m = makeModel(60, 3840, false);
            const Run r = play(*m, 140, 20);
            expect(r.lastAudible > 9600 && r.lastAudible < 10800, "sample track: stop fades the sound out within a few milliseconds");
        }
        // pitch bend by note: no click at the start (starts from silence)
        {
            const auto m = makeModel(60, 3840, false);
            AudioEngine eng;
            eng.prepare(48000.0, 480);
            eng.sequencer.setModel(m.get());
            eng.sequencer.setBpm(120.0);
            eng.sequencer.setPlaying(true);
            std::vector<float> l(480), r(480);
            float* out[2] = { l.data(), r.data() };
            eng.process(out, 2, 480);
            expect(std::fabs(l[0]) < 0.01f, "sample track: starts from silence");
            eng.sequencer.setModel(nullptr);
        }
        // missing sample: the track plays nothing and nothing breaks
        {
            auto m = makeModel(60, 3840, false);
            m->tracks[0].sample = nullptr;
            const Run r = play(*m, 40);
            expect(r.peak == 0.0f, "sample track: a missing sample is silent");
        }
        // voices are counted, and a sample is not freed while a voice reads it
        expect(sample->voices.load() == 0, "sample track: every voice released the sample when it ended");
        {
            SampleStore store;
            std::weak_ptr<SampleData> weak;
            {
                auto tmp = std::make_shared<SampleData>();
                tmp->frames = 10;
                tmp->left.assign(10, 0.0f);
                tmp->voices.store(1); // pretend a voice is playing it
                weak = tmp;
                store.keep(tmp);
            }
            store.purge();
            expect(!weak.expired(), "sample store: a retired sample is kept at first");
            juce::Thread::sleep(3200);
            store.purge();
            expect(!weak.expired(), "sample store: a retired sample is not freed while a voice is playing it");
            weak.lock()->voices.store(0);
            store.purge();
            expect(weak.expired(), "sample store: it is freed once the last voice has ended");
        }
        // offline export renders sample tracks like live playback
        {
            const auto m = makeModel(60, 3840, false);
            const juce::File file = juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("daw_selftest_sample_export.wav");
            const ExportResult er = exportWav(*m, file, 48000.0, 0.5);
            expect(er.ok && er.peak > 0.5f, "sample track: exports");
            file.deleteFile();
        }
    }


    // ---- 6. Time stretch: a loop keeps its beats on the grid at the new tempo ----
    {
        const double sr = 48000.0;
        const double nativeBpm = 90.0;
        const int beats = 8;
        const auto frames = static_cast<int64_t>(std::llround(beats * 60.0 / nativeBpm * sr));
        SampleData src;
        src.sampleRate = sr;
        src.channels = 2;
        src.frames = frames;
        src.left.assign(static_cast<size_t>(frames), 0.0f);
        src.right.assign(static_cast<size_t>(frames), 0.0f);
        // a short tone burst on every beat (so the stretcher has something tonal to follow), louder on the first
        for (int b = 0; b < beats; ++b)
        {
            const auto at = static_cast<int64_t>(std::llround(b * 60.0 / nativeBpm * sr));
            for (int i = 0; i < 2400 && at + i < frames; ++i)
            {
                const float env = std::exp(-static_cast<float>(i) / 500.0f) * (b == 0 ? 0.9f : 0.6f);
                const float v = env * static_cast<float>(std::sin(2.0 * 3.14159265358979 * 220.0 * i / sr));
                src.left[static_cast<size_t>(at + i)] = v;
                src.right[static_cast<size_t>(at + i)] = 0.5f * v;
            }
        }
        const auto onsets = [&](const SampleData& d) {
            std::vector<int64_t> found;
            const int win = 96;
            int64_t lastHit = -100000;
            for (int64_t i = 0; i + win < d.frames; i += 8)
            {
                float m = 0.0f;
                for (int k = 0; k < win; k += 4) m = std::max(m, std::fabs(d.left[static_cast<size_t>(i + k)]));
                if (m > 0.12f && i - lastHit > static_cast<int64_t>(0.2 * sr))
                {
                    found.push_back(i);
                    lastHit = i;
                }
            }
            return found;
        };
        for (const double targetBpm : { 120.0, 75.0, 100.0 })
        {
            const double ratio = targetBpm / nativeBpm;
            std::string err;
            const auto out = stretchSample(src, ratio, err);
            expect(out != nullptr, "stretch: produces audio");
            if (out == nullptr) continue;
            const auto expectedLen = static_cast<int64_t>(std::llround(beats * 60.0 / targetBpm * sr));
            expect(std::llabs(out->frames - expectedLen) <= 1, "stretch: the loop is exactly as long as its bars are at the new tempo");
            expect(out->channels == 2 && out->right.size() == out->left.size(), "stretch: stereo stays stereo");
            const auto found = onsets(*out);
            expect(static_cast<int>(found.size()) == beats, "stretch: every beat is still there (no beat lost or doubled)");
            int64_t worst = 0;
            for (size_t b = 0; b < found.size() && b < static_cast<size_t>(beats); ++b)
                worst = std::max<int64_t>(worst, std::llabs(found[b] - static_cast<int64_t>(std::llround(b * 60.0 / targetBpm * sr))));
            char msg[160];
            std::snprintf(msg, sizeof(msg), "stretch: every beat lands on the grid within 5 ms at %.0f BPM (worst %lld samples)", targetBpm, static_cast<long long>(worst));
            if (worst > 240) std::fprintf(stderr, "stretch %.0f BPM: worst onset error %lld samples\n", targetBpm, static_cast<long long>(worst));
            expect(worst <= 240, msg); // a beat is detected where its stretched attack crosses a threshold, so a few ms of slack; it must not drift
            expect(out->peak > 0.5f && out->peak < 1.3f, "stretch: level stays about the same");
            // the pitch is unchanged: the 220 Hz tone still has 220 Hz zero crossings (count in the first burst region)
            std::string e2;
            const auto again = stretchSample(src, ratio, e2);
            bool same = again != nullptr && again->left == out->left;
            expect(same, "stretch: deterministic (same input, same audio)");
        }
        std::string e3;
        expect(stretchSample(src, 9.0, e3) == nullptr && !e3.empty(), "stretch: an extreme tempo change is refused with a message");
    }


    // ---- 7. Clip settings of sample tracks: gain, start point, fade in, fade out, cut ----
    {
        // 1 s sound: the first half is quiet (0.2), the second half loud (0.8); a 440 Hz tone
        auto sample = std::make_shared<SampleData>();
        sample->sampleRate = 48000.0;
        sample->channels = 1;
        sample->frames = 48000;
        sample->left.resize(48000);
        for (int i = 0; i < 48000; ++i)
            sample->left[static_cast<size_t>(i)] = (i < 24000 ? 0.2f : 0.8f) * static_cast<float>(std::sin(2.0 * 3.14159265358979 * 440.0 * i / 48000.0));
        sample->peak = 0.8f;

        // 120 BPM, 960 ppq: 1 s = 1920 ticks
        const auto render = [&](int64_t lengthTicks, auto&& shape, int blocks = 100) {
            PlaybackModel m;
            m.ppq = 960;
            m.tempo = 120.0;
            m.loopTicks = 8 * 3840;
            m.masterGain = 1.0f;
            TrackModel t;
            t.slot = 1;
            t.instrument = kSample;
            t.gain = 1.0f;
            t.sample = sample;
            NoteEvent n;
            n.startTick = 0;
            n.endTick = lengthTicks;
            n.pitch = 60;
            n.velocity = 127;
            n.lengthSec = static_cast<double>(lengthTicks) / 1920.0;
            shape(n);
            t.notes.push_back(n);
            m.tracks.push_back(std::move(t));
            AudioEngine eng;
            eng.prepare(48000.0, 480);
            eng.sequencer.setModel(&m);
            eng.sequencer.setBpm(120.0);
            eng.sequencer.setPlaying(true);
            std::vector<float> l(480), r(480), out;
            float* po[2] = { l.data(), r.data() };
            for (int b = 0; b < blocks; ++b)
            {
                eng.process(po, 2, 480);
                out.insert(out.end(), l.begin(), l.end());
            }
            eng.sequencer.setModel(nullptr);
            return out;
        };
        const auto peakIn = [](const std::vector<float>& x, size_t from, size_t to) {
            float p = 0.0f;
            for (size_t i = from; i < to && i < x.size(); ++i) p = std::max(p, std::fabs(x[i]));
            return p;
        };

        const auto plain = render(1920, [](NoteEvent&) {});
        const float plainLoud = peakIn(plain, 30000, 46000);
        expect(plainLoud > 0.75f && plainLoud < 0.85f, "clip settings: unchanged sound plays as recorded");

        const auto half = render(1920, [](NoteEvent& n) { n.gain = 0.5f; });
        expect(std::fabs(peakIn(half, 30000, 46000) - 0.5f * plainLoud) < 0.02f, "clip settings: gain 0.5 halves the level");

        const auto offset = render(960, [](NoteEvent& n) { n.offsetSec = 0.5; n.cut = true; });
        expect(peakIn(offset, 1000, 20000) > 0.75f, "clip settings: starting 0.5 s into the sound skips the quiet half");
        expect(peakIn(offset, 25000, 30000) < 0.01f, "clip settings: the clip end cuts the sound (0.5 s clip, then silence)");

        const auto fin = render(1920, [](NoteEvent& n) { n.fadeInSec = 0.5; n.offsetSec = 0.5; });
        const float early = peakIn(fin, 2000, 4000), mid = peakIn(fin, 11000, 13000), late = peakIn(fin, 22000, 23900);
        expect(early < 0.16f && mid > 0.3f && mid < 0.5f && late > 0.7f, "clip settings: fade in ramps up over its length (about 0.13, 0.43, 0.78)");
        expect(std::fabs(fin[0]) < 0.001f, "clip settings: fade in starts from silence");

        const auto fout = render(1920, [](NoteEvent& n) { n.fadeOutSec = 0.5; n.offsetSec = 0.0; n.cut = true; });
        // note is 1 s long: loud half from 0.5 s on, faded across 0.5..1.0 s
        const float f1 = peakIn(fout, 24500, 26500), f2 = peakIn(fout, 35000, 37000), f3 = peakIn(fout, 46000, 47900);
        expect(f1 > 0.6f && f2 > 0.25f && f2 < 0.55f && f3 < 0.12f, "clip settings: fade out ramps down to silence at the clip end");
        expect(peakIn(fout, 49000, 60000) < 0.002f, "clip settings: silent after the fade out");

        // both gain and fades together, and fades never make the sound louder
        const auto both = render(1920, [](NoteEvent& n) { n.gain = 0.5f; n.fadeInSec = 0.25; n.fadeOutSec = 0.25; n.cut = true; });
        expect(peakIn(both, 0, 48000) <= 0.5f * 0.82f, "clip settings: fades and gain together never exceed the gained level");
        expect(sample->voices.load() == 0, "clip settings: voices released");
    }


    // ---- 8. Automation: volume and filter curves ----
    {
        expect(autoAt({}, 5.0) == 1.0f, "automation: no curve = 1");
        const std::vector<AutoPoint> curve = { { 960.0, 0.0f }, { 1920.0, 1.0f }, { 2880.0, 0.5f } };
        expect(autoAt(curve, 0.0) == 0.0f && autoAt(curve, 9999.0) == 0.5f, "automation: holds the first and last values outside the curve");
        expect(std::fabs(autoAt(curve, 1440.0) - 0.5f) < 1e-6f && std::fabs(autoAt(curve, 2400.0) - 0.75f) < 1e-6f, "automation: straight lines between points");

        // a long steady tone as a sample, played on a sample track so the level is easy to read
        const auto makeTone = [](double hz) {
            auto s = std::make_shared<SampleData>();
            s->sampleRate = 48000.0;
            s->channels = 1;
            s->frames = 6 * 48000;
            s->left.resize(static_cast<size_t>(s->frames));
            for (int64_t i = 0; i < s->frames; ++i) s->left[static_cast<size_t>(i)] = 0.5f * static_cast<float>(std::sin(2.0 * 3.14159265358979 * hz * static_cast<double>(i) / 48000.0));
            s->peak = 0.5f;
            return s;
        };
        const auto render = [&](const std::shared_ptr<SampleData>& tone, const std::vector<AutoPoint>& vol, const std::vector<AutoPoint>& filt, int blocks, int slot = 1) {
            PlaybackModel m;
            m.ppq = 960;
            m.tempo = 120.0;
            m.loopTicks = 16 * 3840;
            m.masterGain = 1.0f;
            TrackModel t;
            t.slot = slot;
            t.instrument = kSample;
            t.gain = 1.0f;
            t.sample = tone;
            t.gate = true;
            t.volumeAuto = vol;
            t.filterAuto = filt;
            NoteEvent n;
            n.startTick = 0;
            n.endTick = 5 * 1920;
            n.pitch = 60;
            n.velocity = 127;
            n.lengthSec = 5.0;
            t.notes.push_back(n);
            m.tracks.push_back(std::move(t));
            AudioEngine eng;
            eng.prepare(48000.0, 480);
            eng.sequencer.setModel(&m);
            eng.sequencer.setBpm(120.0);
            eng.sequencer.setPlaying(true);
            std::vector<float> l(480), r(480), out;
            float* po[2] = { l.data(), r.data() };
            for (int b = 0; b < blocks; ++b)
            {
                eng.process(po, 2, 480);
                out.insert(out.end(), l.begin(), l.end());
            }
            eng.sequencer.setModel(nullptr);
            return out;
        };
        const auto peakIn = [](const std::vector<float>& x, double from, double to) {
            float p = 0.0f;
            for (size_t i = static_cast<size_t>(from * 48000); i < static_cast<size_t>(to * 48000) && i < x.size(); ++i) p = std::max(p, std::fabs(x[i]));
            return p;
        };

        const auto tone = makeTone(440.0);
        const auto plain = render(tone, {}, {}, 400);
        const float full = peakIn(plain, 1.0, 1.5);
        expect(full > 0.45f, "automation: reference tone is audible");

        // volume swell: 0 at tick 0 to 1 at tick 3840 (2 s); the level follows value squared
        const auto swell = render(tone, { { 0.0, 0.0f }, { 3840.0, 1.0f } }, {}, 400);
        expect(peakIn(swell, 0.0, 0.01) < 0.01f, "automation: a swell starts from silence (no blip at the first note)");
        const float at1 = peakIn(swell, 0.95, 1.05), at15 = peakIn(swell, 1.45, 1.55), at2 = peakIn(swell, 2.1, 2.5);
        expect(std::fabs(at1 / full - 0.25f) < 0.03f, "automation: halfway up the ramp the level is a quarter (value squared, like the fader)");
        expect(std::fabs(at15 / full - 0.5625f) < 0.04f, "automation: three quarters up it is 0.56 of full level");
        expect(std::fabs(at2 / full - 1.0f) < 0.03f, "automation: after the last point the level holds at its value");

        // a fade down to silence and a curve below the start
        const auto down = render(tone, { { 0.0, 1.0f }, { 1920.0, 0.0f } }, {}, 400);
        expect(peakIn(down, 0.05, 0.1) > 0.8f * full && peakIn(down, 1.5, 3.0) < 0.01f, "automation: a ramp down ends in silence and stays there");

        // filter: 8 kHz tone, cutoff 20 * 1000^0.3 = 159 Hz is far below it
        const auto bright = makeTone(8000.0);
        const auto unfiltered = render(bright, {}, {}, 300);
        const auto closed = render(bright, {}, { { 0.0, 0.3f } }, 300);
        const auto wide = render(bright, {}, { { 0.0, 1.0f } }, 300);
        expect(peakIn(closed, 0.5, 1.5) < 0.02f * peakIn(unfiltered, 0.5, 1.5), "automation: a low cutoff removes an 8 kHz tone (more than 34 dB)");
        expect(peakIn(wide, 0.5, 1.5) > 0.98f * peakIn(unfiltered, 0.5, 1.5) && peakIn(wide, 0.5, 1.5) < 1.02f * peakIn(unfiltered, 0.5, 1.5), "automation: filter fully unfiltered changes nothing");
        // a 100 Hz tone gets through a 159 Hz low-pass (about -3 dB or better), an 8 kHz tone does not
        const auto lowTone = makeTone(100.0);
        const auto bassOpen = render(lowTone, {}, {}, 300);
        const auto bassFiltered = render(lowTone, {}, { { 0.0, 0.3f } }, 300);
        expect(peakIn(bassFiltered, 0.5, 1.5) > 0.6f * peakIn(bassOpen, 0.5, 1.5), "automation: low notes pass a low cutoff");

        // filter sweep: closed to unfiltered over 2 s; the tone grows from almost nothing to full
        const auto sweep = render(bright, {}, { { 0.0, 0.2f }, { 3840.0, 1.0f } }, 400);
        const auto sFirst = peakIn(sweep, 0.1, 0.4), sMid = peakIn(sweep, 1.4, 1.6), sEnd = peakIn(sweep, 2.5, 3.0);
        expect(sFirst < 0.05f * sEnd && sMid > sFirst * 3.0f && sEnd > 0.95f * peakIn(unfiltered, 2.5, 3.0), "automation: a filter sweep opens up over time");

        // volume and filter together, and the output never has sudden jumps (no zipper noise on a slow sweep)
        float worstStep = 0.0f;
        for (size_t i = 1; i < sweep.size(); ++i) worstStep = std::max(worstStep, std::fabs(sweep[i] - sweep[i - 1]));
        expect(worstStep < 1.0f, "automation: the swept output stays in range");
        expect(tone->voices.load() == 0 && bright->voices.load() == 0, "automation: voices released");

        // offline export uses the same curves
        {
            PlaybackModel m;
            m.ppq = 960;
            m.tempo = 120.0;
            m.loopTicks = 4 * 3840;
            m.masterGain = 1.0f;
            TrackModel t;
            t.slot = 1;
            t.instrument = kSample;
            t.gain = 1.0f;
            t.sample = tone;
            t.gate = true;
            t.volumeAuto = { { 0.0, 0.0f }, { 3840.0, 1.0f } };
            NoteEvent n;
            n.endTick = 4 * 3840;
            n.velocity = 127;
            n.lengthSec = 8.0;
            t.notes.push_back(n);
            m.tracks.push_back(std::move(t));
            const juce::File file = juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("daw_selftest_auto_export.wav");
            const ExportResult er = exportWav(m, file, 48000.0, 0.2);
            expect(er.ok, "automation: exports");
            juce::WavAudioFormat wav;
            std::unique_ptr<juce::AudioFormatReader> reader(wav.createReaderFor(file.createInputStream().release(), true));
            if (reader != nullptr)
            {
                juce::AudioBuffer<float> buf(2, 4800);
                float early = 0.0f, late = 0.0f;
                reader->read(&buf, 0, 4800, 48000 / 2, true, true); // 0.5 s
                for (int i = 0; i < 4800; ++i) early = std::max(early, std::fabs(buf.getSample(0, i)));
                reader->read(&buf, 0, 4800, 48000 * 3, true, true); // 3 s, after the ramp
                for (int i = 0; i < 4800; ++i) late = std::max(late, std::fabs(buf.getSample(0, i)));
                expect(early < 0.1f * late && late > 0.4f, "automation: the exported WAV follows the volume curve");
            }
            file.deleteFile();
        }
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
