#include "rr/network/clock_offset.hpp"

namespace rr::net {

ClockOffsetEstimator::ClockOffsetEstimator(std::size_t window, std::int64_t max_delta_ns)
    : window_(window == 0 ? 1 : window), max_delta_(max_delta_ns) {}

bool ClockOffsetEstimator::add_sample(std::int64_t t1, std::int64_t t2, std::int64_t t3, std::int64_t t4) {
    const std::int64_t delta = (t4 - t1) - (t3 - t2);
    if (t4 < t1 || t3 < t2 || delta < 0 || delta > max_delta_) {
        ++rejected_;
        return false;
    }
    // Integer halves: exact to 1 ns, which is far below anything measured here.
    const std::int64_t theta = ((t2 - t1) + (t3 - t4)) / 2;
    samples_.push_back(Sample{theta, delta});
    if (samples_.size() > window_) {
        samples_.pop_front();
    }
    last_delta_ = delta;
    return true;
}

std::int64_t ClockOffsetEstimator::theta_ns() const noexcept {
    if (samples_.empty()) {
        return 0;
    }
    const Sample* best = &samples_.front();
    for (const Sample& s : samples_) {
        if (s.delta < best->delta) {
            best = &s;
        }
    }
    return best->theta;
}

std::int64_t ClockOffsetEstimator::uncertainty_ns() const noexcept {
    if (samples_.empty()) {
        return -1;
    }
    std::int64_t min_delta = samples_.front().delta;
    for (const Sample& s : samples_) {
        if (s.delta < min_delta) {
            min_delta = s.delta;
        }
    }
    return min_delta / 2;
}

void ClockOffsetEstimator::reset() {
    samples_.clear();
    last_delta_ = -1;
}

}  // namespace rr::net
