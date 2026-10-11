#include "rr/media/live_receiver.hpp"

namespace rr::media {

LiveReceiver::LiveReceiver(log::Logger* logger) : endpoint_(logger) {}

LiveReceiver::~LiveReceiver() {
    stop();
}

bool LiveReceiver::start(const LiveReceiverConfig& config, std::string& error) {
    LiveEndpointConfig c;
    c.bind_mode = false;
    c.peer_address = config.producer_host;
    c.media_port = config.media_port;
    c.session_id = config.session_id;
    c.has_outgoing = false;
    c.has_incoming = true;
    c.incoming.stream_id = kStreamProducerMic;
    c.incoming.playout = config.playout;
    c.incoming.test_receive_impairment = config.test_receive_impairment;
    c.report_interval_ms = config.report_interval_ms;
    return endpoint_.start(c, nullptr, error);
}

void LiveReceiver::stop() {
    endpoint_.stop();
}

void LiveReceiver::set_output_enabled(bool on) noexcept {
    if (IncomingStream* in = endpoint_.incoming()) {
        in->set_output_enabled(on);
    }
}

bool LiveReceiver::output_enabled() const noexcept {
    const IncomingStream* in = endpoint_.incoming();
    return in != nullptr && in->output_enabled();
}

void LiveReceiver::set_gain_db(float db) noexcept {
    if (IncomingStream* in = endpoint_.incoming()) {
        in->set_gain_db(db);
    }
}

void LiveReceiver::set_target_frames(std::uint32_t frames) noexcept {
    if (IncomingStream* in = endpoint_.incoming()) {
        in->set_target_frames(frames);
    }
}

void LiveReceiver::render_add(float* out, std::uint32_t frames, std::uint32_t channels, std::uint32_t sample_rate) noexcept {
    if (IncomingStream* in = endpoint_.incoming()) {
        in->render_add(out, frames, channels, sample_rate);
    }
}

LiveReceiverStats LiveReceiver::stats() const {
    LiveReceiverStats s;
    const EndpointStats e = endpoint_.stats();
    s.running = endpoint_.running();
    s.producer_endpoint = endpoint_.config().peer_address + ":" + std::to_string(endpoint_.config().media_port);
    s.local_endpoint = e.local_endpoint;
    s.invalid = e.invalid;
    s.reports_sent = e.reports_sent;
    s.report_send_errors = e.report_send_errors;
    if (const IncomingStream* in = endpoint_.incoming()) {
        const IncomingStats i = in->stats();
        s.arrival = i.arrival;
        s.queue_full_drops = i.queue_full_drops;
        s.end_of_stream = i.end_of_stream;
        s.test_dropped = i.test_dropped;
        s.last_packet_age_ms = i.last_packet_age_ms;
        s.output_enabled = i.output_enabled;
        s.jb_playing = i.jb_playing;
        s.jb_held = i.jb_held;
        s.jb_max_held = i.jb_max_held;
        s.jb_target = i.jb_target;
        s.jb = i.jb;
        s.concealed = i.concealed;
        s.decode_errors = i.decode_errors;
        s.render_callbacks = i.render_callbacks;
        s.wrong_rate_callbacks = i.wrong_rate_callbacks;
        s.frames_output = i.frames_output;
        s.max_render_ns = i.max_render_ns;
        s.last_render_age_ms = i.last_render_age_ms;
        s.last_frame_samples = i.last_frame_samples;
        s.gain_db = i.gain_db;
        s.output_peak_dbfs = i.output_peak_dbfs;
    }
    return s;
}

}  // namespace rr::media
