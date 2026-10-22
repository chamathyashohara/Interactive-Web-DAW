#pragma once

// Network-side receive statistics for one live stream, computed on the media-receive thread
// from sequence numbers, sender sample counters and local arrival times (ADR-017):
//  - loss estimate: expected (highest - first + 1, serial arithmetic) minus unique received;
//    a packet that is merely late or reordered is not counted as lost once it arrives;
//  - duplicates: same sequence number seen again within the last kRestartBack packets (dropped);
//  - restart: a sequence number kRestartBack (64) or more BELOW the highest seen starts a new
//    stream (the sender restarted, e.g. after an app restart). 64 is the jitter buffer's window:
//    a packet that late could never be played anyway (Stage 8, found by run D4b: with the old
//    1024 limit a restarted stream was dropped as "duplicates" for up to 1024 packets);
//  - reordered: arrived with a sequence number below the highest already seen;
//  - inter-arrival jitter: RFC 3550 §6.4.1 estimator J += (|D| - J) / 16, where
//    D = (arrival_j - arrival_i) - (media_j - media_i) / 48 kHz, for consecutive arrivals;
//  - largest gap between two arrivals.
// None of these measure acoustic latency.

#include <bitset>
#include <cstdint>

struct ArrivalSnapshot
{
    uint64_t received = 0;        // unique valid audio packets
    uint64_t duplicates = 0;
    uint64_t reordered = 0;
    uint64_t expected = 0;
    uint64_t lostEstimate = 0;
    uint64_t streamRestarts = 0; // sequence went far backwards: the sender restarted
    double jitterMs = 0.0;
    double maxGapMs = 0.0;
};

class ArrivalStats
{
public:
    static constexpr uint32_t kWindow = 1024;     // bitmap size (>= kRestartBack)
    static constexpr uint32_t kRestartBack = 64;

    enum class Result { New, Duplicate, Restart };

    /**
     * Returns Duplicate for a repeat (caller drops it), Restart when the packet begins a new
     * stream (caller resets the jitter buffer first; the packet itself counts as New).
     */
    Result onPacket(uint32_t seq, uint64_t mediaIndex, int64_t arrivalNs) noexcept;
    void onEndOfStream() noexcept;  // the next packet starts a new stream (not counted as restart)
    ArrivalSnapshot snapshot() const noexcept;

private:
    void begin(uint32_t seq) noexcept;
    bool started = false;
    uint64_t firstExt = 0;
    uint64_t highestExt = 0;
    std::bitset<kWindow> seen;
    bool havePrev = false;
    int64_t prevArrivalNs = 0;
    uint64_t prevMedia = 0;
    double jitterNs = 0.0;
    double maxGapNs = 0.0;
    uint64_t streamReceived = 0;
    uint64_t lostClosed = 0;     // loss from finished streams
    uint64_t expectedClosed = 0;
    ArrivalSnapshot totals;
};

