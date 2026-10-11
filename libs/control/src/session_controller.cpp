#include "rr/control/session_controller.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

#include "rr/audio/take_naming.hpp"
#include "rr/shared/clock.hpp"

namespace rr::control {
namespace {

using net::Frame;
using net::MsgType;
using net::Tag;
using session::LinkState;
using session::SessionEvent;
using session::SessionState;

std::int64_t ms(std::uint32_t v) {
    return static_cast<std::int64_t>(v) * 1'000'000;
}

std::string join_reasons(const std::vector<std::string>& r) {
    std::string out;
    for (std::size_t i = 0; i < r.size(); ++i) {
        out += (i ? "; " : "") + r[i];
    }
    return out;
}

// Messages that carry the session id (protocol 1.1); a mismatch is refused (Stage 9).
bool carries_session(MsgType t) {
    switch (t) {
        case MsgType::Arm: case MsgType::ArmAck: case MsgType::ScheduleStart: case MsgType::StartAck:
        case MsgType::TakeStarted: case MsgType::Cancel: case MsgType::StopSchedule: case MsgType::StopAck:
        case MsgType::LocalStop: case MsgType::TakeFinalised:
            return true;
        default:
            return false;
    }
}

std::string ns_text(std::int64_t v) {
    return std::to_string(v);
}

std::string ms_between(std::int64_t from, std::int64_t to) {
    if (from == 0 || to == 0) {
        return "n/a";
    }
    char b[32];
    std::snprintf(b, sizeof b, "%.3f", static_cast<double>(to - from) / 1e6);
    return b;
}

std::string ms_value(double v) {
    char b[32];
    std::snprintf(b, sizeof b, "%.3f", v);
    return b;
}

bool take_running(SessionState s) {
    return s == SessionState::Recording || s == SessionState::Stopping || s == SessionState::Finalising;
}

}  // namespace

SessionController::SessionController(ControllerConfig config, RecorderPort& port, log::Logger& logger)
    : cfg_(std::move(config)), port_(port), log_(logger) {}

SessionController::~SessionController() {
    shutdown();
}

void SessionController::history(const std::string& line) {
    history_.push_back(time::format_utc_iso8601_ms(time::utc_now_ms()).substr(11, 12) + "  " + line);
    if (history_.size() > 300) {
        history_.pop_front();
    }
}

std::vector<std::string> SessionController::take_history() const {
    return std::vector<std::string>(history_.begin(), history_.end());
}

bool SessionController::apply(SessionEvent event, const std::string& why) {
    const session::Transition t = session::session_transition(cfg_.role, state_, event);
    if (!t.valid) {
        ++invalid_events_;
        log_.log(log::Level::Warn, "session", "invalid_transition", why,
                 {{"state", std::string(session::session_state_name(state_))},
                  {"event", session::session_event_name(event)}});
        return false;
    }
    if (t.next != state_) {
        log_.log(log::Level::Info, "session", "state", why,
                 {{"from", std::string(session::session_state_name(state_))},
                  {"to", std::string(session::session_state_name(t.next))},
                  {"event", session::session_event_name(event)}});
        history("state " + std::string(session::session_state_name(state_)) + " -> " +
                std::string(session::session_state_name(t.next)) + " (" + why + ")");
    }
    state_ = t.next;
    if (state_ == SessionState::Completed) {
        update_readiness();  // Completed is short-lived
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
bool SessionController::create_session(const std::string& bind_address, std::uint16_t port, std::string& error) {
    if (cfg_.role != Role::Producer) {
        error = "only Producer Studio creates sessions";
        return false;
    }
    release_finished_link();
    if (link_) {
        error = "a session already exists";
        return false;
    }
    session_id_ = audio::make_session_id();
    net::ServerParams p;
    p.bind_address = bind_address;
    p.port = port;
    p.session_id = session_id_;
    p.producer_name = cfg_.display_name;
    p.app_version = cfg_.app_version;
    p.max_take_seconds = cfg_.timing.max_take_seconds;
    p.timings = cfg_.link;
    link_ = net::ControlLink::server(p);
    if (cfg_.test_protocol_major != 0) {
        link_->test_set_protocol_major(cfg_.test_protocol_major);
    }
    if (!link_->start(error)) {
        link_.reset();
        session_id_.clear();
        log_.log(log::Level::Error, "session", "create_failed", error);
        return false;
    }
    bind_address_ = bind_address;
    port_number_ = port;
    link_state_ = LinkState::Listening;  // until the link's own events arrive in poll()
    log_.log(log::Level::Info, "session", "created", "session created",
             {{"session", session_id_}, {"bind", bind_address}, {"port", std::to_string(port)},
              {"pairing_code", "<redacted>"}});
    history("session " + session_id_ + " created on " + bind_address + ":" + std::to_string(port));
    return true;
}

std::string SessionController::new_pairing_code() {
    if (!link_ || cfg_.role != Role::Producer) {
        return {};
    }
    log_.log(log::Level::Info, "session", "pairing_code_renewed", "new pairing code issued",
             {{"pairing_code", "<redacted>"}});
    history("new pairing code issued");
    return link_->new_pairing_code();
}

bool SessionController::join(const std::string& host, std::uint16_t port, const std::string& code, std::string& error) {
    if (cfg_.role != Role::Performer) {
        error = "only Performer Client joins sessions";
        return false;
    }
    release_finished_link();
    if (link_) {
        error = "already in a session";
        return false;
    }
    net::ClientParams p;
    p.host_address = host;
    p.port = port;
    p.pairing_code = code;
    p.performer_name = cfg_.display_name;
    p.app_version = cfg_.app_version;
    p.timings = cfg_.link;
    link_ = net::ControlLink::client(p);
    if (cfg_.test_protocol_major != 0) {
        link_->test_set_protocol_major(cfg_.test_protocol_major);
    }
    if (!link_->start(error)) {
        link_.reset();
        return false;
    }
    bind_address_ = host;
    port_number_ = port;
    link_state_ = LinkState::Connecting;  // until the link's own events arrive in poll()
    last_error_.clear();
    log_.log(log::Level::Info, "session", "join_started", "joining",
             {{"host", host}, {"port", std::to_string(port)}, {"pairing_code", "<redacted>"}});
    history("joining " + host + ":" + std::to_string(port));
    return true;
}

// A link that has ended for good (refused join, closed session, gave up reconnecting) is released
// so that the user can join or create again. Never while a local take is still running.
void SessionController::release_finished_link() {
    if (!link_ || link_state_ != LinkState::Disconnected || link_->state() != LinkState::Disconnected ||
        take_running(state_) ||
        state_ == SessionState::Scheduled) {
        return;
    }
    link_->stop(ErrorCode::UserStop);
    link_.reset();
    peer_ready_ = false;
    peer_consent_ = false;
    session_id_.clear();
    report_queue_.clear();
}

void SessionController::set_consent(bool given) {
    if (consent_ != given) {
        consent_ = given;
        log_.log(log::Level::Info, "session", given ? "consent_given" : "consent_withdrawn",
                 given ? "local participant consented to recording" : "consent withdrawn");
        history(given ? "consent given" : "consent withdrawn");
        update_readiness();
        send_status(true);
    }
}

void SessionController::leave() {
    if (!link_) {
        return;
    }
    if (take_running(state_) || state_ == SessionState::Scheduled) {
        last_error_ = "stop the take before leaving the session";
        return;
    }
    link_->stop(ErrorCode::UserStop);
    link_.reset();
    link_state_ = LinkState::Disconnected;
    apply(SessionEvent::LinkLost, "left the session");
    peer_ready_ = false;
    peer_consent_ = false;
    session_id_.clear();
    history("left the session");
    log_.log(log::Level::Info, "session", "left", "session closed by this side");
}

void SessionController::shutdown() {
    if (link_) {
        link_->stop(ErrorCode::Shutdown);
        link_.reset();
    }
    if (state_ != SessionState::Closed) {
        session::Transition t = session::session_transition(cfg_.role, state_, SessionEvent::Shutdown);
        if (t.valid) {
            state_ = t.next;
        }
    }
}

// ---------------------------------------------------------------------------------------------
bool SessionController::send(Frame f) {
    if (carries_session(f.type) && !session_id_.empty()) {
        f.set_str(Tag::SessionId, session_id_);
    }
    return link_ && link_->send(std::move(f));
}

void SessionController::send_or_queue(Frame f) {
    if (!send(f)) {
        report_queue_.push_back(std::move(f));  // re-sent after reconnection
    }
}

void SessionController::reply(MsgType type, std::uint32_t ref, std::uint32_t take, bool accepted, ErrorCode code,
                              const std::string& text) {
    Frame r;
    r.type = type;
    r.ref_id = ref;
    r.set_u32(Tag::TakeId, take);
    r.set_u8(Tag::Accepted, accepted ? 1 : 0);
    if (!accepted) {
        r.set_u16(Tag::ErrorCode, static_cast<std::uint16_t>(code));
        r.set_str(Tag::ErrorText, text);
        ++refused_;
    }
    send(std::move(r));
}

void SessionController::refuse(const Frame& f, ErrorCode code, const std::string& text) {
    log_.log(log::Level::Warn, "session", "message_refused", text,
             {{"type", net::msg_type_name(f.type)}, {"code", std::string(error_code_name(code))},
              {"state", std::string(session::session_state_name(state_))}});
    history(std::string("refused ") + net::msg_type_name(f.type) + ": " + text);
}

void SessionController::send_status(bool force) {
    if (!link_ || link_state_ != LinkState::Connected) {
        return;
    }
    const std::string payload = std::to_string(local_ready_) + std::to_string(consent_) +
                                std::to_string(static_cast<int>(state_)) + join_reasons(reasons_) +
                                encode_checks(local_checks_);
    const std::int64_t now = time::monotonic_ns();
    if (!force && payload == last_status_payload_ && now - last_status_ns_ < ms(cfg_.status_interval_ms)) {
        return;
    }
    Frame f;
    f.type = MsgType::ReadyStatus;
    f.set_u8(Tag::Ready, local_ready_ ? 1 : 0);
    f.set_u8(Tag::Consent, consent_ ? 1 : 0);
    f.set_u8(Tag::State, static_cast<std::uint8_t>(state_));
    f.set_str(Tag::Reasons, join_reasons(reasons_));
    f.set_str(Tag::ReadyChecks, encode_checks(local_checks_));
    if (send(std::move(f))) {
        last_status_payload_ = payload;
        last_status_ns_ = now;
    }
}

void SessionController::update_readiness() {
    reasons_.clear();
    const LocalReadiness local = port_.readiness();
    reasons_ = local.reasons;
    local_checks_ = local.checks;
    local_checks_.push_back(ReadinessCheck{ReadyItem::Consent, consent_, true, consent_ ? "given" : "not given"});
    {
        const bool up = link_ && link_state_ == LinkState::Connected;
        local_checks_.push_back(ReadinessCheck{ReadyItem::Connected, up, true,
                                               up ? std::string("connected") : std::string(session::link_state_name(link_state_))});
    }
    if (cfg_.role == Role::Performer) {
        const std::uint64_t n = link_ ? link_->stats().offset_samples : 0;
        char d[96];
        std::snprintf(d, sizeof d, "%llu of %u samples, +/- %.3f ms", static_cast<unsigned long long>(n),
                      cfg_.min_offset_samples,
                      link_ ? static_cast<double>(link_->stats().theta_uncertainty_ns) / 1e6 : 0.0);
        local_checks_.push_back(ReadinessCheck{ReadyItem::ClockOffset, n >= cfg_.min_offset_samples, true, d});
    }
    if (!consent_) {
        reasons_.emplace_back("recording consent not given");
    }
    if (!link_) {
        reasons_.emplace_back(cfg_.role == Role::Producer ? "no session created" : "not joined to a session");
    } else if (link_state_ != LinkState::Connected) {
        reasons_.emplace_back(cfg_.role == Role::Producer ? "no performer connected" : "not connected to the producer");
    } else if (cfg_.role == Role::Producer) {
        if (!peer_consent_) {
            reasons_.emplace_back("performer has not consented");
        }
        if (!peer_ready_) {
            reasons_.emplace_back("performer not ready" + (peer_reasons_.empty() ? std::string() : ": " + peer_reasons_));
        }
    } else if (link_->stats().offset_samples < cfg_.min_offset_samples) {
        reasons_.emplace_back("measuring clock offset to the producer");
    }
    // Readiness reported to the peer means "this side could record" (excluding the peer).
    local_ready_ = local.ok && consent_ && link_ && link_state_ == LinkState::Connected &&
                   (cfg_.role == Role::Producer || link_->stats().offset_samples >= cfg_.min_offset_samples);
    const bool ready = reasons_.empty();
    if (state_ == SessionState::NotReady || state_ == SessionState::Ready || state_ == SessionState::Completed) {
        const SessionState before = state_;
        apply(ready ? SessionEvent::ReadinessOk : SessionEvent::ReadinessLost,
              ready ? "all readiness conditions hold" : "not ready: " + join_reasons(reasons_));
        if (before != state_) {
            send_status(true);
        }
    }
}

// ---------------------------------------------------------------------------------------------
void SessionController::set_start_lead_ms(std::uint32_t v) {
    cfg_.timing.start_lead_ms = std::min<std::uint32_t>(10000, std::max<std::uint32_t>(300, v));
}

// Provisional rule (ADR-019): the performer needs arm_ack_margin before the start, the SCHEDULE_START
// and START_ACK each take about one control RTT, the clock offset can be wrong by +/- u, and both
// apps add polling delay (UI 50 ms + link 20 ms, each side) -> margin + 2 RTT + 2 u + 200 ms.
std::uint32_t SessionController::min_start_lead_ms() const {
    const net::LinkStats ls = link_ ? link_->stats() : net::LinkStats{};
    const double extra_ms = (2.0 * static_cast<double>(ls.control_rtt_ns) + 2.0 * static_cast<double>(ls.theta_uncertainty_ns)) / 1e6;
    return cfg_.timing.arm_ack_margin_ms + 200u + static_cast<std::uint32_t>(std::ceil(extra_ms));
}

bool SessionController::start_take(std::string& error) {
    if (cfg_.role != Role::Producer) {
        error = "only the producer starts takes";
        return false;
    }
    update_readiness();
    if (state_ != SessionState::Ready) {
        error = "not ready: " + join_reasons(reasons_);
        return false;
    }
    if (cfg_.timing.start_lead_ms < min_start_lead_ms()) {
        error = "start lead " + std::to_string(cfg_.timing.start_lead_ms) + " ms is below the minimum " +
                std::to_string(min_start_lead_ms()) + " ms for the measured link";
        return false;
    }
    if (!apply(SessionEvent::UserRecord, "producer pressed Record")) {
        error = "Record is not allowed in this state";
        return false;
    }
    take_ = TakeView{};
    take_open_ = true;
    stop_owed_ = false;
    take_.take_id = ++last_take_id_;
    stop_after_start_ = false;
    take_.start_lead_ms = cfg_.timing.start_lead_ms;
    take_.arm_sent_ns = time::monotonic_ns();
    Frame f;
    f.type = MsgType::Arm;
    f.set_u32(Tag::TakeId, take_.take_id);
    f.set_u32(Tag::MaxTakeSeconds, cfg_.timing.max_take_seconds);
    take_.arm_sent = send(std::move(f));
    arm_ack_deadline_ = time::monotonic_ns() + ms(2000);
    history("take " + std::to_string(take_.take_id) + ": ARM sent (waiting for the performer's ARM_ACK)");
    log_.log(log::Level::Info, "session", "arm_sent", "ARM sent", {{"take", std::to_string(take_.take_id)}});
    return true;
}

bool SessionController::stop_take(std::string& error) {
    if (cfg_.role != Role::Producer) {
        error = "only the producer stops session takes; use Stop & save";
        return false;
    }
    if (state_ == SessionState::Armed || state_ == SessionState::Scheduled) {
        // Stop before the start. Far enough ahead: cancel on both PCs. In the last 150 ms the local
        // recorder may already be starting, so stop it right after the start instead.
        if (take_.start_at_local_ns != 0 && take_.start_at_local_ns - time::monotonic_ns() < ms(150)) {
            stop_after_start_ = true;
            history("take " + std::to_string(take_.take_id) + ": Stop pressed just before the start; it stops right after");
            return true;
        }
        cancel_before_start("producer pressed Stop before the start");
        return true;
    }
    if (state_ == SessionState::Stopping || state_ == SessionState::Finalising) {
        error = "the take is already stopping; wait until both files are finalised";
        return false;
    }
    if (state_ != SessionState::Recording) {
        error = "no take is recording";
        return false;
    }
    const std::int64_t stop_at = time::monotonic_ns() + ms(cfg_.timing.stop_lead_ms);
    send_stop_schedule(stop_at);
    port_.schedule_stop(stop_at, false);
    apply(SessionEvent::UserStop, "producer pressed Stop");
    history("take " + std::to_string(take_.take_id) + ": STOP_SCHEDULE sent" +
            (take_.stop_sent ? ""
                             : " FAILED (no connection): the performer keeps recording; STOP is re-sent when it reconnects"));
    return true;
}

bool SessionController::stop_and_save(std::string& error) {
    if (cfg_.role != Role::Performer) {
        error = "use Stop";
        return false;
    }
    if (state_ != SessionState::Recording) {
        error = "no take is recording";
        return false;
    }
    port_.schedule_stop(0, false);
    take_.stop_cmd_ns = time::monotonic_ns();
    take_.stop_at_local_ns = take_.stop_cmd_ns;
    apply(SessionEvent::UserStopAndSave, "performer pressed Stop & save");
    Frame f;
    f.type = MsgType::LocalStop;
    f.set_u32(Tag::TakeId, take_.take_id);
    f.set_str(Tag::StopReason, "performer pressed Stop & save");
    send_or_queue(std::move(f));
    history("take " + std::to_string(take_.take_id) + ": stopped by the performer");
    return true;
}

// ---------------------------------------------------------------------------------------------
void SessionController::poll() {
    if (link_) {
        for (const auto& e : link_->poll_events()) {
            handle_link_event(e);
        }
    }
    for (const auto& e : port_.poll()) {
        handle_port_event(e);
    }
    check_timers();
    update_readiness();
    send_status(false);
}

void SessionController::handle_link_event(const net::LinkEvent& e) {
    switch (e.kind) {
    case net::LinkEventKind::StateChanged: {
        const LinkState old = link_state_;
        link_state_ = e.state;
        log_.log(e.state == LinkState::LinkLost ? log::Level::Warn : log::Level::Info, "link", "state", e.text,
                 {{"from", std::string(session::link_state_name(old))},
                  {"to", std::string(session::link_state_name(e.state))}});
        history("link " + std::string(session::link_state_name(e.state)) + ": " + e.text);
        if (old == LinkState::Connected && e.state != LinkState::Connected) {
            peer_ready_ = false;
            const bool before_start = state_ == SessionState::Armed || state_ == SessionState::Scheduled;
            if (state_ == SessionState::Scheduled) {
                port_.cancel_take();  // never start a take the other side cannot see (A-3)
            }
            apply(SessionEvent::LinkLost, "control link lost");
            if (before_start && take_open_ && !take_.local_started) {
                // Same outcome as CANCEL: the take never started on this PC (D-76).
                take_.cancelled = true;
                take_.cancel_reason = "control link lost before the start";
                history("take " + std::to_string(take_.take_id) + ": cancelled, control link lost before the start");
                log_take_timing("cancelled");
            }
            if (state_ == SessionState::NotReady) {
                take_open_ = take_open_ && take_.local_started;
            }
        }
        if (cfg_.role == Role::Performer && e.state == LinkState::Disconnected && state_ == SessionState::Recording) {
            // The session is over for good (closed by the producer, or reconnecting gave up): nobody
            // can send STOP any more, so stop and save the local take now rather than leave it open.
            port_.schedule_stop(time::monotonic_ns(), true);
            apply(SessionEvent::StopReceived, "session ended while recording");
            history("take " + std::to_string(take_.take_id) +
                    ": session ended while recording; local take stopped and saved");
        }
        break;
    }
    case net::LinkEventKind::Joined: {
        const net::JoinInfo info = link_->join_info();
        if (cfg_.role == Role::Performer) {
            session_id_ = info.session_id;
        }
        log_.log(log::Level::Info, "link", e.resumed ? "rejoined" : "joined", e.text,
                 {{"session", info.session_id}, {"peer", info.peer_name}, {"peer_address", info.peer_address},
                  {"peer_version", info.peer_app_version}});
        history(std::string(e.resumed ? "reconnected" : "connected") + " (" + info.peer_name + " at " + info.peer_address + ")");
        last_status_payload_.clear();
        send_status(true);
        if (cfg_.role == Role::Producer && stop_owed_ && take_.take_id != 0 && !take_.peer_finalised) {
            const bool sent = send_stop_schedule(time::monotonic_ns() + ms(cfg_.timing.stop_lead_ms));
            history("take " + std::to_string(take_.take_id) + ": STOP_SCHEDULE " +
                    (sent ? "re-sent after reconnecting (the performer's take ends later than the producer's)"
                          : "still could not be sent"));
            log_.log(log::Level::Warn, "session", "stop_resent", "STOP_SCHEDULE re-sent after reconnecting",
                     {{"take", std::to_string(take_.take_id)}, {"sent", sent ? "true" : "false"}});
        }
        while (!report_queue_.empty()) {  // performer: reports made while disconnected
            if (!send(report_queue_.front())) {
                break;
            }
            report_queue_.pop_front();
        }
        break;
    }
    case net::LinkEventKind::FrameReceived:
        handle_frame(e.frame);
        break;
    case net::LinkEventKind::PeerClosed:
        peer_ready_ = false;
        peer_consent_ = false;
        history(e.text);
        log_.log(log::Level::Info, "link", "peer_closed", e.text);
        break;
    case net::LinkEventKind::JoinRejected:
        last_error_ = e.text;
        history("join refused: " + e.text);
        log_.log(log::Level::Warn, "link", "join_rejected", e.text, {{"code", std::string(error_code_name(e.code))}});
        break;
    case net::LinkEventKind::ProtocolError:
        last_error_ = e.text;
        history(e.text);
        log_.log(log::Level::Error, "link", "protocol_error", e.text);
        break;
    case net::LinkEventKind::Info:
        log_.log(log::Level::Info, "link", "info", e.text);
        break;
    }
}

void SessionController::handle_frame(const Frame& f) {
    if (f.type == MsgType::ReadyStatus) {
        peer_ready_ = f.u8(Tag::Ready).value_or(0) != 0;
        peer_consent_ = f.u8(Tag::Consent).value_or(0) != 0;
        peer_reasons_ = f.str(Tag::Reasons).value_or("");
        peer_checks_ = decode_checks(f.str(Tag::ReadyChecks).value_or(""));
        return;
    }
    if (carries_session(f.type) && !session_id_.empty()) {
        const auto sid = f.str(Tag::SessionId);
        if (sid && *sid != session_id_) {
            ++refused_;
            log_.log(log::Level::Warn, "session", "wrong_session", "command for another session refused",
                     {{"type", net::msg_type_name(f.type)}, {"expected", session_id_}, {"got", *sid}});
            history(std::string("refused ") + net::msg_type_name(f.type) + " for another session (" + *sid + ")");
            refuse(f, ErrorCode::UnknownTake, "session id mismatch");
            return;
        }
    }
    if (f.type == MsgType::Error) {
        const auto code = static_cast<ErrorCode>(f.u16(Tag::ErrorCode).value_or(0));
        last_error_ = std::string(error_code_name(code)) + ": " + f.str(Tag::ErrorText).value_or("");
        history("peer reported " + last_error_);
        log_.log(log::Level::Warn, "session", "peer_error", last_error_);
        return;
    }
    if (cfg_.role == Role::Producer) {
        producer_frame(f);
    } else {
        performer_frame(f);
    }
}

void SessionController::producer_frame(const Frame& f) {
    const std::uint32_t take = f.u32(Tag::TakeId).value_or(0);
    const bool current = take_open_ && take == take_.take_id;
    const std::string tag = "take " + std::to_string(take) + ": ";
    switch (f.type) {
    case MsgType::ArmAck: {
        if (!current || state_ != SessionState::Armed || take_.peer_arm_ack) {
            ++duplicates_;
            refuse(f, ErrorCode::UnknownTake, "stale or duplicate ARM_ACK ignored");
            return;
        }
        if (f.u8(Tag::Accepted).value_or(0) == 0) {
            const std::string why = f.str(Tag::ErrorText).value_or("refused");
            history(tag + "performer REFUSED ARM: " + why);
            last_error_ = "performer refused the take: " + why;
            apply(SessionEvent::TakeRefused, "performer refused ARM");
            take_open_ = false;
            return;
        }
        take_.peer_arm_ack = true;
        take_.arm_ack_rx_ns = time::monotonic_ns();
        apply(SessionEvent::ArmAckReceived, "performer accepted ARM");
        const std::int64_t start_at = time::monotonic_ns() + ms(cfg_.timing.start_lead_ms);
        take_.start_at_local_ns = start_at;
        {
            const net::LinkStats ls = link_->stats();
            take_.theta_ns = ls.theta_ns;
            take_.theta_unc_ns = ls.theta_uncertainty_ns;
            take_.offset_samples = ls.offset_samples;
        }
        take_.schedule_sent_ns = time::monotonic_ns();
        Frame s;
        s.type = MsgType::ScheduleStart;
        s.set_u32(Tag::TakeId, take_.take_id);
        s.set_i64(Tag::StartAtNs, start_at);
        take_.schedule_sent = send(std::move(s));
        start_ack_deadline_ = start_at - ms(cfg_.timing.arm_ack_margin_ms);
        history(tag + "ARM_ACK received; SCHEDULE_START sent (start in " + std::to_string(cfg_.timing.start_lead_ms) + " ms)");
        return;
    }
    case MsgType::StartAck: {
        if (!current || state_ != SessionState::Armed || !take_.peer_arm_ack || take_.peer_start_ack) {
            ++duplicates_;
            refuse(f, ErrorCode::UnknownTake, "stale or duplicate START_ACK ignored");
            return;
        }
        if (f.u8(Tag::Accepted).value_or(0) == 0) {
            const std::string why = f.str(Tag::ErrorText).value_or("refused");
            history(tag + "performer REFUSED the start: " + why);
            last_error_ = "performer refused the start: " + why;
            apply(SessionEvent::TakeRefused, "performer refused SCHEDULE_START");
            take_open_ = false;
            return;
        }
        take_.peer_start_ack = true;
        take_.start_ack_rx_ns = time::monotonic_ns();
        take_.peer_planned_start_ns = f.i64(Tag::PlannedLocalNs).value_or(0);
        PortTakeSpec spec;
        spec.take_id = take_.take_id;
        spec.session_id = session_id_;
        spec.role = Role::Producer;
        spec.max_take_seconds = cfg_.timing.max_take_seconds;
        spec.start_at_ns = take_.start_at_local_ns;
        std::string error;
        if (!port_.schedule_take(spec, error)) {
            Frame c;
            c.type = MsgType::Cancel;
            c.set_u32(Tag::TakeId, take_.take_id);
            c.set_u16(Tag::ErrorCode, static_cast<std::uint16_t>(ErrorCode::DiskWrite));
            send(std::move(c));
            last_error_ = "local recording could not be scheduled: " + error;
            history(tag + "local schedule FAILED (" + error + "); CANCEL sent");
            apply(SessionEvent::TakeRefused, "local schedule failed");
            take_open_ = false;
            return;
        }
        apply(SessionEvent::StartAckReceived, "performer confirmed the start time");
        history(tag + "START_ACK received; both scheduled");
        return;
    }
    case MsgType::TakeStarted:
        if (!current || take_.peer_started) {
            ++duplicates_;
            return;
        }
        take_.peer_started = true;
        take_.peer_started_rx_ns = time::monotonic_ns();
        take_.peer_first_frame = f.u64(Tag::FirstFrame).value_or(0);
        take_.peer_first_sample_ns = f.i64(Tag::FirstSampleNs).value_or(0);
        take_.peer_late_frames = f.u64(Tag::LateFrames).value_or(0);
        history(tag + "performer CONFIRMED its recording started" +
                (take_.peer_late_frames ? " (late by " + std::to_string(take_.peer_late_frames) + " frames)" : ""));
        compute_start_offset();
        return;
    case MsgType::StopAck:
        // A re-sent STOP can be acknowledged after the take was completed here (report timed out).
        if (take == 0 || take != take_.take_id || take_.peer_stop_ack) {
            ++duplicates_;
            return;
        }
        take_.peer_stop_ack = f.u8(Tag::Accepted).value_or(0) != 0;
        take_.stop_ack_rx_ns = time::monotonic_ns();
        history(tag + (take_.peer_stop_ack ? "STOP_ACK received" : "performer refused STOP: " + f.str(Tag::ErrorText).value_or("")));
        return;
    case MsgType::LocalStop:
        history(tag + "performer stopped its own recording: " + f.str(Tag::StopReason).value_or(""));
        return;
    case MsgType::TakeFinalised:
        if (take != take_.take_id || take_.peer_finalised) {
            ++duplicates_;
            return;
        }
        take_.peer_finalised = true;
        take_.peer_finalised_rx_ns = time::monotonic_ns();
        stop_owed_ = false;
        take_.peer_status = static_cast<TakeStatus>(f.u8(Tag::Status).value_or(0));
        take_.peer_frames = f.u64(Tag::Frames).value_or(0);
        history(tag + "performer's take " + std::string(take_status_name(take_.peer_status)) + ", " +
                std::to_string(take_.peer_frames) + " frames");
        maybe_complete();
        return;
    default:
        ++refused_;
        refuse(f, ErrorCode::ProtocolMalformed, "message not valid for the producer");
        return;
    }
}

void SessionController::performer_frame(const Frame& f) {
    const std::uint32_t take = f.u32(Tag::TakeId).value_or(0);
    const std::int64_t now = time::monotonic_ns();
    switch (f.type) {
    case MsgType::Arm: {
        if (take <= last_take_id_) {
            ++duplicates_;
            reply(MsgType::ArmAck, f.msg_id, take, false, ErrorCode::TakeIdConflict, "take id already used (duplicate or delayed ARM)");
            refuse(f, ErrorCode::TakeIdConflict, "duplicate or delayed ARM");
            return;
        }
        update_readiness();
        const session::Transition t = session::performer_transition(state_, SessionEvent::ArmReceived);
        if (!t.valid) {
            const ErrorCode code = !consent_ ? ErrorCode::NoConsent
                                   : state_ == SessionState::NotReady ? ErrorCode::NotReady
                                                                      : ErrorCode::Busy;
            const std::string text = state_ == SessionState::NotReady ? "not ready: " + join_reasons(reasons_)
                                                                      : "busy (" + std::string(session::session_state_name(state_)) + ")";
            reply(MsgType::ArmAck, f.msg_id, take, false, code, text);
            refuse(f, code, text);
            ++invalid_events_;
            return;
        }
        apply(SessionEvent::ArmReceived, "producer armed take " + std::to_string(take));
        take_ = TakeView{};
        take_open_ = true;
        take_.take_id = take;
        take_.arm_rx_ns = now;
        last_take_id_ = take;
        schedule_deadline_ = now + ms(cfg_.arm_to_schedule_timeout_ms);
        reply(MsgType::ArmAck, f.msg_id, take, true, ErrorCode::Ok, "");
        history("take " + std::to_string(take) + ": ARM accepted");
        return;
    }
    case MsgType::ScheduleStart: {
        const bool current = take_open_ && take == take_.take_id;
        if (current && take_.peer_start_ack) {
            // Duplicate SCHEDULE_START: answer again, never schedule a second recording.
            ++duplicates_;
            Frame r;
            r.type = MsgType::StartAck;
            r.ref_id = f.msg_id;
            r.set_u32(Tag::TakeId, take);
            r.set_u8(Tag::Accepted, 1);
            r.set_i64(Tag::PlannedLocalNs, take_.start_at_local_ns);
            send(std::move(r));
            return;
        }
        if (!current || state_ != SessionState::Armed) {
            reply(MsgType::StartAck, f.msg_id, take, false, ErrorCode::UnknownTake, "no armed take with this id");
            refuse(f, ErrorCode::UnknownTake, "SCHEDULE_START for an unknown take");
            return;
        }
        take_.schedule_rx_ns = now;
        const net::LinkStats ls = link_->stats();
        // theta = producer clock - performer clock, so the producer's time T is T - theta here.
        const std::int64_t start_local = f.i64(Tag::StartAtNs).value_or(0) - ls.theta_ns;
        if (ls.offset_samples < cfg_.min_offset_samples) {
            reply(MsgType::StartAck, f.msg_id, take, false, ErrorCode::NotReady, "clock offset not yet measured");
            apply(SessionEvent::TakeRefused, "no clock offset yet");
            take_open_ = false;
            return;
        }
        if (start_local - now < ms(cfg_.timing.arm_ack_margin_ms)) {
            reply(MsgType::StartAck, f.msg_id, take, false, ErrorCode::ArmTooLate,
                  "start time already passed or less than " + std::to_string(cfg_.timing.arm_ack_margin_ms) + " ms away");
            refuse(f, ErrorCode::ArmTooLate, "start too late");
            apply(SessionEvent::TakeRefused, "start time too late");
            take_open_ = false;
            return;
        }
        PortTakeSpec spec;
        spec.take_id = take;
        spec.session_id = session_id_;
        spec.role = Role::Performer;
        spec.max_take_seconds = cfg_.timing.max_take_seconds;
        spec.start_at_ns = start_local;
        std::string error;
        if (!port_.schedule_take(spec, error)) {
            reply(MsgType::StartAck, f.msg_id, take, false, ErrorCode::DiskWrite, error);
            refuse(f, ErrorCode::DiskWrite, "local schedule failed: " + error);
            apply(SessionEvent::TakeRefused, "local schedule failed");
            take_open_ = false;
            return;
        }
        apply(SessionEvent::ScheduleReceived, "start scheduled");
        take_.peer_start_ack = true;  // here: "we acknowledged"
        take_.start_at_local_ns = start_local;
        take_.theta_ns = ls.theta_ns;
        take_.theta_unc_ns = ls.theta_uncertainty_ns;
        take_.offset_samples = ls.offset_samples;
        Frame r;
        r.type = MsgType::StartAck;
        r.ref_id = f.msg_id;
        r.set_u32(Tag::TakeId, take);
        r.set_u8(Tag::Accepted, 1);
        r.set_i64(Tag::PlannedLocalNs, start_local);
        r.set_i64(Tag::ThetaNs, ls.theta_ns);
        r.set_i64(Tag::UncertaintyNs, ls.theta_uncertainty_ns);
        send(std::move(r));
        take_.start_ack_sent_ns = time::monotonic_ns();
        history("take " + std::to_string(take) + ": start scheduled in " +
                std::to_string((start_local - now) / 1'000'000) + " ms (clock offset " +
                std::to_string(ls.theta_ns / 1000) + " us +/- " + std::to_string(ls.theta_uncertainty_ns / 1000) + " us)");
        return;
    }
    case MsgType::Cancel: {
        if (take_open_ && take == take_.take_id &&
            (state_ == SessionState::Armed || state_ == SessionState::Scheduled)) {
            port_.cancel_take();
            apply(SessionEvent::CancelReceived, "producer cancelled take " + std::to_string(take));
            take_open_ = false;
            take_.cancelled = true;
            take_.cancel_reason = "cancelled by the producer";
            history("take " + std::to_string(take) + ": cancelled by the producer");
            log_take_timing("cancelled");
        } else if (take_open_ && take == take_.take_id && state_ == SessionState::Recording) {
            // The CANCEL crossed the start (Stop pressed at the last moment): keep what was recorded.
            port_.schedule_stop(now, true);
            take_.stop_cmd_ns = now;
            take_.stop_at_local_ns = now;
            apply(SessionEvent::StopReceived, "CANCEL arrived after the local start");
            history("take " + std::to_string(take) + ": CANCEL arrived after the local start; take stopped and saved");
        } else {
            ++duplicates_;
        }
        return;
    }
    case MsgType::StopSchedule: {
        const bool current = take_open_ && take == take_.take_id;
        if (current && (state_ == SessionState::Stopping || state_ == SessionState::Finalising ||
                        state_ == SessionState::Completed || take_.stop_sent)) {
            ++duplicates_;
            reply(MsgType::StopAck, f.msg_id, take, true, ErrorCode::Ok, "");  // idempotent
            return;
        }
        if (!current || state_ != SessionState::Recording) {
            reply(MsgType::StopAck, f.msg_id, take, false, ErrorCode::UnknownTake, "no recording take with this id");
            refuse(f, ErrorCode::UnknownTake, "STOP for an unknown take");
            return;
        }
        const std::int64_t stop_local = f.i64(Tag::StopAtNs).value_or(0) - link_->stats().theta_ns;
        port_.schedule_stop(std::max(stop_local, now), true);
        take_.stop_cmd_ns = now;
        take_.stop_at_local_ns = std::max(stop_local, now);
        apply(SessionEvent::StopReceived, "producer stopped take " + std::to_string(take));
        take_.stop_sent = true;  // here: "stop accepted"
        reply(MsgType::StopAck, f.msg_id, take, true, ErrorCode::Ok, "");
        history("take " + std::to_string(take) + ": stop scheduled by the producer");
        return;
    }
    default:
        ++refused_;
        refuse(f, ErrorCode::ProtocolMalformed, "message not valid for the performer");
        return;
    }
}

void SessionController::handle_port_event(const PortEvent& e) {
    if (!take_open_ || e.take_id != take_.take_id) {
        log_.log(log::Level::Warn, "session", "stale_recorder_event", "recorder event for another take",
                 {{"take", std::to_string(e.take_id)}});
        return;
    }
    const std::string tag = "take " + std::to_string(e.take_id) + ": ";
    if (e.kind == PortEventKind::Started) {
        take_.local_started = true;
        take_.local_first_sample_ns = e.first_sample_ns;
        take_.local_late_frames = e.late_frames;
        take_.local_started_seen_ns = time::monotonic_ns();
        take_.local_first_frame = e.first_frame;
        take_.device_period_frames = e.device_period_frames;
        take_.device_periods = e.device_periods;
        apply(SessionEvent::LocalTakeStarted, "local recording started");
        history(tag + "LOCAL recording started" +
                (e.late_frames ? " (late by " + std::to_string(e.late_frames) + " frames)" : ""));
        if (cfg_.role == Role::Performer) {
            Frame f;
            f.type = MsgType::TakeStarted;
            f.set_u32(Tag::TakeId, e.take_id);
            f.set_u64(Tag::FirstFrame, e.first_frame);
            f.set_i64(Tag::FirstSampleNs, e.first_sample_ns);
            f.set_u64(Tag::LateFrames, e.late_frames);
            send_or_queue(std::move(f));
        }
        compute_start_offset();
        if (stop_after_start_ && cfg_.role == Role::Producer) {
            stop_after_start_ = false;
            std::string ignored;
            stop_take(ignored);
        }
        return;
    }
    // Finalised (or cancelled)
    if (e.status == TakeStatus::Cancelled) {
        history(tag + "local take cancelled (no audio file)");
        return;
    }
    take_.local_finalised = true;
    take_.local_finalised_ns = time::monotonic_ns();
    take_.local_status = e.status;
    take_.local_frames = e.frames;
    take_.local_file = e.file;
    take_.local_error = e.error;
    const bool early = state_ == SessionState::Recording;
    if (early) {
        apply(SessionEvent::LocalFault, "local take ended early: " + e.stop_reason);
        if (cfg_.role == Role::Producer) {
            // Make the performer stop too, so both takes cover the same span.
            send_stop_schedule(time::monotonic_ns() + ms(cfg_.timing.stop_lead_ms));
        } else {
            Frame f;
            f.type = MsgType::LocalStop;
            f.set_u32(Tag::TakeId, take_.take_id);
            f.set_str(Tag::StopReason, e.stop_reason + (e.error.empty() ? "" : ": " + e.error));
            send_or_queue(std::move(f));
        }
    }
    apply(SessionEvent::LocalFinalised, "local take " + std::string(take_status_name(e.status)));
    history(tag + "LOCAL take " + std::string(take_status_name(e.status)) + (e.finalised ? " (finalised)" : " (NOT finalised)") +
            ", " + std::to_string(e.frames) + " frames" + (e.error.empty() ? "" : ", " + e.error));
    if (cfg_.role == Role::Performer) {
        Frame f;
        f.type = MsgType::TakeFinalised;
        f.set_u32(Tag::TakeId, e.take_id);
        f.set_u8(Tag::Status, static_cast<std::uint8_t>(e.status));
        f.set_u64(Tag::Frames, e.frames);
        f.set_str(Tag::StopReason, e.stop_reason);
        send_or_queue(std::move(f));
        take_open_ = false;
        log_take_timing(std::string(take_status_name(e.status)));
    } else {
        maybe_complete();
    }
}

// Producer: tell the performer to stop the current take at stop_at (this PC's clock). If there is
// no connection the stop is owed and re-sent, with a new stop time, when the performer reconnects;
// the performer's take is then longer than the producer's, which its report shows.
bool SessionController::send_stop_schedule(std::int64_t stop_at) {
    Frame f;
    f.type = MsgType::StopSchedule;
    f.set_u32(Tag::TakeId, take_.take_id);
    f.set_i64(Tag::StopAtNs, stop_at);
    take_.stop_cmd_ns = time::monotonic_ns();
    take_.stop_at_local_ns = stop_at;
    take_.stop_sent = send(std::move(f));
    stop_owed_ = !take_.stop_sent;
    stop_ack_deadline_ = time::monotonic_ns() + ms(2000);
    peer_report_deadline_ = stop_at + ms(cfg_.timing.finalise_report_wait_ms);
    return take_.stop_sent;
}

void SessionController::maybe_complete() {
    if (cfg_.role != Role::Producer || state_ != SessionState::Finalising || !take_.local_finalised) {
        return;
    }
    if (take_.peer_finalised || take_.peer_report_timed_out) {
        apply(SessionEvent::TakeComplete, take_.peer_finalised ? "both takes reported" : "performer report timed out");
        take_open_ = false;
        log_take_timing(take_.peer_finalised ? "complete" : "performer report timed out");
    }
}

void SessionController::compute_start_offset() {
    if (cfg_.role != Role::Producer || !take_.local_started || !take_.peer_started || !link_) {
        return;
    }
    const net::LinkStats ls = link_->stats();  // theta = performer - producer (producer is requester)
    const double delta_ns = static_cast<double>(take_.peer_first_sample_ns - ls.theta_ns - take_.local_first_sample_ns);
    take_.has_start_offset = true;
    take_.start_offset_ms = delta_ns / 1e6;
    take_.start_offset_unc_ms = static_cast<double>(ls.theta_uncertainty_ns) / 1e6;
    char text[160];
    std::snprintf(text, sizeof text,
                  "take %u: estimated recording-start offset (performer - producer) %.3f ms +/- %.3f ms "
                  "(clock-offset uncertainty only; device input latency not included)",
                  take_.take_id, take_.start_offset_ms, take_.start_offset_unc_ms);
    history(text);
    log_.log(log::Level::Info, "session", "start_offset_estimate", text);
}

void SessionController::check_timers() {
    const std::int64_t now = time::monotonic_ns();
    if (cfg_.role == Role::Producer && take_open_) {
        if (state_ == SessionState::Armed && !take_.peer_arm_ack && now > arm_ack_deadline_) {
            Frame c;
            c.type = MsgType::Cancel;
            c.set_u32(Tag::TakeId, take_.take_id);
            c.set_u16(Tag::ErrorCode, static_cast<std::uint16_t>(ErrorCode::Timeout));
            send(std::move(c));
            last_error_ = "performer did not confirm ARM in time";
            history("take " + std::to_string(take_.take_id) + ": no ARM_ACK in time; CANCEL sent");
            apply(SessionEvent::TakeRefused, "ARM_ACK timeout");
            take_open_ = false;
        } else if (state_ == SessionState::Armed && take_.peer_arm_ack && !take_.peer_start_ack && now > start_ack_deadline_) {
            Frame c;
            c.type = MsgType::Cancel;
            c.set_u32(Tag::TakeId, take_.take_id);
            c.set_u16(Tag::ErrorCode, static_cast<std::uint16_t>(ErrorCode::Timeout));
            send(std::move(c));
            last_error_ = "performer did not confirm the start time in time";
            history("take " + std::to_string(take_.take_id) + ": no START_ACK before the start; CANCEL sent");
            apply(SessionEvent::TakeRefused, "START_ACK timeout");
            take_open_ = false;
        } else if (state_ == SessionState::Finalising && !take_.peer_finalised && now > peer_report_deadline_ &&
                   !take_.peer_report_timed_out) {
            take_.peer_report_timed_out = true;
            history("take " + std::to_string(take_.take_id) + ": no report from the performer: its take status is UNKNOWN");
            maybe_complete();
        } else if (state_ == SessionState::Stopping && take_.stop_sent && !take_.peer_stop_ack && now > stop_ack_deadline_ &&
                   stop_ack_deadline_ != 0) {
            history("take " + std::to_string(take_.take_id) + ": no STOP_ACK yet (performer may not have stopped)");
            stop_ack_deadline_ = 0;
        }
    }
    if (cfg_.role == Role::Performer && take_open_ && state_ == SessionState::Armed && now > schedule_deadline_) {
        history("take " + std::to_string(take_.take_id) + ": no SCHEDULE_START after ARM; disarmed");
        apply(SessionEvent::ArmExpired, "no schedule after ARM");
        take_open_ = false;
    }
}

void SessionController::cancel_before_start(const std::string& why) {
    Frame c;
    c.type = MsgType::Cancel;
    c.set_u32(Tag::TakeId, take_.take_id);
    c.set_u16(Tag::ErrorCode, static_cast<std::uint16_t>(ErrorCode::Cancelled));
    send(std::move(c));
    port_.cancel_take();
    take_.cancelled = true;
    take_.cancel_reason = why;
    history("take " + std::to_string(take_.take_id) + ": " + why + "; CANCEL sent, nothing recorded");
    apply(SessionEvent::TakeRefused, why);
    take_open_ = false;
    log_take_timing("cancelled");
}

void SessionController::log_take_timing(const std::string& outcome) {
    const TakeView& t = take_;
    const bool producer = cfg_.role == Role::Producer;
    std::vector<log::Field> fields{
        {"take", std::to_string(t.take_id)},
        {"session", session_id_},
        {"role", producer ? "producer" : "performer"},
        {"outcome", outcome},
        {"start_lead_ms", std::to_string(t.start_lead_ms)},
        {"start_at_local_ns", ns_text(t.start_at_local_ns)},
        {"local_first_sample_ns", ns_text(t.local_first_sample_ns)},
        {"local_first_frame", std::to_string(t.local_first_frame)},
        {"local_late_frames", std::to_string(t.local_late_frames)},
        {"first_sample_minus_scheduled_ms", ms_between(t.start_at_local_ns, t.local_first_sample_ns)},
        {"local_start_seen_ns", ns_text(t.local_started_seen_ns)},
        {"stop_cmd_ns", ns_text(t.stop_cmd_ns)},
        {"stop_at_local_ns", ns_text(t.stop_at_local_ns)},
        {"local_finalised_ns", ns_text(t.local_finalised_ns)},
        {"local_status", t.local_finalised ? std::string(take_status_name(t.local_status)) : std::string("none")},
        {"local_frames", std::to_string(t.local_frames)},
        {"device_period_frames", std::to_string(t.device_period_frames)},
        {"device_periods", std::to_string(t.device_periods)},
        {"theta_ns", ns_text(t.theta_ns)},
        {"theta_uncertainty_ns", ns_text(t.theta_unc_ns)},
        {"offset_samples", std::to_string(t.offset_samples)},
    };
    if (producer) {
        fields.insert(fields.end(), {
            {"arm_sent_ns", ns_text(t.arm_sent_ns)},
            {"arm_ack_rx_ns", ns_text(t.arm_ack_rx_ns)},
            {"schedule_sent_ns", ns_text(t.schedule_sent_ns)},
            {"start_ack_rx_ns", ns_text(t.start_ack_rx_ns)},
            {"arm_to_ack_ms", ms_between(t.arm_sent_ns, t.arm_ack_rx_ns)},
            {"schedule_to_ack_ms", ms_between(t.schedule_sent_ns, t.start_ack_rx_ns)},
            {"ack_margin_before_start_ms", ms_between(t.start_ack_rx_ns, t.start_at_local_ns)},
            {"peer_planned_start_ns", ns_text(t.peer_planned_start_ns)},
            {"peer_first_sample_ns", ns_text(t.peer_first_sample_ns)},
            {"peer_first_frame", std::to_string(t.peer_first_frame)},
            {"peer_late_frames", std::to_string(t.peer_late_frames)},
            {"peer_started_rx_ns", ns_text(t.peer_started_rx_ns)},
            {"stop_ack_rx_ns", ns_text(t.stop_ack_rx_ns)},
            {"peer_finalised_rx_ns", ns_text(t.peer_finalised_rx_ns)},
            {"peer_status", t.peer_finalised ? std::string(take_status_name(t.peer_status)) : std::string("unknown")},
            {"peer_frames", std::to_string(t.peer_frames)},
            {"start_offset_estimate_ms", t.has_start_offset ? ms_value(t.start_offset_ms) : "n/a"},
            {"start_offset_uncertainty_ms", t.has_start_offset ? ms_value(t.start_offset_unc_ms) : "n/a"},
        });
    } else {
        fields.insert(fields.end(), {
            {"arm_rx_ns", ns_text(t.arm_rx_ns)},
            {"schedule_rx_ns", ns_text(t.schedule_rx_ns)},
            {"start_ack_sent_ns", ns_text(t.start_ack_sent_ns)},
            {"schedule_rx_to_start_ms", ms_between(t.schedule_rx_ns, t.start_at_local_ns)},
        });
    }
    if (t.cancelled) {
        fields.push_back({"cancel_reason", t.cancel_reason});
    }
    log::Record r;
    r.mono_ns = time::monotonic_ns();
    r.utc_ms = time::utc_now_ms();
    r.level = log::Level::Info;
    r.component = "session";
    r.event = "take_timing";
    r.message = "take timing record (monotonic ns of this PC)";
    r.fields = std::move(fields);
    log_.submit(std::move(r));
    history("take " + std::to_string(t.take_id) + " timing: first sample " +
            ms_between(t.start_at_local_ns, t.local_first_sample_ns) + " ms after the scheduled time (" +
            std::to_string(t.local_late_frames) + " late frames), " + std::to_string(t.local_frames) + " frames, " + outcome);
}

ControllerSnapshot SessionController::snapshot() const {
    ControllerSnapshot s;
    s.role = cfg_.role;
    s.link = link_state_;
    s.session = state_;
    s.not_ready_reasons = reasons_;
    s.session_id = session_id_;
    if (link_ && cfg_.role == Role::Producer) {
        s.pairing_code = link_->pairing_code();
    }
    s.bind_address = bind_address_;
    s.port = port_number_;
    if (link_) {
        const net::JoinInfo info = link_->join_info();
        s.peer_name = info.peer_name;
        s.peer_address = info.peer_address;
        s.link_stats = link_->stats();
    }
    s.local_consent = consent_;
    s.peer_ready = peer_ready_;
    s.peer_consent = peer_consent_;
    s.peer_reasons = peer_reasons_;
    s.local_checks = local_checks_;
    s.peer_checks = peer_checks_;
    s.start_lead_ms = cfg_.timing.start_lead_ms;
    s.min_start_lead_ms = cfg_.role == Role::Producer ? min_start_lead_ms() : 0;
    s.take = take_;
    s.last_error = last_error_;
    s.invalid_events = invalid_events_;
    s.refused_messages = refused_;
    s.duplicate_messages = duplicates_;
    s.recorder_description = port_.description();
    return s;
}

}  // namespace rr::control
