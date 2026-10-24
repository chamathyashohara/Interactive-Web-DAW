#pragma once
#include <cmath>

/**
 * Small polyphonic PolyBLEP saw + sub-sine synth. Fixed voice pool, no allocation, no locks:
 * safe on the audio thread. Mono output (the mixer pans it). Voice-major rendering so idle voices cost nothing.
 */
class Synth
{
public:
    static constexpr int kVoices = 16;

    void prepare(double sampleRate)
    {
        sr = sampleRate;
        attackInc = 1.0f / static_cast<float>(0.004 * sr);
        releaseDec = 1.0f / static_cast<float>(0.18 * sr);
        for (auto& v : voices)
            v = Voice{};
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
        target->subPhase = 0.0f;
        target->env = 0.0f;
        target->gain = 0.16f * static_cast<float>(velocity) / 127.0f;
        target->inc = static_cast<float>(440.0 * std::pow(2.0, (pitch - 69) / 12.0) / sr);
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

                const float saw = 2.0f * v.phase - 1.0f - polyBlep(v.phase, v.inc);
                const float sub = std::sin(6.2831853f * v.subPhase);
                out[i] += (0.7f * saw + 0.3f * sub) * v.env * v.gain;

                v.phase += v.inc;
                if (v.phase >= 1.0f) v.phase -= 1.0f;
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
        float phase = 0, subPhase = 0, inc = 0, env = 0, gain = 0;
        unsigned long long age = 0;
    };

    static float polyBlep(float t, float dt)
    {
        if (t < dt) { t /= dt; return t + t - t * t - 1.0f; }
        if (t > 1.0f - dt) { t = (t - 1.0f) / dt; return t * t + t + t + 1.0f; }
        return 0.0f;
    }

    Voice voices[kVoices];
    double sr = 48000.0;
    float attackInc = 0.01f, releaseDec = 0.001f;
    unsigned long long counter = 0;
};
