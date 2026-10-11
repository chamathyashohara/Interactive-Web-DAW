#pragma once

// Network-side receive statistics for one live stream, computed on the media-receive thread
// from sequence numbers, sender sample counters and local arrival times (ADR-017):
//  - loss estimate: expected (highest - first + 1, serial arithmetic) minus unique received;
//    a packet that is merely late or reordered is not counted as lost once it arrives;
//  - duplicates: same sequence number seen again within the last kWindow packets (dropped);
//  - reordered: arrived with a sequence number below the highest already seen;
//  - inter-arrival jitter: RFC 3550 §6.4.1 estimator J += (|D| - J) / 16, where
//    D = (arrival_j - arrival_i) - (media_j - media_i) / 48 kHz, for consecutive arrivals;
//  - largest gap between two arrivals.
// None of these measure acoustic latency.

#include <bitset>
#include <cstdint>

namespace rr::media {

struct ArrivalSnapshot {
    std::uint64_t received = 0;        // unique valid audio packets
    std::uint64_t duplicates = 0;
    std::uint64_t reordered = 0;
    std::uint64_t expected = 0;
    std::uint64_t lost_estimate = 0;
    std::uint64_t stream_restarts = 0; // sequence went far backwards: the sender restarted
    double jitter_ms = 0.0;
    double max_gap_ms = 0.0;
};

class ArrivalStats {
public:
    static constexpr std::uint32_t kWindow = 1024;

    enum class Result { New, Duplicate, Restart };

    // Returns Duplicate for a repeat (caller drops it), Restart when the packet begins a new
    // stream (caller resets the jitter buffer first; the packet itself counts as New).
    Result on_packet(std::uint32_t seq, std::uint64_t media_index, std::int64_t arrival_ns) noexcept;
    void on_end_of_stream() noexcept;  // the next packet starts a new stream (not counted as restart)
    ArrivalSnapshot snapshot() const noexcept;

private:
    void begin(std::uint32_t seq) noexcept;
    bool started_ = false;
    std::uint64_t first_ext_ = 0;
    std::uint64_t highest_ext_ = 0;
    std::bitset<kWindow> seen_;
    bool have_prev_ = false;
    std::int64_t prev_arrival_ns_ = 0;
    std::uint64_t prev_media_ = 0;
    double jitter_ns_ = 0.0;
    double max_gap_ns_ = 0.0;
    std::uint64_t stream_received_ = 0;
    std::uint64_t lost_closed_ = 0;     // loss from finished streams
    std::uint64_t expected_closed_ = 0;
    ArrivalSnapshot totals_;
};

}  // namespace rr::media
