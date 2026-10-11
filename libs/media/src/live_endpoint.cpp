#include "rr/media/live_endpoint.hpp"

#include "rr/shared/clock.hpp"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <timeapi.h>
#endif

namespace rr::media {

LiveEndpoint::LiveEndpoint(log::Logger* logger) : log_(logger) {}

LiveEndpoint::~LiveEndpoint() {
    stop();
}

bool LiveEndpoint::start(const LiveEndpointConfig& config, audio::LiveTap* tap, std::string& error) {
    stop();
    if (config.session_id == 0 || config.media_port == 0) {
        error = "live media needs a session id and a media port";
        return false;
    }
    if (!config.has_outgoing && !config.has_incoming) {
        error = "live media endpoint without any stream";
        return false;
    }
    if (config.has_outgoing && tap == nullptr) {
        error = "live media: no capture tap for the outgoing stream";
        return false;
    }
    if (config.has_outgoing && config.has_incoming && config.outgoing.stream_id == config.incoming.stream_id) {
        error = "live media: incoming and outgoing stream ids must differ";
        return false;
    }
    if (!net::init_sockets(error)) {
        return false;
    }
    if (config.bind_mode) {
        if (!net::parse_endpoint(config.peer_address, 1, expected_peer_)) {
            error = "live media: the performer's address is not known yet";
            return false;
        }
    } else if (!net::parse_endpoint(config.peer_address, config.media_port, expected_peer_)) {
        error = "not an IPv4 address: " + config.peer_address;
        return false;
    }
    outgoing_.reset();
    incoming_.reset();
    if (config.has_outgoing) {
        auto out = std::make_unique<OutgoingStream>();
        OutgoingConfig oc = config.outgoing;
        oc.session_id = config.session_id;
        if (!out->create(oc, *tap, error)) {
            return false;
        }
        outgoing_ = std::move(out);
    }
    if (config.has_incoming) {
        auto in = std::make_unique<IncomingStream>();
        if (!in->create(config.incoming, error)) {
            outgoing_.reset();
            return false;
        }
        incoming_ = std::move(in);
    }
    const bool ok = config.bind_mode ? socket_.bind_on(config.local_address, config.media_port, error)
                                     : socket_.connect_to(config.peer_address, config.media_port, error);
    if (!ok) {
        outgoing_.reset();
        incoming_.reset();
        return false;
    }
    cfg_ = config;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        peer_known_ = !config.bind_mode;
        peer_ = config.bind_mode ? net::Endpoint{} : expected_peer_;
        peer_closed_ = false;
        was_heard_ = false;
        last_rx_ns_ = 0;
        peer_timeouts_ = reports_sent_ = report_errors_ = reports_received_ = blackholed_ = 0;
        report_seq_ = 0;
        invalid_ = InvalidCounts{};
        has_remote_report_ = false;
        remote_report_ = ReceiverReport{};
        remote_report_ns_ = 0;
    }
    stop_requested_.store(false);
    running_.store(true);
    thread_ = std::thread([this] { thread_main(); });
    if (log_ != nullptr) {
        std::vector<log::Field> fields{
            {"role", config.bind_mode ? "producer" : "performer"},
            {"local", socket_.local_endpoint().text()},
            {"peer", config.peer_address},
            {"outgoing_stream", config.has_outgoing ? std::to_string(config.outgoing.stream_id) : "none"},
            {"incoming_stream", config.has_incoming ? std::to_string(config.incoming.stream_id) : "none"}};
        if (outgoing_) {
            const auto s = outgoing_->stats();
            fields.push_back({"codec", s.opus_version});
            fields.push_back({"application", s.application});
            fields.push_back({"frame_samples", std::to_string(s.frame_samples)});
            fields.push_back({"bitrate_bps", std::to_string(s.bitrate_bps)});
            fields.push_back({"complexity", std::to_string(s.complexity)});
            fields.push_back({"cbr", config.outgoing.codec.constant_bitrate ? "1" : "0"});
            fields.push_back({"lookahead_samples", std::to_string(s.lookahead_samples)});
            fields.push_back({"test_impairment", config.outgoing.test_impairment.active() ? "ON (test only)" : "off"});
        }
        if (incoming_) {
            fields.push_back({"jitter_target_frames", std::to_string(config.incoming.playout.target_frames)});
            fields.push_back({"gain_db", std::to_string(config.incoming.playout.gain_db)});
        }
        log::Record r;
        r.mono_ns = time::monotonic_ns();
        r.utc_ms = time::utc_now_ms();
        r.level = log::Level::Info;
        r.component = "live";
        r.event = "endpoint_started";
        r.message = "live media endpoint started";
        r.fields = std::move(fields);
        log_->submit(std::move(r));
    }
    return true;
}

void LiveEndpoint::stop() {
    if (thread_.joinable()) {
        stop_requested_.store(true);
        thread_.join();
        if (log_ != nullptr) {
            std::vector<log::Field> fields;
            if (outgoing_) {
                const auto s = outgoing_->stats();
                fields.push_back({"out_stream", std::to_string(s.stream_id)});
                fields.push_back({"packets_sent", std::to_string(s.packets_sent)});
                fields.push_back({"send_errors", std::to_string(s.send_errors)});
                fields.push_back({"muted_frames", std::to_string(s.muted_frames)});
                fields.push_back({"tap_gap_frames", std::to_string(s.tap_gap_frames)});
                fields.push_back({"backlog_trim_frames", std::to_string(s.backlog_trim_frames)});
            }
            if (incoming_) {
                const auto s = incoming_->stats();
                fields.push_back({"in_stream", std::to_string(s.stream_id)});
                fields.push_back({"received", std::to_string(s.arrival.received)});
                fields.push_back({"lost_estimate", std::to_string(s.arrival.lost_estimate)});
                fields.push_back({"late", std::to_string(s.jb.late)});
                fields.push_back({"underruns", std::to_string(s.jb.underruns)});
                fields.push_back({"queue_full_drops", std::to_string(s.queue_full_drops)});
            }
            fields.push_back({"invalid", std::to_string(stats().invalid.total())});
            log::Record r;
            r.mono_ns = time::monotonic_ns();
            r.utc_ms = time::utc_now_ms();
            r.level = log::Level::Info;
            r.component = "live";
            r.event = "endpoint_stopped";
            r.message = "live media endpoint stopped";
            r.fields = std::move(fields);
            log_->submit(std::move(r));
        }
    }
    socket_.close();
    running_.store(false);
}

bool LiveEndpoint::send_datagram(const std::uint8_t* d, std::size_t n) {
    net::Endpoint to;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!peer_known_) {
            return false;
        }
        to = peer_;
    }
    std::string error;
    const long sent = cfg_.bind_mode ? socket_.send_to(to, d, n, error) : socket_.send(d, n, error);
    return sent == static_cast<long>(n);
}

void LiveEndpoint::send_report(bool closing) {
    if (!incoming_) {
        return;
    }
    std::uint32_t invalid = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!peer_known_) {
            return;
        }
        invalid = static_cast<std::uint32_t>(invalid_.total());
    }
    const ReceiverReport r = incoming_->make_report(closing, invalid);
    std::uint8_t payload[ReceiverReport::kBytes];
    write_report(r, payload);
    MediaHeader h;
    h.type = PacketType::ReceiverReport;
    h.session_id = cfg_.session_id;
    h.stream_id = cfg_.incoming.stream_id;
    h.flags = 0;
    std::uint8_t datagram[kHeaderBytes + ReceiverReport::kBytes];
    {
        std::lock_guard<std::mutex> lock(mutex_);
        h.seq = report_seq_++;
    }
    const std::size_t n = write_packet(h, payload, sizeof payload, datagram, sizeof datagram);
    const bool ok = send_datagram(datagram, n);
    std::lock_guard<std::mutex> lock(mutex_);
    ++(ok ? reports_sent_ : report_errors_);
}

void LiveEndpoint::handle(const std::uint8_t* data, long size, const net::Endpoint& from, std::int64_t now) {
    // Step 1: source.
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const bool source_ok = cfg_.bind_mode ? from.ip == expected_peer_.ip : from == expected_peer_;
        if (!source_ok) {
            ++invalid_.src_rejected;
            return;
        }
    }
    MediaHeader h;
    const std::uint8_t* payload = nullptr;
    const PacketCheck check = parse_packet(data, static_cast<std::size_t>(size), cfg_.session_id, h, payload);
    if (check != PacketCheck::Ok) {
        std::lock_guard<std::mutex> lock(mutex_);
        invalid_.count(check);
        return;
    }
    // Direction.
    bool accepted = false;
    bool closing = false;
    if (h.type == PacketType::ReceiverReport) {
        if (outgoing_ && h.stream_id == cfg_.outgoing.stream_id) {
            const ReceiverReport r = read_report(payload);
            closing = (r.flags & ReceiverReport::kFlagClosing) != 0;
            std::lock_guard<std::mutex> lock(mutex_);
            ++reports_received_;
            has_remote_report_ = true;
            remote_report_ = r;
            remote_report_ns_ = now;
            accepted = true;
        }
    } else if (incoming_ && h.stream_id == cfg_.incoming.stream_id) {
        if (h.type == PacketType::Audio) {
            if (!incoming_->on_audio(h, payload, now)) {
                std::lock_guard<std::mutex> lock(mutex_);
                ++invalid_.bad_payload;
                return;
            }
        } else {
            incoming_->on_end_of_stream();
        }
        accepted = true;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (!accepted) {
        ++invalid_.wrong_stream;
        return;
    }
    last_rx_ns_ = now;
    if (cfg_.bind_mode && (!peer_known_ || peer_ != from)) {
        peer_known_ = true;
        peer_ = from;
        if (log_ != nullptr) {
            log_->log(log::Level::Info, "live", "peer_learned", "performer media endpoint learned from its datagrams",
                      {{"peer", from.text()}});
        }
    }
    if (closing) {
        if (!peer_closed_ && log_ != nullptr) {
            log_->log(log::Level::Info, "live", "peer_closed", "remote side stopped its live media", {{"peer", from.text()}});
        }
        peer_closed_ = true;
    } else {
        peer_closed_ = false;
    }
}

bool LiveEndpoint::reachable(std::int64_t now) {
    std::lock_guard<std::mutex> lock(mutex_);
    const bool heard = last_rx_ns_ != 0 && now - last_rx_ns_ <= static_cast<std::int64_t>(cfg_.peer_timeout_ms) * 1000000;
    if (was_heard_ && !heard) {
        ++peer_timeouts_;
        if (log_ != nullptr) {
            log_->log(log::Level::Warn, "live", "peer_timeout", "no live datagram from the remote side",
                      {{"peer", peer_.text()}, {"control_link_up", control_up_.load() ? "1" : "0"}});
        }
    }
    was_heard_ = heard;
    return peer_known_ && !peer_closed_ && (heard || control_up_.load());
}

void LiveEndpoint::thread_main() {
#ifdef _WIN32
    // 1 ms timer resolution while live audio runs, so select() wakes promptly (default ~15.6 ms).
    if (cfg_.has_outgoing) {
        timeBeginPeriod(1);
    }
#endif
    const OutgoingStream::SendFn send = [this](const std::uint8_t* d, std::size_t n) { return send_datagram(d, n); };
    std::uint8_t buffer[net::UdpSocket::kMaxDatagram];
    std::int64_t next_report = time::monotonic_ns();
    while (!stop_requested_.load()) {
        socket_.wait_readable(cfg_.has_outgoing ? 1 : 20);
        for (int i = 0; i < 256; ++i) {
            net::Endpoint from;
            std::string error;
            const long n = socket_.recv_from(buffer, sizeof buffer, from, error);
            if (n == 0) {
                break;
            }
            if (n == -3) {
                std::lock_guard<std::mutex> lock(mutex_);
                ++invalid_.oversized;
                continue;
            }
            if (n < 0) {
                if (log_ != nullptr) {
                    log_->log(log::Level::Warn, "live", "receive_error", error);
                }
                break;
            }
            if (blackhole_.load()) {
                std::lock_guard<std::mutex> lock(mutex_);
                ++blackholed_;
                continue;
            }
            handle(buffer, n, from, time::monotonic_ns());
        }
        const std::int64_t now = time::monotonic_ns();
        const bool can_send = reachable(now);
        if (outgoing_) {
            outgoing_->pump(can_send, send);
        }
        if (incoming_ && now >= next_report) {
            send_report(false);
            next_report = now + static_cast<std::int64_t>(cfg_.report_interval_ms) * 1000000;
        }
    }
    if (outgoing_) {
        outgoing_->finish(reachable(time::monotonic_ns()), send);
    }
    // Tell the other side this direction is closing (twice: UDP may lose one; it also times out).
    send_report(true);
    send_report(true);
#ifdef _WIN32
    if (cfg_.has_outgoing) {
        timeEndPeriod(1);
    }
#endif
}

EndpointStats LiveEndpoint::stats() const {
    const std::int64_t now = time::monotonic_ns();
    std::lock_guard<std::mutex> lock(mutex_);
    EndpointStats s;
    s.running = running_.load();
    s.local_endpoint = socket_.valid() ? socket_.local_endpoint().text() : std::string();
    s.peer_known = peer_known_;
    s.peer_endpoint = peer_known_ ? peer_.text() : std::string();
    s.peer_heard = last_rx_ns_ != 0 && now - last_rx_ns_ <= static_cast<std::int64_t>(cfg_.peer_timeout_ms) * 1000000;
    s.peer_closed = peer_closed_;
    s.control_link_up = control_up_.load();
    s.peer_reachable = peer_known_ && !peer_closed_ && (s.peer_heard || s.control_link_up);
    s.last_rx_age_ms = last_rx_ns_ == 0 ? -1.0 : static_cast<double>(now - last_rx_ns_) / 1e6;
    s.peer_timeouts = peer_timeouts_;
    s.reports_sent = reports_sent_;
    s.report_send_errors = report_errors_;
    s.reports_received = reports_received_;
    s.test_blackholed = blackholed_;
    s.invalid = invalid_;
    s.has_remote_report = has_remote_report_;
    s.remote_report = remote_report_;
    s.remote_report_age_ms = remote_report_ns_ == 0 ? -1.0 : static_cast<double>(now - remote_report_ns_) / 1e6;
    return s;
}

}  // namespace rr::media
