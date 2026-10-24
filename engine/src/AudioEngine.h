#pragma once
#include "Drums.h"
#include "Samples.h"
#include "Sequencer.h"
#include "PluginClient.h"
#include "Synth.h"
#include <juce_audio_devices/juce_audio_devices.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <vector>

/**
 * Real-time audio: sequencer -> per-slot instruments -> per-slot mixer (smoothed gain, constant-power pan)
 * -> master (smoothed gain, soft clip). The callback never allocates, locks, waits on I/O or parses messages.
 * Commands arrive through atomics, an immutable model pointer and a small lock-free FIFO for note previews.
 */
/** Second-order low-pass (RBJ, Q 0.707) for the filter automation lane. Three channels: the mono instrument mix and the two sample channels. */
struct SlotFilter
{
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    double z1[3] = {}, z2[3] = {};
    bool engaged = false;

    void set(double cutoffHz, double sr)
    {
        const double w0 = 6.283185307179586 * std::min(cutoffHz, sr * 0.45) / sr;
        const double cw = std::cos(w0), alpha = std::sin(w0) / (2.0 * 0.70710678);
        const double a0 = 1.0 + alpha;
        b0 = (1.0 - cw) / 2.0 / a0;
        b1 = (1.0 - cw) / a0;
        b2 = b0;
        a1 = -2.0 * cw / a0;
        a2 = (1.0 - alpha) / a0;
        engaged = true;
    }
    void reset()
    {
        engaged = false;
        for (int i = 0; i < 3; ++i) z1[i] = z2[i] = 0.0;
    }
    void run(int ch, float* x, int n)
    {
        double s1 = z1[ch], s2 = z2[ch];
        for (int i = 0; i < n; ++i)
        {
            const double in = x[i];
            const double out = b0 * in + s1;
            s1 = b1 * in - a1 * out + s2;
            s2 = b2 * in - a2 * out;
            x[i] = static_cast<float>(out);
        }
        z1[ch] = s1;
        z2[ch] = s2;
    }
};

class AudioEngine : public juce::AudioIODeviceCallback, private SequencerSink
{
public:
    struct PreviewMsg
    {
        int slot = 0;
        int pitch = 60;
        int velocity = 90;
        bool on = false;
    };

    Sequencer sequencer;
    /** The sample browser's audition voice (not part of any track). */
    SamplePreview preview;

    /** Fades out every playing sample on every track (transport stop). Any thread. */
    void cutSamples() { cutSerial.fetch_add(1, std::memory_order_release); }

    void pushPreview(const PreviewMsg& m)
    {
        int s1, n1, s2, n2;
        fifo.prepareToWrite(1, s1, n1, s2, n2);
        if (n1 > 0)
        {
            previewBuf[s1] = m;
            fifo.finishedWrite(1);
        }
    }

    void audioDeviceAboutToStart(juce::AudioIODevice* device) override
    {
        sampleRate = device->getCurrentSampleRate();
        bufferSize = device->getCurrentBufferSizeSamples();
        prepare(sampleRate, bufferSize);
    }
    void audioDeviceStopped() override {}

    /** Also used by the offline benchmark. Allocates; call before audio starts. */
    void prepare(double sr, int maxBlock)
    {
        sampleRate = sr;
        sequencer.prepare(sr);
        preview.prepare(sr);
        for (auto& s : slots)
        {
            s.synth.prepare(sr);
            s.drums.prepare(sr);
            s.samp.prepare(sr);
            s.gain = 0.0f;
            s.pan = 0.0f;
        }
        invTau = static_cast<float>(1.0 / (0.010 * sr));
        sampleCoef = 1.0f - std::exp(-invTau);
        ticksPerSecond = static_cast<double>(juce::Time::getHighResolutionTicksPerSecond());
        const size_t n = static_cast<size_t>(std::max(maxBlock, 8192));
        masterInitialised = false;
        tmp.assign(n, 0.0f);
        sampL.assign(n, 0.0f);
        sampR.assign(n, 0.0f);
        bufL.assign(n, 0.0f);
        bufR.assign(n, 0.0f);
        plugStride = n;
        plugL.assign(n * kMaxSlots, 0.0f);
        plugR.assign(n * kMaxSlots, 0.0f);
        plugMidi.assign(static_cast<size_t>(kMaxSlots) * plugipc::kMaxMidi, plugipc::MidiEv{});
    }

    void audioDeviceIOCallbackWithContext(const float* const*, int, float* const* out, int numOut, int numSamples,
                                          const juce::AudioIODeviceCallbackContext&) override
    {
        juce::ScopedNoDenormals noDenormals;
        const auto t0 = juce::Time::getHighResolutionTicks();

        process(out, numOut, numSamples);

        const double elapsed = static_cast<double>(juce::Time::getHighResolutionTicks() - t0) / ticksPerSecond;
        const double load = elapsed / (static_cast<double>(numSamples) / sampleRate);
        callbacks.fetch_add(1, std::memory_order_relaxed);
        if (load > 1.0) overruns.fetch_add(1, std::memory_order_relaxed);
        if (load > peakLoad.load(std::memory_order_relaxed)) peakLoad.store(load, std::memory_order_relaxed);
    }

    /** The whole render path (no timing); shared by the device callback and offline tests. */
    void process(float* const* out, int numOut, int numSamples)
    {
        if (numSamples > static_cast<int>(tmp.size()))
        {
            for (int c = 0; c < numOut; ++c)
                if (out[c]) juce::FloatVectorOperations::clear(out[c], numSamples);
            return; // never allocate here
        }

        const PlaybackModel* m = sequencer.currentModel();
        for (int s = 0; s < kMaxSlots; ++s) plugMidiCount[s] = 0;

        {
            int s1, n1, s2, n2;
            const int ready = fifo.getNumReady();
            fifo.prepareToRead(ready, s1, n1, s2, n2);
            for (int i = 0; i < n1; ++i) applyPreview(previewBuf[s1 + i], m);
            for (int i = 0; i < n2; ++i) applyPreview(previewBuf[s2 + i], m);
            fifo.finishedRead(n1 + n2);
        }

        // Which sample each slot plays comes from the current model (the audio thread reads it, never writes it).
        for (int s = 0; s < kMaxSlots; ++s) { slotSample[s] = nullptr; slotGate[s] = false; slotVolumeAuto[s] = nullptr; slotFilterAuto[s] = nullptr; slotPlugin[s] = pluginOverride[s]; }
        const bool playingNow = sequencer.isPlaying();
        blockTick = sequencer.getTick();
        segTps = playingNow ? sequencer.getBpm() * (m != nullptr ? m->ppq : 960) / (60.0 * sampleRate) : 0.0;
        loopTicksNow = m != nullptr ? static_cast<double>(m->loopTicks) : 0.0;
        regionStartNow = regionEndNow = 0.0;
        if (m != nullptr && useRegionNow && m->loopEndTick > m->loopStartTick && m->loopEndTick <= m->loopTicks)
        {
            regionStartNow = static_cast<double>(m->loopStartTick);
            regionEndNow = static_cast<double>(m->loopEndTick);
        }
        if (m != nullptr)
            for (const auto& tr : m->tracks)
            {
                const int s = std::clamp(tr.slot, 0, kMaxSlots - 1);
                slotSample[s] = tr.sample.get();
                slotGate[s] = tr.gate;
                slotVolumeAuto[s] = tr.volumeAuto.empty() ? nullptr : &tr.volumeAuto;
                slotFilterAuto[s] = tr.filterAuto.empty() ? nullptr : &tr.filterAuto;
                if (tr.instrument == kSynth) slots[s].synth.setParams(tr.synth); // the track's synth preset
                if (tr.instrument == kPlugin && slotPlugin[s] == nullptr && useModelPlugins) slotPlugin[s] = tr.plugin;
            }
        const int cut = cutSerial.load(std::memory_order_acquire);
        if (cut != seenCut)
        {
            seenCut = cut;
            for (auto& s : slots) s.samp.cut();
        }

        eventCount = 0;
        sequencer.process(numSamples, *this);
        runPlugins(numSamples);

        float targetGain[kMaxSlots] = {};
        float targetPan[kMaxSlots] = {};
        float masterTarget = 0.64f;
        if (m != nullptr)
        {
            masterTarget = m->masterGain;
            for (const auto& tr : m->tracks)
            {
                const int s = std::clamp(tr.slot, 0, kMaxSlots - 1);
                targetGain[s] = tr.gain;
                targetPan[s] = tr.pan;
            }
        }

        // Idle slots (and the master on the very first block) jump straight to their target so a new note
        // starts at the right level and pan instead of ramping in from zero.
        for (int s = 0; s < kMaxSlots; ++s)
        {
            if (!slots[s].synth.anyActive() && !slots[s].drums.anyActive() && !slots[s].samp.anyActive() && !plugActive[s])
            {
                slots[s].gain = targetGain[s] * volumeMul(s, blockTick);
                slots[s].pan = targetPan[s];
            }
        }
        if (!masterInitialised)
        {
            masterGain = masterTarget;
            masterInitialised = true;
        }

        juce::FloatVectorOperations::clear(bufL.data(), numSamples);
        juce::FloatVectorOperations::clear(bufR.data(), numSamples);
        float localPeak[kMaxSlots] = {};

        int cursor = 0;
        for (int i = 0; i < eventCount; ++i)
        {
            const Event& e = events[i];
            if (e.offset > cursor)
            {
                segTick = tickAt(cursor);
                renderSegment(cursor, e.offset - cursor, targetGain, targetPan, localPeak);
                cursor = e.offset;
            }
            if (e.type == 2) click.trigger(e.pitch == 1, sampleRate);
            else if (e.type == 1)
            {
                if (e.instrument == kDrums) slots[e.slot].drums.trigger(e.pitch, e.velocity);
                else if (e.instrument == kSample) slots[e.slot].samp.trigger(slotSample[e.slot], e.pitch, e.velocity, slotGate[e.slot], &e.note);
                else if (e.instrument == kPlugin) { /* its MIDI was sent to the plugin host before rendering */ }
                else slots[e.slot].synth.noteOn(e.pitch, e.velocity);
            }
            else
            {
                slots[e.slot].synth.noteOff(e.pitch);
                slots[e.slot].samp.release(e.pitch);
            }
        }
        if (cursor < numSamples)
        {
            segTick = tickAt(cursor);
            renderSegment(cursor, numSamples - cursor, targetGain, targetPan, localPeak);
        }

        preview.renderAdd(bufL.data(), bufR.data(), numSamples);

        // Master: smoothed gain, soft clip, peak meters.
        float pl = 0.0f, pr = 0.0f;
        for (int i = 0; i < numSamples; ++i)
        {
            masterGain += (masterTarget - masterGain) * sampleCoef;
            const float l = softClip(bufL[static_cast<size_t>(i)] * masterGain);
            const float r = softClip(bufR[static_cast<size_t>(i)] * masterGain);
            bufL[static_cast<size_t>(i)] = l;
            bufR[static_cast<size_t>(i)] = r;
            pl = std::max(pl, std::fabs(l));
            pr = std::max(pr, std::fabs(r));
        }
        for (int c = 0; c < numOut; ++c)
        {
            if (out[c] == nullptr) continue;
            if (numOut == 1) // mono device
                for (int i = 0; i < numSamples; ++i) out[c][i] = 0.5f * (bufL[static_cast<size_t>(i)] + bufR[static_cast<size_t>(i)]);
            else if (c == 0) juce::FloatVectorOperations::copy(out[c], bufL.data(), numSamples);
            else if (c == 1) juce::FloatVectorOperations::copy(out[c], bufR.data(), numSamples);
            else juce::FloatVectorOperations::clear(out[c], numSamples);
        }

        raise(masterPeakL, pl);
        raise(masterPeakR, pr);
        for (int s = 0; s < kMaxSlots; ++s)
            raise(slotPeak[s], localPeak[s]);
    }

    std::atomic<uint64_t> callbacks{ 0 };
    std::atomic<uint64_t> overruns{ 0 };
    std::atomic<double> peakLoad{ 0.0 };
    std::atomic<float> masterPeakL{ 0.0f };
    std::atomic<float> masterPeakR{ 0.0f };
    std::atomic<float> slotPeak[kMaxSlots] = {};
    double sampleRate = 48000.0;
    int bufferSize = 0;

    /** Metronome click on the quarter notes while playing (off by default; the offline export never has it). */
    void setMetronome(bool on) { sequencer.setClick(on); }
    /** Offline export: never use the model's live (non-blocking) plugin hosts. */
    void setUseModelPlugins(bool on) { useModelPlugins = on; }
    /** Offline export: use these plugin hosts (blocking mode) for these slots instead of the model's live ones. */
    void setPluginOverride(int slot, PluginClient* client)
    {
        if (slot >= 0 && slot < kMaxSlots) pluginOverride[slot] = client;
    }
    /** Live playback wraps inside the project's loop region. */
    void setLoopRegionEnabled(bool on)
    {
        useRegionNow = on;
        sequencer.setUseLoopRegion(on);
    }

private:
    /** The metronome: a short decaying sine, higher on the first beat of a bar. */
    struct ClickVoice
    {
        float phase = 0.0f, inc = 0.0f, env = 0.0f, decay = 0.99f, amp = 0.0f;
        void trigger(bool accent, double sr)
        {
            inc = static_cast<float>(2.0 * 3.14159265358979 * (accent ? 1600.0 : 1000.0) / sr);
            decay = static_cast<float>(std::exp(-1.0 / (0.018 * sr)));
            amp = accent ? 0.5f : 0.32f;
            phase = 0.0f;
            env = 1.0f;
        }
        void renderAdd(float* l, float* r, int n)
        {
            if (env < 1e-4f) return;
            for (int i = 0; i < n; ++i)
            {
                const float v = std::sin(phase) * env * amp;
                l[i] += v;
                r[i] += v;
                phase += inc;
                env *= decay;
            }
        }
    };
    bool useRegionNow = false;

    // ---- plugin tracks (the plugin itself runs in a separate host process; see PluginClient.h) ----
    PluginClient* slotPlugin[kMaxSlots] = {};
    PluginClient* pluginOverride[kMaxSlots] = {};
    bool useModelPlugins = true;
    bool plugActive[kMaxSlots] = {};
    int plugMidiCount[kMaxSlots] = {};
    std::vector<plugipc::MidiEv> plugMidi; // kMaxSlots x kMaxMidi, on the heap (the engine object lives on the stack)
    std::vector<float> plugL, plugR;       // kMaxSlots x plugStride: the audio the hosts returned for this block
    size_t plugStride = 0;

    void addPluginMidi(int slot, int offset, uint8_t status, int d1, int d2)
    {
        if (slot < 0 || slot >= kMaxSlots || plugMidiCount[slot] >= plugipc::kMaxMidi) return;
        plugMidi[static_cast<size_t>(slot) * plugipc::kMaxMidi + static_cast<size_t>(plugMidiCount[slot]++)] =
            { offset, status, static_cast<uint8_t>(std::clamp(d1, 0, 127)), static_cast<uint8_t>(std::clamp(d2, 0, 127)), 0 };
    }
    /** Builds each plugin track's MIDI for this block from the sequencer's events, hands it to the host and collects the audio. */
    void runPlugins(int numSamples)
    {
        for (int i = 0; i < eventCount; ++i)
        {
            const Event& e = events[i];
            if (slotPlugin[e.slot] == nullptr) continue;
            if (e.type == 1 && e.instrument == kPlugin) addPluginMidi(e.slot, e.offset, 0x90, e.pitch, e.velocity);
            else if (e.type == 0) addPluginMidi(e.slot, e.offset, 0x80, e.pitch, 0);
        }
        for (int s = 0; s < kMaxSlots; ++s)
        {
            plugActive[s] = false;
            PluginClient* c = slotPlugin[s];
            if (c == nullptr) continue;
            c->process(&plugMidi[static_cast<size_t>(s) * plugipc::kMaxMidi], plugMidiCount[s], numSamples,
                       plugL.data() + static_cast<size_t>(s) * plugStride, plugR.data() + static_cast<size_t>(s) * plugStride);
            plugActive[s] = c->state() == PluginState::Ready;
        }
    }
    struct Event
    {
        int offset;
        int type; // 1 = on, 0 = off
        int slot;
        int instrument;
        int pitch;
        int velocity;
        NoteEvent note; // full note (sample tracks use its clip settings)
    };
    struct SlotState
    {
        Synth synth;
        DrumKit drums;
        SampleVoices samp;
        SlotFilter filter;
        float gain = 0.0f;
        float pan = 0.0f;
    };

    static constexpr int kMaxEvents = 2048;
    std::unique_ptr<Event[]> events = std::make_unique<Event[]>(kMaxEvents); // on the heap (made once, here): the engine object lives on the stack
    int eventCount = 0;
    SlotState slots[kMaxSlots];
    std::vector<float> tmp, bufL, bufR, sampL, sampR;
    const SampleData* slotSample[kMaxSlots] = {};
    const std::vector<AutoPoint>* slotVolumeAuto[kMaxSlots] = {};
    const std::vector<AutoPoint>* slotFilterAuto[kMaxSlots] = {};
    double segTick = 0.0;    // arrangement tick at the start of the segment being rendered
    double segTps = 0.0;     // ticks per sample (0 while stopped: the curves are read at the playhead)
    double loopTicksNow = 0.0;
    double regionStartNow = 0.0, regionEndNow = 0.0; // the loop region for this block (end == 0: none)
    ClickVoice click;
    bool slotGate[kMaxSlots] = {};
    std::atomic<int> cutSerial{ 0 };
    double blockTick = 0.0;
    int seenCut = 0;
    float masterGain = 0.64f;
    bool masterInitialised = false;
    float invTau = 0.002f, sampleCoef = 0.002f;
    juce::AbstractFifo fifo{ 64 };
    PreviewMsg previewBuf[64];
    double ticksPerSecond = 1.0;

    static void raise(std::atomic<float>& a, float v)
    {
        if (v > a.load(std::memory_order_relaxed)) a.store(v, std::memory_order_relaxed);
    }
    static float softClip(float x)
    {
        const float a = std::fabs(x);
        if (a <= 0.8f) return x;
        const float y = 0.8f + 0.2f * std::tanh((a - 0.8f) / 0.2f);
        return x < 0.0f ? -y : y;
    }

    /** The arrangement position `sample` frames into the current block (wrapped at the loop end); the playhead itself while stopped. */
    double tickAt(int sample) const
    {
        double t = blockTick + sample * segTps;
        if (regionEndNow > regionStartNow && blockTick < regionEndNow)
        {
            while (t >= regionEndNow) t -= regionEndNow - regionStartNow; // wrapped inside the loop region
            return t;
        }
        if (loopTicksNow > 0.0)
            while (t >= loopTicksNow) t -= loopTicksNow;
        return t;
    }
    /** Gain factor of the slot's volume curve at `tick` (1 without a curve). The curve acts like the fader: value squared. */
    float volumeMul(int s, double tick) const
    {
        const auto* c = slotVolumeAuto[s];
        if (c == nullptr) return 1.0f;
        const float v = autoAt(*c, tick);
        return v * v;
    }

    void push(int offset, int type, int slot, int instrument, int pitch, int velocity, const NoteEvent* note = nullptr)
    {
        if (eventCount >= kMaxEvents) return;
        int i = eventCount++;
        while (i > 0 && events[i - 1].offset > offset) // stable: offs stay before ons at equal offsets
        {
            events[i] = events[i - 1];
            --i;
        }
        events[i] = { offset, type, slot, instrument, pitch, velocity, note != nullptr ? *note : NoteEvent{} };
    }
    void noteOn(int slot, int instrument, int o, int p, int v) override { push(o, 1, std::clamp(slot, 0, kMaxSlots - 1), instrument, p, v); }
    void noteOnEx(int slot, int instrument, int o, const NoteEvent& n) override { push(o, 1, std::clamp(slot, 0, kMaxSlots - 1), instrument, n.pitch, n.velocity, &n); }
    void noteOff(int slot, int o, int p) override { push(o, 0, std::clamp(slot, 0, kMaxSlots - 1), 0, p, 0); }
    void beat(int o, bool downbeat) override { push(o, 2, 0, 0, downbeat ? 1 : 0, 0); }

    void applyPreview(const PreviewMsg& pm, const PlaybackModel* m)
    {
        const int slot = std::clamp(pm.slot, 0, kMaxSlots - 1);
        int instrument = kSynth;
        if (m != nullptr)
            for (const auto& tr : m->tracks)
                if (tr.slot == slot) { instrument = tr.instrument; break; }
        if (pm.on)
        {
            if (instrument == kDrums) slots[slot].drums.trigger(pm.pitch, pm.velocity);
            else if (instrument == kPlugin) addPluginMidi(slot, 0, 0x90, pm.pitch, pm.velocity);
            else if (instrument == kSample)
            {
                const SampleData* d = nullptr;
                bool gate = false;
                if (m != nullptr)
                    for (const auto& tr : m->tracks)
                        if (tr.slot == slot) { d = tr.sample.get(); gate = tr.gate; break; }
                slots[slot].samp.trigger(d, pm.pitch, pm.velocity, gate);
            }
            else slots[slot].synth.noteOn(pm.pitch, pm.velocity);
        }
        else
        {
            slots[slot].synth.noteOff(pm.pitch);
            slots[slot].samp.release(pm.pitch);
            addPluginMidi(slot, 0, 0x80, pm.pitch, 0);
        }
    }

    void renderSegment(int start, int len, const float* targetGain, const float* targetPan, float* localPeak)
    {
        if (len <= 0) return;
        const float segCoef = 1.0f - std::exp(-static_cast<float>(len) * invTau);
        for (int s = 0; s < kMaxSlots; ++s)
        {
            SlotState& st = slots[s];
            if (!st.synth.anyActive() && !st.drums.anyActive() && !st.samp.anyActive() && !plugActive[s])
            {
                st.gain = targetGain[s] * volumeMul(s, segTick); // idle: no ramp needed
                st.filter.reset();
                st.pan = targetPan[s];
                continue;
            }
            float* t = tmp.data();
            juce::FloatVectorOperations::clear(t, len);
            st.synth.render(t, len);
            st.drums.render(t, len);
            const double tickMid = segTick + 0.5 * len * segTps;
            const float autoTarget = targetGain[s] * volumeMul(s, tickMid);
            const bool filtering = slotFilterAuto[s] != nullptr && autoAt(*slotFilterAuto[s], tickMid) < 0.9995f;
            if (filtering) st.filter.set(20.0 * std::pow(1000.0, static_cast<double>(autoAt(*slotFilterAuto[s], tickMid))), sampleRate);
            else if (st.filter.engaged) st.filter.reset();
            if (filtering) st.filter.run(0, t, len);

            st.pan += (targetPan[s] - st.pan) * segCoef;
            const float angle = (st.pan + 1.0f) * 0.78539816f; // 0..pi/2
            const float gl = std::cos(angle) * 1.41421356f;
            const float gr = std::sin(angle) * 1.41421356f;
            float pk = localPeak[s];
            float g = st.gain;
            float* L = bufL.data() + start;
            float* R = bufR.data() + start;
            const bool hasSamples = st.samp.anyActive() || plugActive[s];
            float* sl = sampL.data();
            float* sr = sampR.data();
            if (hasSamples)
            {
                juce::FloatVectorOperations::clear(sl, len);
                juce::FloatVectorOperations::clear(sr, len);
                st.samp.render(sl, sr, len);
                if (plugActive[s])
                {
                    const float* pl = plugL.data() + static_cast<size_t>(s) * plugStride + static_cast<size_t>(start);
                    const float* pr = plugR.data() + static_cast<size_t>(s) * plugStride + static_cast<size_t>(start);
                    for (int i = 0; i < len; ++i) { sl[i] += pl[i]; sr[i] += pr[i]; }
                }
                if (filtering)
                {
                    st.filter.run(1, sl, len);
                    st.filter.run(2, sr, len);
                }
            }
            // Stereo samples keep their width: pan acts as a balance (centre = unchanged). Everything else is panned as before.
            const float p = st.pan;
            const float balL = p > 0.0f ? std::cos(p * 1.57079633f) : 1.0f;
            const float balR = p < 0.0f ? std::cos(-p * 1.57079633f) : 1.0f;
            for (int i = 0; i < len; ++i)
            {
                g += (autoTarget - g) * sampleCoef;
                const float v = t[i] * g;
                float lo = v * gl, ro = v * gr;
                float spk = std::fabs(v);
                if (hasSamples)
                {
                    const float sL = sl[i] * g, sR = sr[i] * g;
                    lo += sL * balL;
                    ro += sR * balR;
                    spk = std::max(spk, std::max(std::fabs(sL), std::fabs(sR)));
                }
                L[i] += lo;
                R[i] += ro;
                pk = std::max(pk, spk);
            }
            st.gain = g;
            localPeak[s] = pk;
        }
        click.renderAdd(bufL.data() + start, bufR.data() + start, len);
    }
};
