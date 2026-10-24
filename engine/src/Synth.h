#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

/** Preset parameters for the built-in synth (sent per track by the model; see packages/shared/src/synth.ts). */
struct SynthParams
{
    /** 0 = classic subtractive (saws + sub), 1 = piano (additive, struck), 2 = strings (bowed ensemble with vibrato). */
    int model = 0;
    float attackSec = 0.004f;
    float releaseSec = 0.18f;
    float sawLevel = 0.7f;
    float osc2Level = 0.0f;
    float detuneCents = 0.0f;
    float subLevel = 0.3f;
    float toneHz = 20000.0f;
    float gain = 0.16f;
    /** classic: a plain sine at the played pitch (weight for bass), and soft saturation (0 = off). */
    float sineLevel = 0.0f;
    float drive = 0.0f;
    /** piano: how long the lowest partial rings (seconds, for a middle-register note). */
    float decaySec = 5.0f;
    /** strings: delayed vibrato and bow noise. */
    float vibratoHz = 0.0f;
    float vibratoCents = 0.0f;
    float vibratoDelaySec = 0.0f;
    float noiseLevel = 0.0f;
};

/**
 * Small polyphonic synth with three voice models chosen by the preset: a classic subtractive voice (PolyBLEP saws, a
 * detuned second saw, a sine and a sub, one-pole tone, optional saturation), a piano voice (additive partials that each
 * decay at their own rate, with string inharmonicity and a hammer click) and a strings voice (a bowed-ensemble with
 * delayed vibrato, bow noise and body resonances). Fixed voice pool, no allocation, no locks: safe on the audio thread.
 * Mono output (the mixer pans it). The default params reproduce the original sound exactly.
 */
class Synth
{
public:
    static constexpr int kVoices = 16;
    static constexpr int kPartials = 14;

    void prepare(double sampleRate)
    {
        sr = sampleRate;
        sineTable(); // build the shared sine table here (not on the audio thread)
        for (auto& v : voices)
            v = Voice{};
        recompute();
    }

    /** Sets the preset. Cheap; may be called whenever the model changes. Live notes keep their current sound. */
    void setParams(const SynthParams& p)
    {
        params = p;
        recompute();
    }

    void noteOn(int pitch, int velocity)
    {
        Voice* target = nullptr;
        for (auto& v : voices)
            if (!v.active) { target = &v; break; }
        if (target == nullptr)
        {
            target = &voices[0];
            for (auto& v : voices)
                if (v.age < target->age) target = &v; // steal the oldest
        }
        Voice& v = *target;
        v = Voice{};
        v.active = true;
        v.pitch = pitch;
        v.model = params.model;
        v.age = ++counter;
        v.rng = 0x9E3779B9u ^ static_cast<uint32_t>(v.age * 2654435761ull);
        const float vel = static_cast<float>(velocity) / 127.0f;
        const double freq = 440.0 * std::pow(2.0, (pitch - 69) / 12.0);
        v.inc = static_cast<float>(freq / sr);
        v.inc2 = v.inc * detuneRatio;
        v.gain = params.gain * vel;

        if (v.model == 1) startPiano(v, pitch, vel, freq);
    }

    void noteOff(int pitch)
    {
        for (auto& v : voices)
            if (v.active && !v.releasing && v.pitch == pitch)
                v.releasing = true;
    }

    bool anyActive() const
    {
        for (const auto& v : voices)
            if (v.active) return true;
        return false;
    }

    /** Adds the voices' output into `out`. */
    void render(float* out, int numSamples)
    {
        for (auto& v : voices)
        {
            if (!v.active)
                continue;
            if (v.model == 1) renderPiano(v, out, numSamples);
            else if (v.model == 2) renderStrings(v, out, numSamples);
            else renderClassic(v, out, numSamples);
        }
    }

private:
    struct Voice
    {
        bool active = false;
        bool releasing = false;
        int model = 0;
        int pitch = 0;
        float phase = 0, phase2 = 0, subPhase = 0, inc = 0, inc2 = 0, env = 0, gain = 0, lp = 0;
        // piano
        int partials = 0;
        float pPhase[kPartials] = {}, pMul[kPartials] = {}, pLevel[kPartials] = {}, pDecay[kPartials] = {};
        float hammer = 0, hammerLp = 0;
        // strings
        float vibPhase = 0, vibAge = 0;
        float f1a = 0, f1b = 0, f2a = 0, f2b = 0, f3a = 0, f3b = 0; // resonator states
        float noiseLp = 0;
        uint32_t rng = 1;
        unsigned long long age = 0;
    };

    struct Resonator
    {
        float a1 = 0, a2 = 0, a3 = 0;
        void set(double hz, double q, double sr)
        {
            const double g = std::tan(3.14159265358979 * hz / sr), k = 1.0 / q;
            a1 = static_cast<float>(1.0 / (1.0 + g * (g + k)));
            a2 = static_cast<float>(g) * a1;
            a3 = static_cast<float>(g) * a2;
        }
        /** Band-pass output of a TPT state-variable filter. */
        float run(float x, float& ic1, float& ic2) const
        {
            const float v3 = x - ic2;
            const float v1 = a1 * ic1 + a2 * v3;
            const float v2 = ic2 + a2 * ic1 + a3 * v3;
            ic1 = 2.0f * v1 - ic1;
            ic2 = 2.0f * v2 - ic2;
            return v1;
        }
    };

    // ---- shared helpers ----
    static const std::array<float, 4097>& sineTable()
    {
        static const std::array<float, 4097> t = [] {
            std::array<float, 4097> a{};
            for (int i = 0; i <= 4096; ++i) a[static_cast<size_t>(i)] = static_cast<float>(std::sin(6.283185307179586 * i / 4096.0));
            return a;
        }();
        return t;
    }
    static float sinLookup(float phase) // phase in [0,1)
    {
        const auto& t = sineTable();
        const float x = phase * 4096.0f;
        const int i = static_cast<int>(x);
        const float f = x - static_cast<float>(i);
        return t[static_cast<size_t>(i & 4095)] + f * (t[static_cast<size_t>((i & 4095) + 1)] - t[static_cast<size_t>(i & 4095)]);
    }
    static float noise(uint32_t& s)
    {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5; // xorshift32
        return static_cast<float>(static_cast<int32_t>(s)) * (1.0f / 2147483648.0f);
    }
    static float polyBlep(float t, float dt)
    {
        if (t < dt) { t /= dt; return t + t - t * t - 1.0f; }
        if (t > 1.0f - dt) { t = (t - 1.0f) / dt; return t * t + t + t + 1.0f; }
        return 0.0f;
    }

    void recompute()
    {
        attackInc = 1.0f / static_cast<float>(std::max(0.0005, static_cast<double>(params.attackSec)) * sr);
        releaseDec = 1.0f / static_cast<float>(std::max(0.005, static_cast<double>(params.releaseSec)) * sr);
        detuneRatio = std::pow(2.0f, params.detuneCents / 1200.0f);
        const float c = 1.0f - std::exp(-6.2831853f * params.toneHz / static_cast<float>(sr));
        toneCoef = c < 0.0f ? 0.0f : (c > 1.0f ? 1.0f : c);
        driveNorm = params.drive > 0.01f ? 1.0f / std::tanh(params.drive) : 1.0f;
        // violin-like body resonances (typical violin air/wood modes): about 300, 700 and 2800 Hz
        res1.set(450.0, 3.5, sr);
        res2.set(1500.0, 4.0, sr);
        res3.set(3200.0, 3.0, sr);
    }

    /** Advances the attack/release envelope one sample; returns false when the voice has finished. */
    bool stepEnv(Voice& v)
    {
        if (v.releasing)
        {
            v.env -= releaseDec;
            if (v.env <= 0.0f) { v.active = false; return false; }
        }
        else if (v.env < 1.0f)
        {
            v.env += attackInc;
            if (v.env > 1.0f) v.env = 1.0f;
        }
        return true;
    }

    // ---- classic subtractive ----
    void renderClassic(Voice& v, float* out, int numSamples)
    {
        const bool useOsc2 = params.osc2Level > 0.0001f;
        const bool useSine = params.sineLevel > 0.0001f;
        for (int i = 0; i < numSamples; ++i)
        {
            if (!stepEnv(v)) return;
            float raw = params.sawLevel * (2.0f * v.phase - 1.0f - polyBlep(v.phase, v.inc));
            if (useOsc2) raw += params.osc2Level * (2.0f * v.phase2 - 1.0f - polyBlep(v.phase2, v.inc2));
            if (useSine) raw += params.sineLevel * sinLookup(v.phase);
            raw += params.subLevel * sinLookup(v.subPhase);
            v.lp += toneCoef * (raw - v.lp); // one-pole tone filter
            float x = v.lp;
            if (params.drive > 0.01f) x = std::tanh(params.drive * x) * driveNorm * 0.55f; // soft saturation keeps low notes audible on small speakers
            out[i] += x * v.env * v.gain;

            v.phase += v.inc;
            if (v.phase >= 1.0f) v.phase -= 1.0f;
            if (useOsc2)
            {
                v.phase2 += v.inc2;
                if (v.phase2 >= 1.0f) v.phase2 -= 1.0f;
            }
            v.subPhase += v.inc * 0.5f;
            if (v.subPhase >= 1.0f) v.subPhase -= 1.0f;
        }
    }

    // ---- piano: additive partials with their own decays ----
    void startPiano(Voice& v, int pitch, float vel, double freq)
    {
        const double B = 0.00035; // string stiffness: upper partials sit slightly sharp
        float sum = 0.0f;
        const float bright = 0.4f + 0.6f * vel; // harder playing = brighter
        int n = 0;
        for (int k = 1; k <= kPartials; ++k)
        {
            const double f = freq * k * std::sqrt(1.0 + B * k * k);
            if (f > 0.45 * sr) break;
            v.pMul[n] = static_cast<float>(f / freq);
            float a = 1.0f / std::pow(static_cast<float>(k), 0.95f);
            a *= std::pow(bright, 0.35f * static_cast<float>(k - 1));
            if (k == 2) a *= 1.15f; // a touch of body in the second partial
            v.pLevel[n] = a;
            sum += a;
            // low notes ring much longer than high ones; upper partials die faster than the fundamental
            const float base = std::max(0.5f, params.decaySec * std::pow(2.0f, -static_cast<float>(pitch - 60) / 16.0f));
            const float tau = base / (1.0f + 0.7f * static_cast<float>(k - 1));
            v.pDecay[n] = std::exp(-1.0f / (tau * static_cast<float>(sr)));
            ++n;
        }
        v.partials = n;
        const float norm = sum > 0.0f ? 1.6f / sum : 1.0f;
        for (int k = 0; k < n; ++k) v.pLevel[k] *= norm;
        v.hammer = 0.55f * vel; // strike noise burst, fades in a few ms
        v.env = 1.0f;           // the strike is instant; only the release shapes the end
    }

    void renderPiano(Voice& v, float* out, int numSamples)
    {
        const float hammerDecay = std::exp(-1.0f / (0.006f * static_cast<float>(sr)));
        const float rel = 1.0f / (0.28f * static_cast<float>(sr)); // damper: a quick fade when the key is released
        for (int i = 0; i < numSamples; ++i)
        {
            if (v.releasing)
            {
                v.env -= rel;
                if (v.env <= 0.0f) { v.active = false; return; }
            }
            float s = 0.0f;
            for (int k = 0; k < v.partials; ++k)
            {
                s += v.pLevel[k] * sinLookup(v.pPhase[k]);
                v.pPhase[k] += v.inc * v.pMul[k];
                if (v.pPhase[k] >= 1.0f) v.pPhase[k] -= 1.0f;
                v.pLevel[k] *= v.pDecay[k];
            }
            if (v.hammer > 0.0005f)
            {
                v.hammerLp += 0.35f * (noise(v.rng) - v.hammerLp);
                s += v.hammer * v.hammerLp;
                v.hammer *= hammerDecay;
            }
            out[i] += s * v.env * v.gain;
            if (!v.releasing && v.pLevel[0] < 1.0e-5f) { v.active = false; return; } // fully rung out
        }
    }

    // ---- strings: a bowed ensemble ----
    void renderStrings(Voice& v, float* out, int numSamples)
    {
        const float vibRate = params.vibratoHz / static_cast<float>(sr);
        const float vibDelay = std::max(1.0f, params.vibratoDelaySec * static_cast<float>(sr));
        for (int i = 0; i < numSamples; ++i)
        {
            if (!stepEnv(v)) return;
            // vibrato fades in after a short delay, like a player settling into the note
            v.vibAge += 1.0f;
            const float depth = params.vibratoCents * std::min(1.0f, v.vibAge / vibDelay);
            const float vib = 1.0f + depth * 0.000578f * sinLookup(v.vibPhase);
            v.vibPhase += vibRate;
            if (v.vibPhase >= 1.0f) v.vibPhase -= 1.0f;

            const float inc1 = v.inc * vib, inc2 = v.inc2 * vib;
            float bow = params.sawLevel * (2.0f * v.phase - 1.0f - polyBlep(v.phase, inc1))
                      + params.osc2Level * (2.0f * v.phase2 - 1.0f - polyBlep(v.phase2, inc2));
            v.noiseLp += 0.25f * (noise(v.rng) - v.noiseLp);
            bow += params.noiseLevel * v.noiseLp; // bow rasp
            v.lp += toneCoef * (bow - v.lp);
            // the instrument body shapes it: three resonances plus the filtered bow
            const float body = 0.6f * res1.run(bow, v.f1a, v.f1b) + 0.5f * res2.run(bow, v.f2a, v.f2b) + 0.3f * res3.run(bow, v.f3a, v.f3b);
            out[i] += (0.55f * v.lp + 0.55f * body) * v.env * v.gain;

            v.phase += inc1;
            if (v.phase >= 1.0f) v.phase -= 1.0f;
            v.phase2 += inc2;
            if (v.phase2 >= 1.0f) v.phase2 -= 1.0f;
        }
    }

    Voice voices[kVoices];
    SynthParams params;
    Resonator res1, res2, res3;
    double sr = 48000.0;
    float attackInc = 0.01f, releaseDec = 0.001f, detuneRatio = 1.0f, toneCoef = 1.0f, driveNorm = 1.0f;
    unsigned long long counter = 0;
};
