#include "rr/media/arrival_stats.hpp"

#include <cmath>

#include "rr/media/live_settings.hpp"

namespace rr::media {

void ArrivalStats::begin(std::uint32_t seq) noexcept {
    // Close the previous stream's loss account.
    if (started_) {
        const std::uint64_t expected = highest_ext_ - first_ext_ + 1;
        expected_closed_ += expected;
        lost_closed_ += expected > stream_received_ ? expected - stream_received_ : 0;
    }
    started_ = true;
    // Extended sequence numbers start at 2^32 so a backward step never underflows.
    first_ext_ = (std::uint64_t{1} << 32) + seq;
    highest_ext_ = first_ext_;
    seen_.reset();
    have_prev_ = false;
    stream_received_ = 0;
}

ArrivalStats::Result ArrivalStats::on_packet(std::uint32_t seq, std::uint64_t media_index, std::int64_t arrival_ns) noexcept {
    Result result = Result::New;
    if (!started_) {
        begin(seq);
    } else {
        const auto d = static_cast<std::int32_t>(seq - static_cast<std::uint32_t>(highest_ext_));
        if (d <= -static_cast<std::int32_t>(kRestartBack)) {
            begin(seq);
            ++totals_.stream_restarts;
            result = Result::Restart;
        } else if (d > 0) {
            // Advance: clear the window bits for the skipped numbers.
            const std::uint32_t steps = static_cast<std::uint32_t>(d) < kWindow ? static_cast<std::uint32_t>(d) : kWindow;
            for (std::uint32_t i = 1; i <= steps; ++i) {
                seen_.reset(static_cast<std::size_t>((highest_ext_ + i) % kWindow));
            }
            highest_ext_ += static_cast<std::uint64_t>(d);
        } else {
            const std::uint64_t ext = highest_ext_ - static_cast<std::uint64_t>(-static_cast<std::int64_t>(d));
            if (ext < first_ext_ || seen_.test(static_cast<std::size_t>(ext % kWindow))) {
                ++totals_.duplicates;  // seen before (or older than the stream start)
                return Result::Duplicate;
            }
            if (d < 0) {
                ++totals_.reordered;
            }
        }
    }
    const std::uint64_t ext = highest_ext_ - static_cast<std::uint64_t>(
        -static_cast<std::int64_t>(static_cast<std::int32_t>(seq - static_cast<std::uint32_t>(highest_ext_))));
    seen_.set(static_cast<std::size_t>(ext % kWindow));
    ++stream_received_;
    ++totals_.received;

    // RFC 3550 jitter over consecutive arrivals.
    if (have_prev_) {
        const double arrival_delta = static_cast<double>(arrival_ns - prev_arrival_ns_);
        const double media_delta =
            (static_cast<double>(media_index) - static_cast<double>(prev_media_)) * 1e9 / kLiveSampleRate;
        const double dd = std::fabs(arrival_delta - media_delta);
        jitter_ns_ += (dd - jitter_ns_) / 16.0;
        if (arrival_delta > max_gap_ns_) {
            max_gap_ns_ = arrival_delta;
        }
    }
    have_prev_ = true;
    prev_arrival_ns_ = arrival_ns;
    prev_media_ = media_index;
    return result;
}

void ArrivalStats::on_end_of_stream() noexcept {
    if (started_) {
        const std::uint64_t expected = highest_ext_ - first_ext_ + 1;
        expected_closed_ += expected;
        lost_closed_ += expected > stream_received_ ? expected - stream_received_ : 0;
    }
    started_ = false;
    have_prev_ = false;
}

ArrivalSnapshot ArrivalStats::snapshot() const noexcept {
    ArrivalSnapshot s = totals_;
    std::uint64_t expected = expected_closed_;
    std::uint64_t lost = lost_closed_;
    if (started_) {
        const std::uint64_t e = highest_ext_ - first_ext_ + 1;
        expected += e;
        lost += e > stream_received_ ? e - stream_received_ : 0;
    }
    s.expected = expected;
    s.lost_estimate = lost;
    s.jitter_ms = jitter_ns_ / 1e6;
    s.max_gap_ms = max_gap_ns_ / 1e6;
    return s;
}

}  // namespace rr::media
