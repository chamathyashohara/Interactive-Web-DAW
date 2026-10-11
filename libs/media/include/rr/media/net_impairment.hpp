#pragma once

// TEST ONLY: deliberate packet loss, duplication, reordering and loss bursts on the live media
// path, to show the receiver survives them (Stage 7 acceptance). Off unless a test or the
// probe's --sim-* options turn it on; the apps never enable it. Deterministic for a given seed.

#include <cstdint>

namespace rr::media {

struct ImpairmentSettings {
    double loss_percent = 0.0;       // independent random drops
    double duplicate_percent = 0.0;  // packet sent twice
    double reorder_percent = 0.0;    // packet held back and sent after the next one
    std::uint32_t burst_every = 0;   // every N packets ...
    std::uint32_t burst_length = 0;  // ... drop this many in a row (0 = no bursts)
    std::uint32_t seed = 1;
    bool active() const noexcept {
        return loss_percent > 0.0 || duplicate_percent > 0.0 || reorder_percent > 0.0 ||
               (burst_every > 0 && burst_length > 0);
    }
};

class Impairment {
public:
    enum class Action { Send, Drop, Duplicate, HoldBack };

    explicit Impairment(const ImpairmentSettings& s = {}) : s_(s), state_(s.seed == 0 ? 1u : s.seed) {}
    Action next() noexcept {
        ++count_;
        if (s_.burst_every > 0 && s_.burst_length > 0 && (count_ % s_.burst_every) < s_.burst_length) {
            return Action::Drop;
        }
        if (chance(s_.loss_percent)) {
            return Action::Drop;
        }
        if (chance(s_.duplicate_percent)) {
            return Action::Duplicate;
        }
        if (chance(s_.reorder_percent)) {
            return Action::HoldBack;
        }
        return Action::Send;
    }
    const ImpairmentSettings& settings() const noexcept { return s_; }

private:
    bool chance(double percent) noexcept {
        if (percent <= 0.0) {
            return false;
        }
        // xorshift32
        state_ ^= state_ << 13;
        state_ ^= state_ >> 17;
        state_ ^= state_ << 5;
        return static_cast<double>(state_ % 1000000u) < percent * 10000.0;
    }
    ImpairmentSettings s_;
    std::uint32_t state_;
    std::uint64_t count_ = 0;
};

}  // namespace rr::media
