#pragma once

// Producer side of the one-way live stream (Stage 7, ADR-017): microphone -> LiveTap (filled by
// the capture callback) -> this media-send thread -> Opus encode -> UDP -> performer.
// Since Stage 8 this is a thin wrapper over LiveEndpoint (one outgoing stream 1, no incoming
// stream); the Stage 7 API and statistics are unchanged, and the Stage 7 tests run against it.
//
// The thread owns the UDP socket, bound to the producer's selected interface and media port.
// It sends audio only to an endpoint it has LEARNED from a valid receiver report whose source
// address is the performer's control-connection address, and stops sending when the performer
// says it is closing or its reports stop for peerTimeoutMs. So the producer never sends to an
// address it was merely told about, and stops on its own when the performer goes away.
//
// The capture callback never waits for this thread: if the thread falls behind, the tap ring
// fills, the callback drops whole blocks (counted), and this thread also trims a backlog
// above 6 frames down to 1 frame (counted) so live latency stays bounded.
// The master recording is unaffected by anything here (separate ring, separate thread).

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rr/audio/LiveTap.h"
#include "rr/media/JitterBuffer.h"
#include "rr/media/LiveEndpoint.h"
#include "rr/media/LiveSettings.h"
#include "rr/media/MediaPacket.h"
#include "rr/media/NetImpairment.h"
#include "rr/media/OpusCodec.h"
#include "rr/network/Socket.h"
#include "rr/shared/Log.h"

struct LiveSenderConfig
{
    std::string bindAddress;          // the producer's selected interface (as for control)
    uint16_t mediaPort = 0;      // control port + 1 by default
    uint32_t sessionId = 0;
    std::string expectedPeerAddress; // the performer's control-connection address
    LiveCodecSettings codec;
    uint32_t peerTimeoutMs = 3000;
    uint32_t maxBacklogFrames = 6;
    ImpairmentSettings testImpairment;  // TEST ONLY (probe --sim-*): never set by the apps
};

struct LiveSenderStats
{
    bool running = false;
    bool sendingEnabled = false;      // the producer's "send my microphone live" switch
    bool streaming = false;            // actually encoding and sending now
    std::string localEndpoint;
    bool peerKnown = false;
    std::string peerEndpoint;
    uint64_t streamsStarted = 0;
    uint64_t framesEncoded = 0;
    uint64_t packetsSent = 0;    // AUDIO datagrams (a test duplicate counts twice); not END_OF_STREAM
    uint64_t bytesSent = 0;      // all datagram bytes (header + payload), not counting IP/UDP
    uint64_t sendErrors = 0;
    uint64_t encodeErrors = 0;
    uint64_t endOfStreamSent = 0;
    uint64_t tapGapFrames = 0;      // capture blocks dropped by the tap (ring full)
    uint64_t backlogTrimFrames = 0; // samples discarded to keep latency bounded
    uint64_t testDropped = 0;        // TEST impairment only
    uint64_t testDuplicated = 0;
    uint64_t testReordered = 0;
    uint64_t reportsReceived = 0;
    uint64_t peerTimeouts = 0;
    InvalidCounts invalid;
    int64_t maxEncodeNs = 0;
    double lastReportAgeMs = -1.0;  // -1 = no report yet
    bool hasReport = false;
    ReceiverReport lastReport;        // the performer's receive counters, as reported
    /** codec facts read back from libopus */
    std::string opus_version;
    std::string application;
    uint32_t frameSamples = 0;
    int bitrateBps = 0;
    int complexity = 0;
    int lookaheadSamples = 0;
    LiveTapStats tap;
};

class LiveSender
{
public:
    explicit LiveSender(Logger* logger = nullptr);
    ~LiveSender();
    LiveSender(const LiveSender&) = delete;
    LiveSender& operator=(const LiveSender&) = delete;

    /** `tap` must outlive the sender (the engine's tap, or a test source's). */
    bool start(const LiveSenderConfig& config, LiveTap& tap, std::string& error);
    void stop();  // sends END_OF_STREAM if streaming
    bool running() const noexcept { return endpoint.isRunning(); }

    void setSending(bool on) noexcept;
    bool isSending() const noexcept { return sending.load(); }

    LiveSenderStats stats() const;

private:
    LiveEndpoint endpoint;
    std::atomic<bool> sending{false};
};

