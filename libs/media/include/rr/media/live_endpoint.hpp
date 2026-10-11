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
//  - The peer is "reachable" while a valid datagram arrived within peer_timeout_ms, OR while the
//    session's control link reports Connected (set_control_link_up). So one direction can fail
//    completely while the other keeps sending, as long as the control channel is up
//    (asymmetric failure, Stage 8 task 5). A "closing" report from the peer stops sending at once.
// Whoever receives a stream reports on it every 500 ms (RECEIVER_REPORT with that stream's id).
// Directions are strict: AUDIO/END_OF_STREAM must carry the incoming stream id and reports the
// outgoing stream id; anything else is dropped and counted as `wrong_stream` (for example this
// side's own stream coming back).

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "rr/audio/live_tap.hpp"
#include "rr/media/incoming_stream.hpp"
#include "rr/media/media_packet.hpp"
#include "rr/media/outgoing_stream.hpp"
#include "rr/network/socket.hpp"
#include "rr/shared/log.hpp"

namespace rr::media {

struct LiveEndpointConfig {
    bool bind_mode = true;              // true: producer (bind + learn); false: performer (connect)
    std::string local_address;          // bind_mode: the selected interface
    std::string peer_address;           // bind_mode: expected performer IP; else: producer host
    std::uint16_t media_port = 0;       // the producer's media port (control port + 1)
    std::uint32_t session_id = 0;
    bool has_outgoing = false;
    OutgoingConfig outgoing;
    bool has_incoming = false;
    IncomingConfig incoming;
    std::uint32_t peer_timeout_ms = 3000;
    std::uint32_t report_interval_ms = 500;
};

struct EndpointStats {
    bool running = false;
    std::string local_endpoint;
    bool peer_known = false;            // producer: an endpoint was learned; performer: always
    std::string peer_endpoint;
    bool peer_reachable = false;        // what gates sending (see above)
    bool peer_heard = false;            // a valid datagram within peer_timeout_ms
    bool peer_closed = false;           // the peer said it stopped (closing report)
    bool control_link_up = false;
    double last_rx_age_ms = -1.0;
    std::uint64_t peer_timeouts = 0;
    std::uint64_t reports_sent = 0;
    std::uint64_t report_send_errors = 0;
    std::uint64_t reports_received = 0;
    std::uint64_t test_blackholed = 0;  // TEST ONLY: datagrams dropped by the receive blackhole
    InvalidCounts invalid;
    bool has_remote_report = false;     // the peer's report about OUR outgoing stream
    ReceiverReport remote_report;
    double remote_report_age_ms = -1.0;
};

class LiveEndpoint {
public:
    explicit LiveEndpoint(log::Logger* logger = nullptr);
    ~LiveEndpoint();
    LiveEndpoint(const LiveEndpoint&) = delete;
    LiveEndpoint& operator=(const LiveEndpoint&) = delete;

    // `tap` is required when config.has_outgoing (and must outlive the endpoint).
    bool start(const LiveEndpointConfig& config, audio::LiveTap* tap, std::string& error);
    // Ends the outgoing stream (END_OF_STREAM), sends closing reports, joins the thread.
    // Detach the incoming stream from the audio engine BEFORE calling this.
    void stop();
    bool running() const noexcept { return running_.load(); }

    // The streams exist from start() until the next start(); null if not configured.
    OutgoingStream* outgoing() noexcept { return outgoing_.get(); }
    IncomingStream* incoming() noexcept { return incoming_.get(); }
    const OutgoingStream* outgoing() const noexcept { return outgoing_.get(); }
    const IncomingStream* incoming() const noexcept { return incoming_.get(); }

    void set_control_link_up(bool up) noexcept { control_up_.store(up); }
    // TEST ONLY: drop every received datagram before any check (one direction fails completely).
    void set_test_receive_blackhole(bool on) noexcept { blackhole_.store(on); }
    EndpointStats stats() const;
    const LiveEndpointConfig& config() const noexcept { return cfg_; }

private:
    void thread_main();
    void handle(const std::uint8_t* data, long size, const net::Endpoint& from, std::int64_t now);
    bool send_datagram(const std::uint8_t* d, std::size_t n);
    void send_report(bool closing);
    bool reachable(std::int64_t now);

    log::Logger* log_;
    LiveEndpointConfig cfg_;
    net::UdpSocket socket_;
    net::Endpoint expected_peer_;  // bind_mode: IP only
    std::unique_ptr<OutgoingStream> outgoing_;
    std::unique_ptr<IncomingStream> incoming_;
    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> stop_requested_{false};
    std::atomic<bool> control_up_{false};
    std::atomic<bool> blackhole_{false};

    mutable std::mutex mutex_;  // guards the fields below
    bool peer_known_ = false;
    net::Endpoint peer_;
    bool peer_closed_ = false;
    bool was_heard_ = false;
    std::int64_t last_rx_ns_ = 0;
    std::uint64_t peer_timeouts_ = 0;
    std::uint64_t reports_sent_ = 0;
    std::uint64_t report_errors_ = 0;
    std::uint64_t reports_received_ = 0;
    std::uint64_t blackholed_ = 0;
    std::uint32_t report_seq_ = 0;
    InvalidCounts invalid_;
    bool has_remote_report_ = false;
    ReceiverReport remote_report_;
    std::int64_t remote_report_ns_ = 0;
};

}  // namespace rr::media
