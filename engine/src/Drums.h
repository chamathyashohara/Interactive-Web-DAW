#pragma once
#include <cmath>
#include <cstdint>

/**
 * Synthesised drum kit (no samples, so nothing to license). One-shot voices, fixed pool, no allocation.
 * General-MIDI-style layout: 36 kick, 38 snare, 39 clap, 42 closed hat, 46 open hat, 41/43/45/47 toms.
 * Any other pitch plays a short pitched blip so every piano-roll row makes a sound.
 * Note-off is ignored (drums are one-shots).
 */
class DrumKit
{
public:
    static constexpr int kVoices = 16;

    void prepare(double sampleRate)
    {
        sr = sampleRate;
        for (auto& v : voices)
            v = Voice{};
    }

    void trigger(int pitch, int velocity)
    {
        Voice* target = nullptr;
        for (auto& v : voices)
            if (!v.active) { target = &v; break; }
        if (target == nullptr)
        {
            target = &voices[0];
            for (auto& v : voices)
                if (v.age < target->age) target = &v;
        }
        *target = Voice{};
        target->active = true;
        target->kind = kindFor(pitch);
        target->pitch = pitch;
        target->amp = 0.55f * static_cast<float>(velocity) / 127.0f;
        target->age = ++counter;
        target->rng = 0x9E3779B9u * static_cast<uint32_t>(counter) + static_cast<uint32_t>(pitch) * 0x85EBCA6Bu + 1u;
        switch (pitch)
        {
            case 41: target->f0 = 90.0f; break;
            case 43: target->f0 = 115.0f; break;
            case 45: target->f0 = 140.0f; break;
            case 47: target->f0 = 170.0f; break;
            default: target->f0 = static_cast<float>(440.0 * std::pow(2.0, (pitch - 69) / 12.0)); break;
        }
    }

    bool anyActive() const
    {
        for (const auto& v : voices)
            if (v.active) return true;
        return false;
    }

    void render(float* out, int numSamples)
    {
        const float fs = static_cast<float>(sr);
        for (auto& v : voices)
        {
            if (!v.active)
                continue;
            for (int i = 0; i < numSamples; ++i)
            {
                const float t = static_cast<float>(v.n++) / fs; // seconds since trigger
                float s = 0.0f;
                float end = 0.5f;
                switch (v.kind)
                {
                    case Kick: {
                        const float f = 45.0f + 110.0f * std::exp(-t / 0.035f);
                        v.phase += f / fs;
                        s = std::sin(6.2831853f * v.phase) * std::exp(-t / 0.16f) + 0.25f * noiseOf(v) * std::exp(-t / 0.004f);
                        end = 0.6f;
                        break;
                    }
                    case Snare: {
                        v.phase += 185.0f / fs;
                        s = 0.55f * noiseOf(v) * std::exp(-t / 0.085f) + 0.45f * std::sin(6.2831853f * v.phase) * std::exp(-t / 0.05f);
                        end = 0.4f;
                        break;
                    }
                    case Clap: {
                        const float burst = (t < 0.010f ? 1.0f : t < 0.020f ? 0.8f : t < 0.030f ? 0.9f : 0.0f);
                        s = noiseOf(v) * (burst * std::exp(-std::fmod(t, 0.010f) / 0.006f) + 0.5f * std::exp(-t / 0.08f));
                        s *= 0.7f;
                        end = 0.4f;
                        break;
                    }
                    case ClosedHat:
                    case OpenHat: {
                        const float n = noiseOf(v);
                        const float hp = n - v.last; // crude high-pass
                        v.last = n;
                        s = hp * 0.7f * std::exp(-t / (v.kind == ClosedHat ? 0.018f : 0.14f));
                        end = v.kind == ClosedHat ? 0.15f : 0.7f;
                        break;
                    }
                    case Tom: {
                        v.phase += (v.f0 * (0.65f + 0.35f * std::exp(-t / 0.08f))) / fs;
                        s = std::sin(6.2831853f * v.phase) * std::exp(-t / 0.2f);
                        end = 0.7f;
                        break;
                    }
                    default: { // pitched blip
                        v.phase += v.f0 / fs;
                        s = std::sin(6.2831853f * v.phase) * std::exp(-t / 0.07f);
                        end = 0.3f;
                        break;
                    }
                }
                out[i] += s * v.amp;
                if (t > end) { v.active = false; break; }
            }
        }
    }

private:
    enum Kind { Kick, Snare, Clap, ClosedHat, OpenHat, Tom, Blip };
    struct Voice
    {
        bool active = false;
        Kind kind = Blip;
        int pitch = 0;
        float phase = 0, f0 = 200, amp = 0.5f, last = 0;
        int64_t n = 0;
        uint32_t rng = 1; // per-voice noise: output must not depend on how audio is split into blocks
        unsigned long long age = 0;
    };

    static Kind kindFor(int pitch)
    {
        switch (pitch)
        {
            case 35: case 36: return Kick;
            case 37: case 38: case 40: return Snare;
            case 39: return Clap;
            case 42: case 44: return ClosedHat;
            case 46: return OpenHat;
            case 41: case 43: case 45: case 47: return Tom;
            default: return Blip;
        }
    }

    static float noiseOf(Voice& v)
    {
        v.rng ^= v.rng << 13;
        v.rng ^= v.rng >> 17;
        v.rng ^= v.rng << 5;
        return static_cast<float>(static_cast<int32_t>(v.rng)) / 2147483648.0f;
    }

    Voice voices[kVoices];
    double sr = 48000.0;
    unsigned long long counter = 0;
};
