#include "rr/network/control_link.hpp"

#include <algorithm>
#include <cstdio>
#include <random>

#include "rr/shared/build_info.hpp"
#include "rr/shared/clock.hpp"

namespace rr::net {
namespace {

using session::LinkState;

std::int64_t ms_to_ns(std::uint32_t ms) {
    return static_cast<std::int64_t>(ms) * 1'000'000;
}

}  // namespace

std::string make_pairing_code() {
    std::random_device rd;
    std::uniform_int_distribution<int> digit(0, 9);
    std::string code;
    for (int i = 0; i < 6; ++i) {
        code += static_cast<char>('0' + digit(rd));
    }
    return code;
}

std::string make_random_token(std::size_t hex_digits) {
    static const char* const kHex = "0123456789abcdef";
    std::random_device rd;
    std::string token;
    while (token.size() < hex_digits) {
        std::uint32_t v = rd();
        for (int i = 0; i < 8 && token.size() < hex_digits; ++i) {
            token += kHex[v & 0xF];
            v >>= 4;
        }
    }
    return token;
}

std::unique_ptr<ControlLink> ControlLink::server(const ServerParams& params) {
    std::unique_ptr<ControlLink> link(new ControlLink());
    link->is_server_ = true;
    link->sp_ = params;
    link->t_ = params.timings;
    return link;
}

std::unique_ptr<ControlLink> ControlLink::client(const ClientParams& params) {
    std::unique_ptr<ControlLink> link(new ControlLink());
    link->is_server_ = false;
    link->cp_ = params;
    link->t_ = params.timings;
    return link;
}

ControlLink::~ControlLink() {
    stop();
}

bool ControlLink::start(std::string& error) {
    if (running_.load()) {
        return true;
    }
    if (!init_sockets(error)) {
        return false;
    }
    if (is_server_) {
        if (!listener_.listen_on(sp_.bind_address, sp_.port, error)) {
            return false;
        }
        new_pairing_code();
        {
            std::lock_guard<std::mutex> lock(mutex_);
            join_.session_id = sp_.session_id;
        }
        set_state(LinkState::Listening, "listening on " + sp_.bind_address + ":" + std::to_string(sp_.port));
    } else {
        if (!is_valid_ipv4(cp_.host_address)) {
            error = "not an IPv4 address: " + cp_.host_address;
            return false;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        client_id_ = make_random_token(8);
    }
    running_.store(true);
    thread_ = std::thread([this] { run(); });
    return true;
}

void ControlLink::stop(ErrorCode reason) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        stop_with_close_ = true;
        stop_reason_ = reason;
    }
    if (running_.exchange(false) && thread_.joinable()) {
        thread_.join();
    } else if (thread_.joinable()) {
        thread_.join();
    }
}

bool ControlLink::send(Frame frame) {
    if (state_.load() != LinkState::Connected) {
        return false;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    app_outbox_.push_back(std::move(frame));
    return true;
}

std::vector<LinkEvent> ControlLink::poll_events() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<LinkEvent> out(events_.begin(), events_.end());
    events_.clear();
    return out;
}

LinkStats ControlLink::stats() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return stats_;
}

JoinInfo ControlLink::join_info() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return join_;
}

std::string ControlLink::new_pairing_code() {
    std::lock_guard<std::mutex> lock(mutex_);
    pairing_code_ = make_pairing_code();
    code_created_ns_ = time::monotonic_ns();
    code_used_ = false;
    failed_joins_ = 0;
    return pairing_code_;
}

std::string ControlLink::pairing_code() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return pairing_code_;
}

void ControlLink::set_state(LinkState s, const std::string& why) {
    const LinkState old = state_.exchange(s);
    if (old != s) {
        LinkEvent e;
        e.kind = LinkEventKind::StateChanged;
        e.state = s;
        e.text = why;
        push_event(std::move(e));
    }
}

void ControlLink::push_event(LinkEvent e) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (events_.size() >= 4096) {
        events_.pop_front();  // the application stopped polling; keep the newest
    }
    events_.push_back(std::move(e));
}

void ControlLink::queue_frame(Frame f) {
    f.msg_id = next_msg_id_++;
    f.set_i64(Tag::SentNs, time::monotonic_ns());
    const std::vector<std::uint8_t> bytes = encode(f);
    outbuf_.insert(outbuf_.end(), bytes.begin(), bytes.end());
    std::lock_guard<std::mutex> lock(mutex_);
    ++stats_.frames_sent;
}

void ControlLink::send_error_and_close(ErrorCode code, const std::string& text, std::uint32_t ref_id) {
    Frame e;
    e.type = MsgType::Error;
    e.ref_id = ref_id;
    e.set_u16(Tag::ErrorCode, static_cast<std::uint16_t>(code));
    e.set_str(Tag::ErrorText, text);
    queue_frame(std::move(e));
    phase_ = Phase::Closing;
    phase_deadline_ns_ = time::monotonic_ns() + 500'000'000;  // flush, then close
    LinkEvent ev;
    ev.kind = LinkEventKind::Info;
    ev.code = code;
    ev.text = "refused peer: " + std::string(error_code_name(code)) + " (" + text + ")";
    push_event(std::move(ev));
}

void ControlLink::close_connection(const std::string& why, bool lost) {
    const bool was_joined = phase_ == Phase::Joined;
    conn_.close();
    outbuf_.clear();
    decoder_ = FrameDecoder();
    phase_ = Phase::Idle;
    const std::int64_t now = time::monotonic_ns();
    if (is_server_) {
        set_state(ever_joined_ ? LinkState::LinkLost : LinkState::Listening, why);
        return;
    }
    if (lost && ever_joined_) {
        if (was_joined || link_lost_since_ns_ == 0) {
            link_lost_since_ns_ = now;
        }
        next_reconnect_ns_ = now + ms_to_ns(t_.reconnect_interval_ms);
        set_state(LinkState::LinkLost, why);
    } else {
        set_state(LinkState::Disconnected, why);
    }
}

void ControlLink::start_client_connect() {
    std::string error;
    decoder_ = FrameDecoder();
    outbuf_.clear();
    next_msg_id_ = 1;
    last_rx_msg_id_ = 0;
    if (ever_joined_) {
        std::lock_guard<std::mutex> lock(mutex_);
        ++stats_.reconnect_attempts;
    }
    if (!conn_.connect_start(cp_.host_address, cp_.port, error)) {
        close_connection(error, true);
        return;
    }
    phase_ = Phase::Connecting;
    phase_deadline_ns_ = time::monotonic_ns() + ms_to_ns(t_.connect_timeout_ms);
    if (!ever_joined_) {
        set_state(LinkState::Connecting, "connecting to " + cp_.host_address + ":" + std::to_string(cp_.port));
    }
}

void ControlLink::run() {
    if (!is_server_) {
        start_client_connect();
    }
    std::vector<std::uint8_t> buffer(4096);
    while (running_.load()) {
        if (drop_requested_.exchange(false) && conn_.valid()) {
            close_connection("test: connection dropped", true);
        }
        {
            // Application frames are sent only on a joined connection; anything queued for a
            // connection that has since been lost is discarded (the controller resynchronises).
            std::deque<Frame> pending;
            {
                std::lock_guard<std::mutex> lock(mutex_);
                pending.swap(app_outbox_);
            }
            for (Frame& f : pending) {
                if (phase_ == Phase::Joined) {
                    queue_frame(std::move(f));
                }
            }
        }
        std::int64_t now = time::monotonic_ns();
        if (!is_server_ && phase_ == Phase::Idle && ever_joined_ && state_.load() == LinkState::LinkLost &&
            now >= next_reconnect_ns_) {
            if (now - link_lost_since_ns_ > ms_to_ns(t_.reconnect_give_up_ms)) {
                ever_joined_ = false;
                set_state(LinkState::Disconnected, "gave up reconnecting");
            } else {
                start_client_connect();
            }
        }

        std::vector<TcpSocket*> readers;
        std::vector<TcpSocket*> writers;
        if (listener_.valid()) {
            readers.push_back(&listener_);
        }
        if (conn_.valid()) {
            if (phase_ == Phase::Connecting) {
                writers.push_back(&conn_);
            } else {
                readers.push_back(&conn_);
                if (!outbuf_.empty()) {
                    writers.push_back(&conn_);
                }
            }
        }
        TcpSocket::wait(readers, writers, 20);
        now = time::monotonic_ns();

        // ---- server: accept ----
        if (listener_.valid() && TcpSocket::is_readable(listener_)) {
            std::string peer;
            std::string error;
            TcpSocket incoming = listener_.accept_pending(peer, error);
            if (incoming.valid()) {
                if (conn_.valid()) {
                    // One performer per session: tell the newcomer and close it.
                    Frame e;
                    e.type = MsgType::Error;
                    e.msg_id = 1;
                    e.set_i64(Tag::SentNs, now);
                    e.set_u16(Tag::ErrorCode, static_cast<std::uint16_t>(ErrorCode::SessionFull));
                    e.set_str(Tag::ErrorText, "this session already has a performer");
                    const auto bytes = encode(e);
                    std::string ignored;
                    incoming.send_some(bytes.data(), bytes.size(), ignored);
                    incoming.shutdown_send();
                    rejecting_.push_back(Rejecting{std::move(incoming), now + 1'000'000'000});
                    LinkEvent ev;
                    ev.kind = LinkEventKind::Info;
                    ev.text = "refused a second connection from " + peer + " (session full)";
                    push_event(std::move(ev));
                } else {
                    conn_ = std::move(incoming);
                    conn_peer_ = peer;
                    decoder_ = FrameDecoder();
                    outbuf_.clear();
                    next_msg_id_ = 1;
                    last_rx_msg_id_ = 0;
                    last_rx_ns_ = now;
                    phase_ = Phase::AwaitHello;
                    phase_deadline_ns_ = now + ms_to_ns(t_.handshake_timeout_ms);
                    if (!ever_joined_) {
                        set_state(LinkState::Handshaking, "connection from " + peer);
                    }
                }
            }
        }

        // ---- refused extra connections: drain until the peer closes or the grace period ends ----
        for (auto it = rejecting_.begin(); it != rejecting_.end();) {
            std::string ignored;
            std::uint8_t sink[512];
            long n = 0;
            while ((n = it->socket.recv_some(sink, sizeof sink, ignored)) > 0) {
            }
            if (n < 0 || now > it->close_at_ns) {
                it->socket.close();
                it = rejecting_.erase(it);
            } else {
                ++it;
            }
        }

        // ---- client: connect progress ----
        if (phase_ == Phase::Connecting) {
            std::string error;
            const int r = conn_.connect_finished(error);
            if (r == 1) {
                conn_peer_ = cp_.host_address;
                last_rx_ns_ = now;
                Frame hello;
                hello.type = MsgType::Hello;
                hello.set_u16(Tag::ProtoMajor, test_major_ ? test_major_ : kProtocolMajor);
                hello.set_u16(Tag::ProtoMinor, kProtocolMinor);
                hello.set_u8(Tag::Role, 2);
                hello.set_str(Tag::AppVersion, cp_.app_version);
                queue_frame(std::move(hello));
                phase_ = Phase::AwaitHelloAck;
                phase_deadline_ns_ = now + ms_to_ns(t_.handshake_timeout_ms);
                if (!ever_joined_) {
                    set_state(LinkState::Handshaking, "connected, checking versions");
                }
            } else if (r < 0 || now > phase_deadline_ns_) {
                close_connection(r < 0 ? "could not connect: " + error : "could not connect: timed out", true);
            }
        }

        // ---- read ----
        if (conn_.valid() && phase_ != Phase::Connecting) {
            // Read everything available first. A peer often sends a last frame (ERROR,
            // SESSION_CLOSED) and closes at once: those frames must be decoded and acted on
            // BEFORE the close is handled, or the reason for the close would be lost.
            std::string read_error;
            bool peer_closed = false;
            for (;;) {
                const long n = conn_.recv_some(buffer.data(), buffer.size(), read_error);
                if (n > 0) {
                    decoder_.feed(buffer.data(), static_cast<std::size_t>(n));
                    continue;
                }
                peer_closed = n == -2;
                if (n != -1) {
                    read_error.clear();
                }
                break;
            }
            Frame f;
            std::string error;
            while (conn_.valid()) {
                const FrameDecoder::Result r = decoder_.next(f, error);
                if (r == FrameDecoder::Result::NeedMore) {
                    break;
                }
                if (r == FrameDecoder::Result::Error) {
                    {
                        std::lock_guard<std::mutex> lock(mutex_);
                        ++stats_.protocol_errors;
                    }
                    LinkEvent ev;
                    ev.kind = LinkEventKind::ProtocolError;
                    ev.text = "malformed control data: " + error;
                    push_event(std::move(ev));
                    close_connection("malformed control data", true);
                    break;
                }
                handle_frame(f, now);
            }
            // Only now act on the close/error (handling a frame may already have closed it).
            if (conn_.valid() && phase_ != Phase::Closing) {
                if (peer_closed) {
                    close_connection("the other side closed the connection", true);
                } else if (!read_error.empty()) {
                    close_connection(read_error, true);
                }
            }
        }

        // ---- write ----
        if (conn_.valid() && phase_ != Phase::Connecting && !outbuf_.empty()) {
            std::string error;
            const long n = conn_.send_some(outbuf_.data(), outbuf_.size(), error);
            if (n > 0) {
                outbuf_.erase(outbuf_.begin(), outbuf_.begin() + n);
            } else if (n < 0) {
                close_connection(error, true);
            }
        }

        // ---- timers ----
        if (conn_.valid()) {
            switch (phase_) {
            case Phase::AwaitHello:
            case Phase::AwaitHelloAck:
            case Phase::AwaitJoin:
            case Phase::AwaitJoinAck:
                if (now > phase_deadline_ns_) {
                    close_connection("handshake timed out", true);
                }
                break;
            case Phase::Closing:
                if (outbuf_.empty() || now > phase_deadline_ns_) {
                    if (is_server_) {
                        close_connection("peer refused", false);
                    } else {
                        ever_joined_ = false;
                        close_connection("join refused", false);
                    }
                }
                break;
            case Phase::Joined:
                if (!suspend_heartbeats_.load() && now - last_hb_tx_ns_ >= ms_to_ns(t_.heartbeat_interval_ms)) {
                    Frame hb;
                    hb.type = MsgType::Heartbeat;
                    queue_frame(std::move(hb));
                    last_hb_tx_ns_ = now;
                }
                if (now - last_rx_ns_ > ms_to_ns(t_.link_lost_after_ms)) {
                    close_connection("no message from the other side for " + std::to_string(t_.link_lost_after_ms) +
                                         " ms",
                                     true);
                }
                break;
            default:
                break;
            }
        }
    }

    // ---- shutdown: tell the peer, flush briefly, close ----
    if (conn_.valid() && phase_ == Phase::Joined) {
        Frame bye;
        bye.type = MsgType::SessionClosed;
        ErrorCode reason;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            reason = stop_reason_;
        }
        bye.set_u16(Tag::ErrorCode, static_cast<std::uint16_t>(reason));
        queue_frame(std::move(bye));
        const std::int64_t until = time::monotonic_ns() + 300'000'000;
        while (!outbuf_.empty() && time::monotonic_ns() < until) {
            std::string error;
            const long n = conn_.send_some(outbuf_.data(), outbuf_.size(), error);
            if (n < 0) {
                break;
            }
            outbuf_.erase(outbuf_.begin(), outbuf_.begin() + n);
            if (!outbuf_.empty()) {
                TcpSocket::wait({}, {&conn_}, 20);
            }
        }
        // Graceful close: closing with unread data in the receive buffer (e.g. the peer's
        // heartbeats) makes Windows send a reset, which can destroy SESSION_CLOSED before the
        // peer reads it. Half-close, then drain until the peer closes or 500 ms pass.
        conn_.shutdown_send();
        const std::int64_t drain_until = time::monotonic_ns() + 500'000'000;
        while (time::monotonic_ns() < drain_until) {
            std::string ignored;
            std::uint8_t sink[512];
            const long n = conn_.recv_some(sink, sizeof sink, ignored);
            if (n < 0) {
                break;  // peer closed (-2) or error
            }
            if (n == 0) {
                TcpSocket::wait({&conn_}, {}, 20);
            }
        }
    }
    conn_.close();
    listener_.close();
    phase_ = Phase::Idle;
    set_state(LinkState::Disconnected, "stopped");
}

void ControlLink::handle_frame(Frame& f, std::int64_t arrival_ns) {
    if (f.msg_id <= last_rx_msg_id_) {
        std::lock_guard<std::mutex> lock(mutex_);
        ++stats_.stale_frames_dropped;  // duplicate or out of order: never acted upon
        return;
    }
    last_rx_msg_id_ = f.msg_id;
    last_rx_ns_ = arrival_ns;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        ++stats_.frames_received;
    }
    if (phase_ != Phase::Joined) {
        if (is_server_) {
            server_handle_handshake(f);
        } else {
            client_handle_handshake(f);
        }
        return;
    }
    switch (f.type) {
    case MsgType::Heartbeat: {
        Frame ack;
        ack.type = MsgType::HeartbeatAck;
        ack.ref_id = f.msg_id;
        ack.set_i64(Tag::EchoSentNs, f.i64(Tag::SentNs).value_or(0));
        ack.set_i64(Tag::RecvNs, arrival_ns);
        queue_frame(std::move(ack));  // SentNs (t3) stamped here
        std::lock_guard<std::mutex> lock(mutex_);
        ++stats_.heartbeats_received;
        break;
    }
    case MsgType::HeartbeatAck: {
        const std::int64_t t1 = f.i64(Tag::EchoSentNs).value_or(0);
        const std::int64_t t2 = f.i64(Tag::RecvNs).value_or(0);
        const std::int64_t t3 = f.i64(Tag::SentNs).value_or(0);
        offset_.add_sample(t1, t2, t3, arrival_ns);
        std::lock_guard<std::mutex> lock(mutex_);
        stats_.control_rtt_ns = arrival_ns - t1;
        if (offset_.has_estimate()) {
            stats_.theta_ns = offset_.theta_ns();
            stats_.theta_uncertainty_ns = offset_.uncertainty_ns();
            stats_.offset_samples = offset_.sample_count();
        }
        break;
    }
    case MsgType::SessionClosed: {
        LinkEvent ev;
        ev.kind = LinkEventKind::PeerClosed;
        ev.code = static_cast<ErrorCode>(f.u16(Tag::ErrorCode).value_or(0));
        ev.text = std::string("the other side closed the session (") + std::string(error_code_name(ev.code)) + ")";
        push_event(ev);
        ever_joined_ = false;  // a deliberate close: no reconnect / no resume
        if (is_server_) {
            std::lock_guard<std::mutex> lock(mutex_);
            resume_token_.clear();
        }
        close_connection(ev.text, false);
        break;
    }
    case MsgType::Hello:
    case MsgType::HelloAck:
    case MsgType::Join:
    case MsgType::JoinAck: {
        LinkEvent ev;
        ev.kind = LinkEventKind::Info;
        ev.text = std::string("ignored unexpected ") + msg_type_name(f.type) + " on a joined connection";
        push_event(std::move(ev));
        break;
    }
    default: {
        LinkEvent ev;
        ev.kind = LinkEventKind::FrameReceived;
        ev.frame = f;
        push_event(std::move(ev));
        break;
    }
    }
}

void ControlLink::server_handle_handshake(Frame& f) {
    const std::int64_t now = time::monotonic_ns();
    if (phase_ == Phase::AwaitHello) {
        if (f.type != MsgType::Hello) {
            send_error_and_close(ErrorCode::ProtocolMalformed, "expected HELLO", f.msg_id);
            return;
        }
        const auto major = f.u16(Tag::ProtoMajor).value_or(0);
        const auto minor = f.u16(Tag::ProtoMinor).value_or(0);
        if (major != kProtocolMajor) {
            char text[96];
            std::snprintf(text, sizeof text, "producer speaks protocol %u.%u, performer offered %u.%u",
                          static_cast<unsigned>(kProtocolMajor), static_cast<unsigned>(kProtocolMinor),
                          static_cast<unsigned>(major), static_cast<unsigned>(minor));
            send_error_and_close(ErrorCode::VersionUnsupported, text, f.msg_id);
            return;
        }
        if (f.u8(Tag::Role).value_or(0) != 2) {
            send_error_and_close(ErrorCode::WrongRole, "only a Performer Client can join a Producer Studio", f.msg_id);
            return;
        }
        {
            std::lock_guard<std::mutex> lock(mutex_);
            join_.peer_app_version = f.str(Tag::AppVersion).value_or("");
        }
        Frame ack;
        ack.type = MsgType::HelloAck;
        ack.ref_id = f.msg_id;
        ack.set_u16(Tag::ProtoMajor, kProtocolMajor);
        ack.set_u16(Tag::ProtoMinor, std::min<std::uint16_t>(kProtocolMinor, minor));
        ack.set_str(Tag::AppVersion, sp_.app_version);
        queue_frame(std::move(ack));
        phase_ = Phase::AwaitJoin;
        phase_deadline_ns_ = now + ms_to_ns(t_.handshake_timeout_ms);
        return;
    }
    if (phase_ != Phase::AwaitJoin) {
        return;
    }
    if (f.type != MsgType::Join) {
        send_error_and_close(ErrorCode::ProtocolMalformed, "expected JOIN", f.msg_id);
        return;
    }
    const std::string client_id = f.str(Tag::ClientId).value_or("");
    bool resumed = false;
    std::string reject;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (f.has(Tag::ResumeToken)) {
            if (!resume_token_.empty() && f.str(Tag::ResumeToken).value_or("") == resume_token_ && client_id == client_id_) {
                resumed = true;
            } else {
                reject = "resume refused (session ended or a different performer); join again with a new code";
            }
        } else if (f.has(Tag::PairingCode)) {
            if (failed_joins_ >= t_.max_failed_joins) {
                reject = "too many wrong codes; ask the producer for a new pairing code";
            } else if (code_used_) {
                reject = "pairing code already used; ask the producer for a new code";
            } else if (now - code_created_ns_ > ms_to_ns(t_.pairing_code_ttl_ms)) {
                reject = "pairing code expired; ask the producer for a new code";
            } else if (f.str(Tag::PairingCode).value_or("") != pairing_code_) {
                ++failed_joins_;
                ++stats_.failed_joins;
                reject = "wrong pairing code";
            } else {
                code_used_ = true;
                client_id_ = client_id;
                resume_token_ = make_random_token(32);
            }
        } else {
            reject = "JOIN without pairing code or resume token";
        }
    }
    if (!reject.empty()) {
        send_error_and_close(ErrorCode::BadPairingCode, reject, f.msg_id);
        return;
    }
    Frame ack;
    ack.type = MsgType::JoinAck;
    ack.ref_id = f.msg_id;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        ack.set_str(Tag::SessionId, sp_.session_id);
        ack.set_str(Tag::ResumeToken, resume_token_);
        join_.peer_name = f.str(Tag::DisplayName).value_or("");
        join_.peer_address = conn_peer_;
        join_.max_take_seconds = sp_.max_take_seconds;
        ++stats_.connections;
    }
    ack.set_str(Tag::DisplayName, sp_.producer_name);
    ack.set_u32(Tag::MaxTakeSeconds, sp_.max_take_seconds);
    queue_frame(std::move(ack));
    phase_ = Phase::Joined;
    ever_joined_ = true;
    last_hb_tx_ns_ = 0;
    set_state(LinkState::Connected, resumed ? "performer reconnected" : "performer joined");
    LinkEvent ev;
    ev.kind = LinkEventKind::Joined;
    ev.resumed = resumed;
    ev.text = resumed ? "performer reconnected" : "performer joined";
    push_event(std::move(ev));
}

void ControlLink::client_handle_handshake(Frame& f) {
    const std::int64_t now = time::monotonic_ns();
    if (f.type == MsgType::Error) {
        LinkEvent ev;
        ev.kind = LinkEventKind::JoinRejected;
        ev.code = static_cast<ErrorCode>(f.u16(Tag::ErrorCode).value_or(0));
        ev.text = f.str(Tag::ErrorText).value_or(std::string(error_code_name(ev.code)));
        push_event(ev);
        ever_joined_ = false;  // a refusal is final: no automatic retry
        close_connection(std::string("join refused: ") + std::string(error_code_name(ev.code)) + " - " + ev.text, false);
        return;
    }
    if (phase_ == Phase::AwaitHelloAck) {
        if (f.type != MsgType::HelloAck || f.u16(Tag::ProtoMajor).value_or(0) != kProtocolMajor) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                ++stats_.protocol_errors;
            }
            ever_joined_ = false;
            close_connection("unexpected reply to HELLO", false);
            return;
        }
        {
            std::lock_guard<std::mutex> lock(mutex_);
            join_.peer_app_version = f.str(Tag::AppVersion).value_or("");
        }
        Frame join;
        join.type = MsgType::Join;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            join.set_str(Tag::ClientId, client_id_);
            if (ever_joined_ && !resume_token_.empty()) {
                join.set_str(Tag::ResumeToken, resume_token_);
            } else {
                join.set_str(Tag::PairingCode, cp_.pairing_code);
            }
        }
        join.set_str(Tag::DisplayName, cp_.performer_name);
        queue_frame(std::move(join));
        phase_ = Phase::AwaitJoinAck;
        phase_deadline_ns_ = now + ms_to_ns(t_.handshake_timeout_ms);
        return;
    }
    if (phase_ == Phase::AwaitJoinAck && f.type == MsgType::JoinAck) {
        const bool resumed = ever_joined_;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            join_.session_id = f.str(Tag::SessionId).value_or("");
            join_.peer_name = f.str(Tag::DisplayName).value_or("");
            join_.peer_address = cp_.host_address;
            join_.max_take_seconds = f.u32(Tag::MaxTakeSeconds).value_or(0);
            resume_token_ = f.str(Tag::ResumeToken).value_or("");
            ++stats_.connections;
        }
        phase_ = Phase::Joined;
        ever_joined_ = true;
        link_lost_since_ns_ = 0;
        last_hb_tx_ns_ = 0;
        set_state(LinkState::Connected, resumed ? "reconnected to the producer" : "joined the producer's session");
        LinkEvent ev;
        ev.kind = LinkEventKind::Joined;
        ev.resumed = resumed;
        ev.text = resumed ? "reconnected" : "joined";
        push_event(std::move(ev));
        return;
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        ++stats_.protocol_errors;
    }
    close_connection(std::string("unexpected ") + msg_type_name(f.type) + " during the handshake", true);
}

}  // namespace rr::net
