#pragma once

// Producer/performer session control (Stage 6). Single-threaded: every public method, including
// poll(), must be called from one thread (the UI thread in the apps, the main thread in the CLI).
// Network I/O happens on the ControlLink's own thread; recording on the recorder's threads.
//
// Rules enforced here:
//  - every state change goes through rr::session::session_transition(); invalid events change
//    nothing, are logged, and messages that caused them are answered with a refusal;
//  - take ids are strictly increasing: a duplicated or delayed ARM/SCHEDULE_START/STOP can never
//    start or stop a second recording (duplicates are answered idempotently, stale ones refused);
//  - the producer shows a performer step only after the performer's own message (ARM_ACK,
//    START_ACK, TAKE_STARTED, TAKE_FINALISED), never because a command was sent;
//  - pairing codes and resume tokens are never logged.

#include <cstdint>
#include <deque>
#include <memory>
#include <string>
#include <vector>

#include "rr/control/recorder_port.hpp"
#include "rr/network/control_link.hpp"
#include "rr/session/session_machine.hpp"
#include "rr/shared/config.hpp"
#include "rr/shared/log.hpp"

namespace rr::control {

struct ControllerConfig {
    Role role = Role::Producer;
    SessionTimingConfig timing;
    net::LinkTimings link;
    std::string app_version;
    std::string display_name;
    std::uint32_t arm_to_schedule_timeout_ms = 5000;  // performer: SCHEDULE_START must follow ARM
    std::uint32_t status_interval_ms = 2000;
    std::uint32_t min_offset_samples = 3;              // performer: before it can accept a schedule
};

// Everything the UI shows about one take. Producer: "peer_*" flags are set only by the
// performer's messages.
struct TakeView {
    std::uint32_t take_id = 0;
    bool arm_sent = false;
    bool peer_arm_ack = false;
    bool schedule_sent = false;
    bool peer_start_ack = false;
    std::int64_t start_at_local_ns = 0;     // this PC's clock
    std::int64_t peer_planned_start_ns = 0; // performer's clock (from START_ACK)
    bool local_started = false;
    std::int64_t local_first_sample_ns = 0;
    std::uint64_t local_late_frames = 0;
    bool peer_started = false;
    std::int64_t peer_first_sample_ns = 0;  // performer's clock
    std::uint64_t peer_late_frames = 0;
    bool stop_sent = false;
    bool peer_stop_ack = false;
    bool local_finalised = false;
    TakeStatus local_status = TakeStatus::Complete;
    std::uint64_t local_frames = 0;
    std::string local_file;
    std::string local_error;
    bool peer_finalised = false;
    bool peer_report_timed_out = false;
    TakeStatus peer_status = TakeStatus::Complete;
    std::uint64_t peer_frames = 0;
    bool has_start_offset = false;
    double start_offset_ms = 0.0;     // (performer first sample - producer first sample), estimated
    double start_offset_unc_ms = 0.0; // +/- (clock-offset uncertainty only; callback jitter not included)
};

struct ControllerSnapshot {
    Role role = Role::Producer;
    session::LinkState link = session::LinkState::Disconnected;
    session::SessionState session = session::SessionState::NotReady;
    std::vector<std::string> not_ready_reasons;
    std::string session_id;
    std::string pairing_code;   // producer only, for DISPLAY; never logged
    std::string bind_address;
    std::uint16_t port = 0;
    std::string peer_name;
    std::string peer_address;
    bool local_consent = false;
    bool peer_ready = false;
    bool peer_consent = false;
    std::string peer_reasons;
    net::LinkStats link_stats;
    TakeView take;              // current or last take
    std::string last_error;
    std::uint64_t invalid_events = 0;
    std::uint64_t refused_messages = 0;
    std::uint64_t duplicate_messages = 0;
    std::string recorder_description;
};

class SessionController {
public:
    SessionController(ControllerConfig config, RecorderPort& port, log::Logger& logger);
    ~SessionController();
    SessionController(const SessionController&) = delete;
    SessionController& operator=(const SessionController&) = delete;

    // ---- producer ----
    bool create_session(const std::string& bind_address, std::uint16_t port, std::string& error);
    std::string new_pairing_code();
    bool start_take(std::string& error);  // Record
    bool stop_take(std::string& error);   // Stop

    // ---- performer ----
    bool join(const std::string& host, std::uint16_t port, const std::string& pairing_code, std::string& error);
    bool stop_and_save(std::string& error);  // performer's own Stop & save

    // ---- both ----
    void set_consent(bool given);
    void leave();     // ends the session (SESSION_CLOSED); not allowed while recording
    void shutdown();  // app closing
    void poll();
    ControllerSnapshot snapshot() const;
    std::vector<std::string> take_history() const;  // human-readable, newest last
    bool session_active() const { return link_ != nullptr; }
    net::ControlLink* link() { return link_.get(); }  // tests

private:
    bool apply(session::SessionEvent event, const std::string& why);
    void handle_link_event(const net::LinkEvent& e);
    void handle_frame(const net::Frame& f);
    void producer_frame(const net::Frame& f);
    void performer_frame(const net::Frame& f);
    void handle_port_event(const PortEvent& e);
    void update_readiness();
    void send_status(bool force);
    bool send(net::Frame f);
    void send_or_queue(net::Frame f);
    void reply(net::MsgType type, std::uint32_t ref, std::uint32_t take, bool accepted, ErrorCode code,
               const std::string& text);
    void refuse(const net::Frame& f, ErrorCode code, const std::string& text);
    void history(const std::string& line);
    void check_timers();
    void maybe_complete();
    void compute_start_offset();

    ControllerConfig cfg_;
    RecorderPort& port_;
    log::Logger& log_;
    std::unique_ptr<net::ControlLink> link_;
    session::LinkState link_state_ = session::LinkState::Disconnected;
    session::SessionState state_ = session::SessionState::NotReady;

    std::string session_id_;
    std::string bind_address_;
    std::uint16_t port_number_ = 0;
    bool consent_ = false;
    bool peer_ready_ = false;
    bool peer_consent_ = false;
    std::string peer_reasons_;
    std::vector<std::string> reasons_;
    bool local_ready_ = false;
    std::string last_status_payload_;
    std::int64_t last_status_ns_ = 0;
    std::string last_error_;

    TakeView take_;
    bool take_open_ = false;            // a take is in progress (ids below are meaningful)
    std::uint32_t last_take_id_ = 0;    // producer: last issued; performer: last accepted ARM
    std::int64_t arm_ack_deadline_ = 0;
    std::int64_t start_ack_deadline_ = 0;
    std::int64_t schedule_deadline_ = 0;
    std::int64_t peer_report_deadline_ = 0;
    std::int64_t stop_ack_deadline_ = 0;
    std::uint32_t arm_msg_id_ = 0;
    std::deque<net::Frame> report_queue_;  // performer reports waiting for a connection

    std::uint64_t invalid_events_ = 0;
    std::uint64_t refused_ = 0;
    std::uint64_t duplicates_ = 0;
    std::deque<std::string> history_;
};

}  // namespace rr::control
