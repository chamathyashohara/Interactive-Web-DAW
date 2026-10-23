#pragma once

// One side's live media endpoint (Stage 8, ADR-018): ONE UDP socket and ONE media thread carrying
// up to one outgoing and one incoming stream. Both directions share the producer's media port,
// so the performer PC still needs no inbound firewall rule.
//
//   producer: socket bound to its selected interface : media port; sends stream 1, receives stream 2
//   performer: socket connected to producer : media port;          sends stream 2, receives stream 1
//
// Peer handling:
//  - producer: the performer's endpoint is LEARNED from any valid datagram whose source IP is the
//    performer's control-connection address (never from a claim inside a packet);
//  - performer: the peer is fixed (the connected socket only delivers the producer's datagrams).
//  - The peer is "reachable" while a valid datagram arrived within peerTimeoutMs, OR while the
//    session's control link reports Connected (setControlLinkUp). So one direction can fail
//    completely while the other keeps sending, as long as the control channel is up
//    (asymmetric failure, Stage 8 task 5). A "closing" report from the peer stops sending at once.
// Whoever receives a stream reports on it every 500 ms (RECEIVER_REPORT with that stream's id).
// Directions are strict: AUDIO/END_OF_STREAM must carry the incoming stream id and reports the
// outgoing stream id; anything else is dropped and counted as `wrongStream` (for example this
// side's own stream coming back).

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "rr/audio/LiveTap.h"
#include "rr/media/IncomingStream.h"
#include "rr/media/MediaPacket.h"
#include "rr/media/OutgoingStream.h"
#include "rr/network/Socket.h"
#include "rr/shared/Log.h"

struct LiveEndpointConfig
{
    bool bindMode = true;              // true: producer (bind + learn); false: performer (connect)
    std::string localAddress;          // bindMode: the selected interface
    std::string peerAddress;           // bindMode: expected performer IP; else: producer host
    uint16_t mediaPort = 0;       // the producer's media port (control port + 1)
    uint32_t sessionId = 0;
    bool hasOutgoing = false;
    OutgoingConfig outgoing;
    bool hasIncoming = false;
    IncomingConfig incoming;
    uint32_t peerTimeoutMs = 3000;
    uint32_t reportIntervalMs = 500;
};

struct EndpointStats
{
    bool running = false;
    std::string localEndpoint;
    bool peerKnown = false;            // producer: an endpoint was learned; performer: always
    std::string peerEndpoint;
    bool peerReachable = false;        // what gates sending (see above)
    bool peerHeard = false;            // a valid datagram within peerTimeoutMs
    bool peerClosed = false;           // the peer said it stopped (closing report)
    bool controlLinkUp = false;
    double lastRxAgeMs = -1.0;
    uint64_t peerTimeouts = 0;
    uint64_t reportsSent = 0;
    uint64_t reportSendErrors = 0;
    uint64_t reportsReceived = 0;
    uint64_t testBlackholed = 0;  // TEST ONLY: datagrams dropped by the receive blackhole
    InvalidCounts invalid;
    bool hasRemoteReport = false;     // the peer's report about OUR outgoing stream
    ReceiverReport remoteReport;
    double remoteReportAgeMs = -1.0;
};

class LiveEndpoint
{
public:
    explicit LiveEndpoint(Logger* logger = nullptr);
    ~LiveEndpoint();
    LiveEndpoint(const LiveEndpoint&) = delete;
    LiveEndpoint& operator=(const LiveEndpoint&) = delete;

    /** `tap` is required when config.hasOutgoing (and must outlive the endpoint). */
    bool start(const LiveEndpointConfig& config, LiveTap* tap, std::string& error);
    /**
     * Ends the outgoing stream (END_OF_STREAM), sends closing reports, joins the thread.
     * Detach the incoming stream from the audio engine BEFORE calling this.
     */
    void stop();
    bool isRunning() const noexcept { return running.load(); }

    /** The streams exist from start() until the next start(); null if not configured. */
    OutgoingStream* getOutgoing() noexcept { return outgoing.get(); }
    IncomingStream* getIncoming() noexcept { return incoming.get(); }
    const OutgoingStream* getOutgoing() const noexcept { return outgoing.get(); }
    const IncomingStream* getIncoming() const noexcept { return incoming.get(); }

    void setControlLinkUp(bool up) noexcept { controlUp.store(up); }
    /** TEST ONLY: drop every received datagram before any check (one direction fails completely). */
    void setTestReceiveBlackhole(bool on) noexcept { blackhole.store(on); }
    EndpointStats stats() const;
    const LiveEndpointConfig& config() const noexcept { return cfg; }

private:
    void threadMain();
    void handle(const uint8_t* data, long size, const Endpoint& from, int64_t now);
    bool sendDatagram(const uint8_t* d, size_t n);
    void sendReport(bool closing);
    bool reachable(int64_t now);

    Logger* log;
    LiveEndpointConfig cfg;
    UdpSocket socket;
    Endpoint expectedPeer;  // bindMode: IP only
    std::unique_ptr<OutgoingStream> outgoing;
    std::unique_ptr<IncomingStream> incoming;
    std::thread thread;
    std::atomic<bool> running{false};
    std::atomic<bool> stopRequested{false};
    std::atomic<bool> controlUp{false};
    std::atomic<bool> blackhole{false};

    mutable std::mutex mutex;  // guards the fields below
    bool peerKnown = false;
    Endpoint peer;
    bool peerClosed = false;
    bool wasHeard = false;
    int64_t lastRxNs = 0;
    uint64_t peerTimeouts = 0;
    uint64_t reportsSent = 0;
    uint64_t reportErrors = 0;
    uint64_t reportsReceived = 0;
    uint64_t blackholed = 0;
    uint32_t reportSeq = 0;
    InvalidCounts invalid;
    bool hasRemoteReport = false;
    ReceiverReport remoteReport;
    int64_t remoteReportNs = 0;
};

