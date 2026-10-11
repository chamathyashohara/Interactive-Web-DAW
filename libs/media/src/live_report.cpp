#include "rr/media/live_report.hpp"

#include <cstdio>
#include <sstream>

namespace rr::media {
namespace {

std::string fmt(const char* format, double v) {
    char b[64];
    std::snprintf(b, sizeof b, format, v);
    return b;
}

std::string stream_name(std::uint16_t id) {
    return id == kStreamProducerMic ? "stream 1, producer mic" : "stream 2, performer mic";
}

}  // namespace

std::string outgoing_status_text(const OutgoingStats& o, const EndpointStats& e) {
    if (!o.enabled) {
        return "off (not sending)";
    }
    if (o.tap.source_rate != 0 && o.tap.source_rate != audio::LiveTap::kRequiredRate) {
        return "cannot send: input runs at " + std::to_string(o.tap.source_rate) + " Hz, live audio needs 48000 Hz";
    }
    if (o.tap.source_rate == 0) {
        return "no input device open";
    }
    if (!e.peer_known) {
        return "waiting for the remote side";
    }
    if (e.peer_closed) {
        return "paused: the remote side stopped its live audio";
    }
    if (!o.streaming) {
        return "paused: no datagram from the remote side for 3 s and no control link";
    }
    std::string s = o.muted ? "MUTED (the remote hears silence; your recording continues)" : "SENDING";
    s += " to " + e.peer_endpoint;
    if (e.has_remote_report) {
        s += (e.remote_report.flags & ReceiverReport::kFlagPlaying) != 0 ? "; remote is listening"
                                                                          : "; remote has hearing switched off";
    }
    return s;
}

std::string incoming_status_text(const IncomingStats& i, const EndpointStats& e) {
    std::string s;
    if (i.last_packet_age_ms < 0.0) {
        s = "nothing received yet";
    } else if (!i.remote_streaming) {
        s = i.end_of_stream > 0 && i.last_packet_age_ms < 3000.0
                ? "remote stopped sending"
                : "NO PACKETS for " + fmt("%.1f", i.last_packet_age_ms / 1000.0) + " s (remote not sending, or the network/firewall blocks this direction)";
    } else if (i.remote_muted) {
        s = "remote MUTED (receiving flagged silence)";
    } else {
        s = "receiving";
    }
    if (!i.output_enabled) {
        s += "; hearing OFF on this PC";
    } else if (i.last_render_age_ms < 0.0 || i.last_render_age_ms > 1000.0) {
        s += "; no output device is playing";
    } else if (i.wrong_rate_callbacks > 0 && i.render_callbacks == i.wrong_rate_callbacks) {
        s += "; output not at 48000 Hz";
    } else if (i.jb_playing) {
        s += "; playing (peak " + fmt("%.1f", static_cast<double>(i.output_peak_dbfs)) + " dBFS)";
    } else {
        s += "; buffering";
    }
    (void)e;
    return s;
}

std::string live_report_text(const LiveReportConditions& c, const LiveEndpoint& endpoint) {
    const EndpointStats e = endpoint.stats();
    const LiveEndpointConfig& cfg = endpoint.config();
    std::ostringstream o;
    o << "LIVE AUDIO DIAGNOSTICS (one page, rr.live_report.v1)\n";
    o << "Generated " << c.generated_utc << " | " << c.role << " | " << c.app_version << " | session " << c.session_id << "\n";
    o << "Security: LAN-only, unencrypted, unauthenticated (ADR-012). Echo cancellation: NOT implemented\n";
    o << "(LATER-03); headphones are required on both PCs. Headphones: " << c.headphones << "\n";
    o << "\nCONDITIONS\n";
    o << "  Test set-up:   " << c.test_conditions << "\n";
    o << "  Input:         " << c.capture_device << " @ " << c.capture_rate << " Hz\n";
    o << "  Output:        " << c.output_device << " @ " << c.output_rate << " Hz\n";
    o << "  Media socket:  " << e.local_endpoint << " <-> " << (e.peer_known ? e.peer_endpoint : std::string("(not learned)"))
      << " (" << (cfg.bind_mode ? "bound, peer learned" : "connected") << ")\n";
    if (const OutgoingStream* out = endpoint.outgoing()) {
        const OutgoingStats s = out->stats();
        o << "  Send codec:    " << s.opus_version << ", " << s.application << ", " << fmt("%.1f", frame_ms(s.frame_samples))
          << " ms frames, " << s.bitrate_bps << " bit/s CBR, complexity " << s.complexity << ", lookahead "
          << s.lookahead_samples << " samples" << (cfg.outgoing.test_impairment.active() ? ", TEST IMPAIRMENT ON" : "") << "\n";
    }
    if (const IncomingStream* in = endpoint.incoming()) {
        const IncomingStats s = in->stats();
        o << "  Playout:       jitter target " << s.jb_target << " frames, gain " << fmt("%.1f", static_cast<double>(s.gain_db))
          << " dB, stall limit " << cfg.incoming.playout.stall_limit << "\n";
    }
    o << "\nSTATUS (each line is independent)\n";
    o << "  Local capture:       " << c.local_capture_status << "\n";
    o << "  Local recording:     " << c.local_recording_status << "\n";
    if (const OutgoingStream* out = endpoint.outgoing()) {
        o << "  Outgoing stream:     " << outgoing_status_text(out->stats(), e) << "\n";
    }
    if (const IncomingStream* in = endpoint.incoming()) {
        o << "  Incoming stream:     " << incoming_status_text(in->stats(), e) << "\n";
    }
    o << "  Remote participant:  " << c.remote_participant_status << "\n";

    if (const OutgoingStream* out = endpoint.outgoing()) {
        const OutgoingStats s = out->stats();
        o << "\nOUTGOING  this PC -> remote (" << stream_name(s.stream_id) << ")\n";
        o << "  measured here:  packets " << s.packets_sent << " (" << s.bytes_sent << " B), muted frames " << s.muted_frames
          << ", send errors " << s.send_errors << ", encode errors " << s.encode_errors << ", capture-tap overflow "
          << s.tap.overflow_events << " events/" << s.tap_gap_frames << " frames, backlog trimmed " << s.backlog_trim_frames
          << " frames, max encode " << fmt("%.3f", static_cast<double>(s.max_encode_ns) / 1e6) << " ms";
        if (cfg.outgoing.test_impairment.active()) {
            o << ", TEST dropped/dup/reordered " << s.test_dropped << "/" << s.test_duplicated << "/" << s.test_reordered;
        }
        o << "\n";
        if (e.has_remote_report) {
            const ReceiverReport& r = e.remote_report;
            o << "  remote reports (" << fmt("%.0f", e.remote_report_age_ms) << " ms ago): received " << r.received
              << ", lost (est.) " << r.lost_estimate << ", late " << r.late << ", duplicates " << r.duplicates << ", reordered "
              << r.reordered << ", jitter " << fmt("%.3f", r.jitter_us / 1000.0) << " ms, buffer " << r.jb_fill << "/"
              << r.jb_target << ", underruns " << r.underruns << ", concealed " << r.concealed << ", decode errors "
              << r.decode_errors << ", invalid " << r.invalid_packets << ", listening "
              << ((r.flags & ReceiverReport::kFlagPlaying) != 0 ? "yes" : "no") << "\n";
        } else {
            o << "  remote reports: none received\n";
        }
    }
    if (const IncomingStream* in = endpoint.incoming()) {
        const IncomingStats s = in->stats();
        o << "\nINCOMING  remote -> this PC (" << stream_name(s.stream_id) << ")\n";
        o << "  arrival:   received " << s.arrival.received << " of " << s.arrival.expected << " expected, lost (est.) "
          << s.arrival.lost_estimate << ", duplicates " << s.arrival.duplicates << ", reordered " << s.arrival.reordered
          << ", stream restarts " << s.arrival.stream_restarts << ", end-of-stream " << s.end_of_stream << "\n";
        o << "  timing:    inter-arrival jitter " << fmt("%.3f", s.arrival.jitter_ms) << " ms, largest gap "
          << fmt("%.1f", s.arrival.max_gap_ms) << " ms, last packet "
          << (s.last_packet_age_ms < 0 ? std::string("never") : fmt("%.0f", s.last_packet_age_ms) + " ms ago") << "\n";
        o << "  playout:   played " << s.jb.played << ", late " << s.jb.late << ", lost (concealed) " << s.jb.lost
          << ", underruns " << s.jb.underruns << ", concealed total " << s.concealed << ", refills " << s.jb.rebuffers
          << ", drift skips " << s.jb.drift_skips << ", catch-up frames " << s.jb.catchup_frames << ", resyncs "
          << s.jb.resyncs << "\n";
        o << "  buffers:   jitter " << s.jb_held << "/" << s.jb_target << " (max " << s.jb_max_held << "), packet queue full "
          << s.queue_full_drops << ", decode errors " << s.decode_errors << ", max decode+mix "
          << fmt("%.3f", static_cast<double>(s.max_render_ns) / 1e6) << " ms, wrong-rate callbacks " << s.wrong_rate_callbacks
          << "\n";
    }
    o << "\nENDPOINT  invalid datagrams " << e.invalid.total() << " (source " << e.invalid.src_rejected << ", oversized "
      << e.invalid.oversized << ", length " << e.invalid.bad_length << ", version " << e.invalid.bad_version << ", type "
      << e.invalid.bad_type << ", CRC " << e.invalid.bad_crc << ", session " << e.invalid.bad_session << ", payload "
      << e.invalid.bad_payload << ", wrong stream " << e.invalid.wrong_stream << "); peer timeouts " << e.peer_timeouts
      << "; reports sent " << e.reports_sent << "/received " << e.reports_received << "; control link "
      << (e.control_link_up ? "up" : "down") << "\n";
    if (e.test_blackholed > 0) {
        o << "  TEST receive blackhole dropped " << e.test_blackholed << " datagrams\n";
    }
    o << "\nTERMS: jitter = packet arrival variation, not latency. Loss is estimated from sequence numbers\n";
    o << "(loss after the last packet is invisible). Concealment affects listening only, never a recording.\n";
    o << "Acoustic (mouth-to-ear) latency is NOT measured by these counters.\n";
    return o.str();
}

}  // namespace rr::media
