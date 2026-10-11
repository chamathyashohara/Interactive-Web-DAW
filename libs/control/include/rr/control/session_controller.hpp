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
#include <filesystem>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "rr/control/readiness.hpp"
#include "rr/control/recorder_port.hpp"
#include "rr/network/control_link.hpp"
#include "rr/session/session_machine.hpp"
#include "rr/shared/config.hpp"
#include "rr/shared/log.hpp"
#include "rr/transfer/take_receiver.hpp"
#include "rr/transfer/take_sender.hpp"

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
    std::uint16_t test_protocol_major = 0;             // TEST ONLY: non-zero announces this major in HELLO
    // Stage 11: take transfer (performer's original -> producer's verified copy).
    bool auto_transfer = false;                        // producer: request each finalised performer take
    std::filesystem::path received_root;               // producer: used when the recorder has no session folder
    std::uint32_t transfer_resume_wait_ms = 60000;     // producer: paused transfer -> FAILED
    xfer::SenderParams transfer_sender;                // performer
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

    // Stage 9 timing record (this PC's monotonic clock, ns; 0 = did not happen). Logged as
    // "take_timing" when the take ends (completed, failed or cancelled).
    std::int64_t arm_sent_ns = 0;          // producer
    std::int64_t arm_ack_rx_ns = 0;        // producer
    std::int64_t schedule_sent_ns = 0;     // producer
    std::int64_t start_ack_rx_ns = 0;      // producer
    std::int64_t arm_rx_ns = 0;            // performer
    std::int64_t schedule_rx_ns = 0;       // performer: SCHEDULE_START received
    std::int64_t start_ack_sent_ns = 0;    // performer
    std::int64_t peer_started_rx_ns = 0;   // producer: TAKE_STARTED received
    std::int64_t peer_finalised_rx_ns = 0; // producer: TAKE_FINALISED received
    std::int64_t stop_cmd_ns = 0;          // producer: STOP_SCHEDULE sent; performer: received / own stop
    std::int64_t stop_at_local_ns = 0;     // when the local recorder was told to stop
    std::int64_t stop_ack_rx_ns = 0;       // producer
    std::int64_t local_started_seen_ns = 0;
    std::int64_t local_finalised_ns = 0;
    std::uint64_t local_first_frame = 0;   // capture frame index of the first written sample
    std::uint64_t peer_first_frame = 0;
    std::uint32_t device_period_frames = 0;
    std::uint32_t device_periods = 0;
    std::int64_t theta_ns = 0;             // clock offset used for the schedule (performer - producer as seen here)
    std::int64_t theta_unc_ns = 0;
    std::uint64_t offset_samples = 0;
    std::uint32_t start_lead_ms = 0;
    bool cancelled = false;
    std::string cancel_reason;
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
    std::vector<ReadinessCheck> local_checks;  // every item on this PC (Stage 9)
    std::vector<ReadinessCheck> peer_checks;   // the other PC's items, from its READY_STATUS
    std::uint32_t start_lead_ms = 0;           // configured scheduling lead (producer)
    std::uint32_t min_start_lead_ms = 0;       // minimum for the measured link (producer)
    net::LinkStats link_stats;
    TakeView take;              // current or last take
    std::string last_error;
    std::uint64_t invalid_events = 0;
    std::uint64_t refused_messages = 0;
    std::uint64_t duplicate_messages = 0;
    std::string recorder_description;
    // Stage 11: take transfer.
    std::vector<xfer::TransferView> transfers;  // producer: received copies; performer: takes sent
    bool delivery_consent = false;              // performer: allows copies to be sent (XFER-05)
    bool peer_delivery_consent = false;         // producer: the performer allows it (from READY_STATUS)
    bool auto_transfer = false;
    std::uint16_t protocol_minor = 0;           // agreed control protocol minor (2+ = transfer)
    std::uint16_t transfer_port = 0;            // producer: listening transfer port (0 = not open)
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
    // Stop. Before the start (Armed/Scheduled) this CANCELS the take on both PCs; while stopping or
    // finalising it is refused (the files are being closed).
    bool stop_take(std::string& error);
    // Scheduling lead, clamped to 300..10000 ms. Record is refused while it is below
    // min_start_lead_ms() for the measured link.
    void set_start_lead_ms(std::uint32_t ms);
    std::uint32_t min_start_lead_ms() const;

    // ---- performer ----
    bool join(const std::string& host, std::uint16_t port, const std::string& pairing_code, std::string& error);
    bool stop_and_save(std::string& error);  // performer's own Stop & save

    // ---- take transfer (Stage 11) ----
    // Producer: ask the performer for a verified copy of its finalised take `take_id`. Refused while
    // a take is being recorded, before the performer's TAKE_FINALISED, or if the performer's app
    // is older than control protocol 1.2.
    bool request_transfer(std::uint32_t take_id, std::string& error);
    void cancel_transfer(std::uint32_t take_id);  // producer: ends a queued/paused transfer as FAILED
    void set_auto_transfer(bool on);              // producer
    void set_delivery_consent(bool given);        // performer: explicit permission to send copies (XFER-05)
    xfer::TakeReceiver* transfer_receiver() { return receiver_.get(); }  // tests
    xfer::TakeSender* transfer_sender() { return sender_.get(); }        // tests

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
    bool send_stop_schedule(std::int64_t stop_at);
    void release_finished_link();
    void cancel_before_start(const std::string& why);
    void log_take_timing(const std::string& outcome);
    void poll_transfers();
    bool ensure_receiver(std::string& error);
    void performer_transfer_request(const net::Frame& f);
    void stop_transfers();

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
    std::vector<ReadinessCheck> local_checks_;
    std::vector<ReadinessCheck> peer_checks_;
    bool local_ready_ = false;
    bool stop_after_start_ = false;     // producer: Stop pressed in the last moments before the start
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
    bool stop_owed_ = false;            // producer: STOP_SCHEDULE could not be sent; re-sent on reconnect
    std::deque<net::Frame> report_queue_;  // performer reports waiting for a connection

    std::uint64_t invalid_events_ = 0;
    std::uint64_t refused_ = 0;
    std::uint64_t duplicates_ = 0;
    std::deque<std::string> history_;

    // Stage 11: take transfer.
    struct FinishedTake {
        TakeStatus status = TakeStatus::Complete;
        std::uint64_t frames = 0;
        std::string file;  // performer: its finalised WAV
    };
    std::map<std::uint32_t, FinishedTake> finished_takes_;  // producer: from TAKE_FINALISED; performer: own files
    std::unique_ptr<xfer::TakeReceiver> receiver_;          // producer
    std::unique_ptr<xfer::TakeSender> sender_;              // performer
    bool delivery_consent_ = false;
    bool peer_delivery_consent_ = false;
    std::deque<std::uint32_t> auto_queue_;
};

}  // namespace rr::control
