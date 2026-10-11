#pragma once

// Connection-level control channel (ADR-016). One instance per app, running its own thread:
//  - producer ("server"): listens on ONE explicitly chosen IPv4 address, accepts one performer;
//  - performer ("client"): connects, and after a successful join reconnects automatically.
// The link handles HELLO (version), JOIN (pairing code or resume token), HEARTBEAT (liveness +
// clock-offset samples stamped on this thread) and SESSION_CLOSED. Every other frame is passed
// to the application as a FrameReceived event, in order.
//
// Security (ADR-012): NOT encrypted, NOT authenticated against an attacker. The pairing code
// only prevents accidental connections. Codes and resume tokens are never put into events or logs.

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rr/network/clock_offset.hpp"
#include "rr/network/control_protocol.hpp"
#include "rr/network/socket.hpp"
#include "rr/session/states.hpp"
#include "rr/shared/error_codes.hpp"

namespace rr::net {

struct LinkTimings {
    std::uint32_t heartbeat_interval_ms = 1000;
    std::uint32_t link_lost_after_ms = 3000;   // no frame of any kind for this long
    std::uint32_t connect_timeout_ms = 5000;
    std::uint32_t handshake_timeout_ms = 3000;
    std::uint32_t reconnect_interval_ms = 2000;
    std::uint32_t reconnect_give_up_ms = 120000;
    std::uint32_t pairing_code_ttl_ms = 600000;  // 10 min (prov.)
    std::uint32_t max_failed_joins = 5;          // then a new code is required
};

struct ServerParams {
    std::string bind_address;   // explicit IPv4 of one interface (or 127.0.0.1)
    std::uint16_t port = 52000;
    std::string session_id;     // 8 hex
    std::string producer_name;
    std::string app_version;
    std::uint32_t max_take_seconds = 1800;
    LinkTimings timings;
};

struct ClientParams {
    std::string host_address;
    std::uint16_t port = 52000;
    std::string pairing_code;   // never logged
    std::string performer_name;
    std::string app_version;
    LinkTimings timings;
};

enum class LinkEventKind {
    StateChanged,    // `state` is the new state; `text` explains
    Joined,          // handshake complete (first join or resume); `resumed` set on resume
    FrameReceived,   // application frame in `frame`
    PeerClosed,      // SESSION_CLOSED received (`code`)
    JoinRejected,    // performer: join refused (`code`, `text`); no automatic retry
    ProtocolError,   // malformed/unexpected input; the connection was closed (`text`)
    Info,            // diagnostic text
};

struct LinkEvent {
    LinkEventKind kind = LinkEventKind::Info;
    session::LinkState state = session::LinkState::Disconnected;
    Frame frame;
    ErrorCode code = ErrorCode::Ok;
    std::string text;
    bool resumed = false;
};

struct LinkStats {
    std::uint64_t frames_sent = 0;
    std::uint64_t frames_received = 0;
    std::uint64_t stale_frames_dropped = 0;   // msg_id not increasing
    std::uint64_t protocol_errors = 0;
    std::uint64_t heartbeats_received = 0;
    std::uint64_t connections = 0;            // successful joins (incl. resumes)
    std::uint64_t reconnect_attempts = 0;
    std::uint64_t failed_joins = 0;
    std::int64_t control_rtt_ns = -1;         // latest HEARTBEAT round trip (TCP + thread scheduling)
    std::int64_t theta_ns = 0;                // estimated (peer clock - local clock)
    std::int64_t theta_uncertainty_ns = -1;   // -1 = no estimate yet
    std::uint64_t offset_samples = 0;
};

struct JoinInfo {
    std::string session_id;
    std::string peer_name;
    std::string peer_app_version;
    std::string peer_address;
    std::uint32_t max_take_seconds = 0;
    std::uint16_t protocol_minor = 0;  // agreed minor version (min of both sides); 2+ = take transfer
};

class ControlLink {
public:
    static std::unique_ptr<ControlLink> server(const ServerParams& params);
    static std::unique_ptr<ControlLink> client(const ClientParams& params);
    ~ControlLink();
    ControlLink(const ControlLink&) = delete;
    ControlLink& operator=(const ControlLink&) = delete;

    // Server: binds and listens (errors are immediate). Client: starts connecting.
    bool start(std::string& error);
    // Sends SESSION_CLOSED (if connected), closes, joins the thread. Idempotent.
    void stop(ErrorCode reason = ErrorCode::Shutdown);

    // Queue an application frame. msg_id and SentNs are assigned on the link thread. Returns false
    // (frame dropped) if the link is not Connected.
    bool send(Frame frame);
    std::vector<LinkEvent> poll_events();

    session::LinkState state() const noexcept { return state_.load(); }
    LinkStats stats() const;
    JoinInfo join_info() const;
    bool is_server() const noexcept { return is_server_; }

    // Server only: invalidates the old code, returns a new 6-digit code (for display only).
    std::string new_pairing_code();
    std::string pairing_code() const;  // for display only

    // ---- test hooks ----
    void test_suspend_heartbeats(bool suspend) { suspend_heartbeats_.store(suspend); }
    void test_drop_connection() { drop_requested_.store(true); }
    // Client: next HELLO advertises this major version (to test version rejection).
    void test_set_protocol_major(std::uint16_t major) { test_major_ = major; }

private:
    ControlLink() = default;
    void run();
    void set_state(session::LinkState s, const std::string& why);
    void push_event(LinkEvent e);
    void queue_frame(Frame f);  // link thread only
    void close_connection(const std::string& why, bool lost);
    void handle_frame(Frame& f, std::int64_t arrival_ns);
    void server_handle_handshake(Frame& f);
    void client_handle_handshake(Frame& f);
    void send_error_and_close(ErrorCode code, const std::string& text, std::uint32_t ref_id);
    void start_client_connect();

    bool is_server_ = false;
    ServerParams sp_;
    ClientParams cp_;
    LinkTimings t_;

    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<session::LinkState> state_{session::LinkState::Disconnected};
    std::atomic<bool> suspend_heartbeats_{false};
    std::atomic<bool> drop_requested_{false};
    std::uint16_t test_major_ = 0;

    mutable std::mutex mutex_;  // guards the members below
    std::deque<Frame> app_outbox_;
    std::deque<LinkEvent> events_;
    LinkStats stats_;
    JoinInfo join_;
    std::string pairing_code_;
    std::int64_t code_created_ns_ = 0;
    bool code_used_ = false;
    std::uint32_t failed_joins_ = 0;
    std::string resume_token_;
    std::string client_id_;
    bool stop_with_close_ = false;
    ErrorCode stop_reason_ = ErrorCode::Shutdown;

    // ---- link thread only ----
    TcpSocket listener_;
    TcpSocket conn_;
    struct Rejecting {
        TcpSocket socket;
        std::int64_t close_at_ns;
    };
    std::vector<Rejecting> rejecting_;  // refused extra connections, closed gracefully
    std::string conn_peer_;
    FrameDecoder decoder_;
    std::vector<std::uint8_t> outbuf_;
    std::uint32_t next_msg_id_ = 1;
    std::uint32_t last_rx_msg_id_ = 0;
    enum class Phase { Idle, Connecting, AwaitHello, AwaitHelloAck, AwaitJoin, AwaitJoinAck, Joined, Closing } phase_ = Phase::Idle;
    std::int64_t phase_deadline_ns_ = 0;
    std::int64_t last_rx_ns_ = 0;
    std::int64_t last_hb_tx_ns_ = 0;
    std::int64_t link_lost_since_ns_ = 0;
    std::int64_t next_reconnect_ns_ = 0;
    bool ever_joined_ = false;
    ClockOffsetEstimator offset_;
};

// 6 random digits (std::random_device).
std::string make_pairing_code();
// 32 random hex digits.
std::string make_random_token(std::size_t hex_digits);

}  // namespace rr::net
