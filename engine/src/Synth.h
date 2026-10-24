#pragma once
#include <cmath>

/** Preset parameters for the built-in synth (sent per track by the model; see packages/shared/src/synth.ts). */
struct SynthParams
{
    float attackSec = 0.004f;
    float releaseSec = 0.18f;
    float sawLevel = 0.7f;
    float osc2Level = 0.0f;
    float detuneCents = 0.0f;
    float subLevel = 0.3f;
    float toneHz = 20000.0f;
    float gain = 0.16f;
};

/**
 * Small polyphonic PolyBLEP synth: a main saw, an optional detuned second saw, and a sub sine, through an attack/release
 * envelope and a one-pole tone filter. A preset (SynthParams) sets the sound. Fixed voice pool, no allocation, no locks:
 * safe on the audio thread. Mono output (the mixer pans it). The default params reproduce the original sound exactly.
 */
class Synth
{
public:
    static constexpr int kVoices = 16;

    void prepare(double sampleRate)
    {
        sr = sampleRate;
        for (auto& v : voices)
            v = Voice{};
        recompute();
    }

    /** Sets the preset. Cheap; may be called whenever the model changes. Live notes keep their current envelope rates. */
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
        target->active = true;
        target->releasing = false;
        target->pitch = pitch;
        target->phase = 0.0f;
        target->phase2 = 0.0f;
        target->subPhase = 0.0f;
        target->env = 0.0f;
        target->lp = 0.0f;
        target->gain = params.gain * static_cast<float>(velocity) / 127.0f;
        target->inc = static_cast<float>(440.0 * std::pow(2.0, (pitch - 69) / 12.0) / sr);
        target->inc2 = target->inc * detuneRatio;
        target->age = ++counter;
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
        const bool useOsc2 = params.osc2Level > 0.0001f;
        for (auto& v : voices)
        {
            if (!v.active)
                continue;
            for (int i = 0; i < numSamples; ++i)
            {
                if (v.releasing)
                {
                    v.env -= releaseDec;
                    if (v.env <= 0.0f) { v.active = false; break; }
                }
                else if (v.env < 1.0f)
                {
                    v.env += attackInc;
                    if (v.env > 1.0f) v.env = 1.0f;
                }

                float raw = params.sawLevel * (2.0f * v.phase - 1.0f - polyBlep(v.phase, v.inc));
                if (useOsc2)
                    raw += params.osc2Level * (2.0f * v.phase2 - 1.0f - polyBlep(v.phase2, v.inc2));
                raw += params.subLevel * std::sin(6.2831853f * v.subPhase);

                v.lp += toneCoef * (raw - v.lp); // one-pole tone filter
                out[i] += v.lp * v.env * v.gain;

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
    }

private:
    struct Voice
    {
        bool active = false;
        bool releasing = false;
        int pitch = 0;
        float phase = 0, phase2 = 0, subPhase = 0, inc = 0, inc2 = 0, env = 0, gain = 0, lp = 0;
        unsigned long long age = 0;
    };

    void recompute()
    {
        attackInc = 1.0f / static_cast<float>(std::max(0.0005, static_cast<double>(params.attackSec)) * sr);
        releaseDec = 1.0f / static_cast<float>(std::max(0.005, static_cast<double>(params.releaseSec)) * sr);
        detuneRatio = std::pow(2.0f, params.detuneCents / 1200.0f);
        const float c = 1.0f - std::exp(-6.2831853f * params.toneHz / static_cast<float>(sr));
        toneCoef = c < 0.0f ? 0.0f : (c > 1.0f ? 1.0f : c);
    }

    static float polyBlep(float t, float dt)
    {
        if (t < dt) { t /= dt; return t + t - t * t - 1.0f; }
        if (t > 1.0f - dt) { t = (t - 1.0f) / dt; return t * t + t + t + 1.0f; }
        return 0.0f;
    }

    Voice voices[kVoices];
    SynthParams params;
    double sr = 48000.0;
    float attackInc = 0.01f, releaseDec = 0.001f, detuneRatio = 1.0f, toneCoef = 1.0f;
    unsigned long long counter = 0;
};
