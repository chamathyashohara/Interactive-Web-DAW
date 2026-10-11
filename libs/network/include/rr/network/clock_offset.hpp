#pragma once

#include <cstdint>
#include <deque>

namespace rr::net {

// Four-timestamp offset estimation (ADR-010, SYSTEM_ARCHITECTURE §4).
//   t1 requester send, t2 responder receive, t3 responder send, t4 requester receive
//   delta = (t4 - t1) - (t3 - t2)            round trip excluding the responder's work
//   theta = ((t2 - t1) + (t3 - t4)) / 2      estimate of (responder clock - requester clock)
// The estimate reported is theta of the sample with the smallest delta among the last
// `window`; its uncertainty is delta_min / 2 (the true offset lies within theta +/- u if the
// timestamps are exact, whatever the path asymmetry).
//
// In Stage 6 the samples come from TCP heartbeats stamped on the control thread, so delta
// includes TCP and thread-scheduling time: the uncertainty is reported as it is, not hidden.
class ClockOffsetEstimator {
public:
    explicit ClockOffsetEstimator(std::size_t window = 16, std::int64_t max_delta_ns = 100'000'000);

    // Returns false (and ignores the sample) if it is inconsistent or delta exceeds the limit.
    bool add_sample(std::int64_t t1, std::int64_t t2, std::int64_t t3, std::int64_t t4);

    bool has_estimate() const noexcept { return !samples_.empty(); }
    std::size_t sample_count() const noexcept { return samples_.size(); }
    std::int64_t theta_ns() const noexcept;        // responder - requester
    std::int64_t uncertainty_ns() const noexcept;  // delta_min / 2
    std::int64_t last_delta_ns() const noexcept { return last_delta_; }
    std::uint64_t rejected() const noexcept { return rejected_; }
    void reset();

private:
    struct Sample {
        std::int64_t theta;
        std::int64_t delta;
    };
    std::size_t window_;
    std::int64_t max_delta_;
    std::deque<Sample> samples_;
    std::int64_t last_delta_ = -1;
    std::uint64_t rejected_ = 0;
};

}  // namespace rr::net
