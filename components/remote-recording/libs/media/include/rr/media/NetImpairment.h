#pragma once

// TEST ONLY: deliberate packet loss, duplication, reordering and loss bursts on the live media
// path, to show the receiver survives them (Stage 7 acceptance). Off unless a test or the
// probe's --sim-* options turn it on; the apps never enable it. Deterministic for a given seed.

#include <cstdint>

struct ImpairmentSettings
{
    double lossPercent = 0.0;       // independent random drops
    double duplicatePercent = 0.0;  // packet sent twice
    double reorderPercent = 0.0;    // packet held back and sent after the next one
    uint32_t burstEvery = 0;   // every N packets ...
    uint32_t burstLength = 0;  // ... drop this many in a row (0 = no bursts)
    uint32_t seed = 1;
    bool active() const noexcept
    {
        return lossPercent > 0.0 || duplicatePercent > 0.0 || reorderPercent > 0.0 ||
               (burstEvery > 0 && burstLength > 0);
    }
};

class Impairment
{
public:
    enum class Action { Send, Drop, Duplicate, HoldBack };

    explicit Impairment(const ImpairmentSettings& s = {}) : s(s), state(s.seed == 0 ? 1u : s.seed) {}
    Action next() noexcept
    {
        ++count;
        if (s.burstEvery > 0 && s.burstLength > 0 && (count % s.burstEvery) < s.burstLength)
        {
            return Action::Drop;
        }
        if (chance(s.lossPercent))
        {
            return Action::Drop;
        }
        if (chance(s.duplicatePercent))
        {
            return Action::Duplicate;
        }
        if (chance(s.reorderPercent))
        {
            return Action::HoldBack;
        }
        return Action::Send;
    }
    const ImpairmentSettings& settings() const noexcept { return s; }

private:
    bool chance(double percent) noexcept
    {
        if (percent <= 0.0)
        {
            return false;
        }
        // xorshift32
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        return static_cast<double>(state % 1000000u) < percent * 10000.0;
    }
    ImpairmentSettings s;
    uint32_t state;
    uint64_t count = 0;
};

