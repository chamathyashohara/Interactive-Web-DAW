#include "rr/media/live_sender.hpp"

namespace rr::media {

LiveSender::LiveSender(log::Logger* logger) : endpoint_(logger) {}

LiveSender::~LiveSender() {
    stop();
}

bool LiveSender::start(const LiveSenderConfig& config, audio::LiveTap& tap, std::string& error) {
    LiveEndpointConfig c;
    c.bind_mode = true;
    c.local_address = config.bind_address;
    c.peer_address = config.expected_peer_address;
    c.media_port = config.media_port;
    c.session_id = config.session_id;
    c.has_outgoing = true;
    c.outgoing.stream_id = kStreamProducerMic;
    c.outgoing.codec = config.codec;
    c.outgoing.max_backlog_frames = config.max_backlog_frames;
    c.outgoing.test_impairment = config.test_impairment;
    c.has_incoming = false;
    c.peer_timeout_ms = config.peer_timeout_ms;
    if (!endpoint_.start(c, &tap, error)) {
        return false;
    }
    endpoint_.outgoing()->set_enabled(sending_.load());
    return true;
}

void LiveSender::stop() {
    endpoint_.stop();
}

void LiveSender::set_sending(bool on) noexcept {
    sending_.store(on);
    if (OutgoingStream* out = endpoint_.outgoing()) {
        out->set_enabled(on);
    }
}

LiveSenderStats LiveSender::stats() const {
    LiveSenderStats s;
    const EndpointStats e = endpoint_.stats();
    s.running = endpoint_.running();
    s.sending_enabled = sending_.load();
    s.local_endpoint = e.local_endpoint;
    // Stage 7 meaning: "the performer can be sent to now".
    s.peer_known = e.peer_reachable;
    s.peer_endpoint = e.peer_reachable ? e.peer_endpoint : std::string();
    s.reports_received = e.reports_received;
    s.peer_timeouts = e.peer_timeouts;
    s.invalid = e.invalid;
    s.has_report = e.has_remote_report;
    s.last_report = e.remote_report;
    s.last_report_age_ms = e.remote_report_age_ms;
    if (const OutgoingStream* out = endpoint_.outgoing()) {
        const OutgoingStats o = out->stats();
        s.streaming = o.streaming;
        s.streams_started = o.streams_started;
        s.frames_encoded = o.frames_encoded;
        s.packets_sent = o.packets_sent;
        s.bytes_sent = o.bytes_sent;
        s.send_errors = o.send_errors;
        s.encode_errors = o.encode_errors;
        s.end_of_stream_sent = o.end_of_stream_sent;
        s.tap_gap_frames = o.tap_gap_frames;
        s.backlog_trim_frames = o.backlog_trim_frames;
        s.test_dropped = o.test_dropped;
        s.test_duplicated = o.test_duplicated;
        s.test_reordered = o.test_reordered;
        s.max_encode_ns = o.max_encode_ns;
        s.opus_version = o.opus_version;
        s.application = o.application;
        s.frame_samples = o.frame_samples;
        s.bitrate_bps = o.bitrate_bps;
        s.complexity = o.complexity;
        s.lookahead_samples = o.lookahead_samples;
        s.tap = o.tap;
    }
    return s;
}

}  // namespace rr::media
