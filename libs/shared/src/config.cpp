#include "rr/shared/config.hpp"

#include <sstream>

namespace rr {

AppConfig AppConfig::defaults_for(Role role) {
    AppConfig config;
    config.role = role;
    return config;
}

bool is_allowed_live_frame_us(std::uint32_t frame_us) noexcept {
    switch (frame_us) {
    case 2500:
    case 5000:
    case 10000:
    case 20000:
    case 40000:
    case 60000:
        return true;
    default:
        return false;
    }
}

std::vector<std::string> validate(const AppConfig& config) {
    std::vector<std::string> problems;
    const NetworkConfig& net = config.network;
    if (net.control_tcp_port == 0 || net.media_udp_port == 0 || net.transfer_tcp_port == 0) {
        problems.emplace_back("network ports must be non-zero");
    }
    if (net.control_tcp_port == net.transfer_tcp_port) {
        problems.emplace_back("control and transfer TCP ports must differ");
    }

    const AudioConfig& audio = config.audio;
    if (audio.required_sample_rate_hz != 48000) {
        problems.emplace_back("required sample rate must be 48000 Hz (ADR-003, OQ-11)");
    }
    if (!is_allowed_live_frame_us(audio.live_frame_us)) {
        problems.emplace_back("live frame duration must be 2.5, 5, 10, 20, 40 or 60 ms (ADR-006)");
    }
    if (audio.jitter_depth_frames < 1 || audio.jitter_depth_frames > 16) {
        problems.emplace_back("jitter buffer depth must be 1..16 frames (ADR-011)");
    }
    if (audio.record_ring_seconds < 1) {
        problems.emplace_back("record ring must hold at least 1 s");
    }

    const SessionTimingConfig& t = config.timing;
    if (t.start_lead_ms <= t.arm_ack_margin_ms) {
        problems.emplace_back("start lead must be longer than the ARM_ACK margin");
    }
    if (t.link_lost_after_ms <= t.heartbeat_interval_ms) {
        problems.emplace_back("link-lost threshold must be longer than the heartbeat interval");
    }
    // WAV data size is a 32-bit field: float32 x up to 2 channels must stay under 4 GiB.
    const unsigned long long max_bytes = static_cast<unsigned long long>(t.max_take_seconds) *
                                         audio.required_sample_rate_hz * 4ULL * 2ULL;
    if (t.max_take_seconds == 0 || max_bytes >= 0xFFFFFFFFULL - 1024ULL) {
        problems.emplace_back("maximum take length must be > 0 and fit a WAV file (< 4 GiB)");
    }
    return problems;
}

std::string describe(const AppConfig& c) {
    std::ostringstream out;
    out << "role = " << role_id(c.role) << '\n'
        << "network.control_tcp_port = " << c.network.control_tcp_port << '\n'
        << "network.media_udp_port = " << c.network.media_udp_port << '\n'
        << "network.transfer_tcp_port = " << c.network.transfer_tcp_port << '\n'
        << "audio.required_sample_rate_hz = " << c.audio.required_sample_rate_hz << '\n'
        << "audio.live_frame_us = " << c.audio.live_frame_us << '\n'
        << "audio.jitter_depth_frames = " << c.audio.jitter_depth_frames << '\n'
        << "audio.device_period_ms = " << c.audio.device_period_ms << '\n'
        << "audio.record_ring_seconds = " << c.audio.record_ring_seconds << '\n'
        << "timing.start_lead_ms = " << c.timing.start_lead_ms << '\n'
        << "timing.arm_ack_margin_ms = " << c.timing.arm_ack_margin_ms << '\n'
        << "timing.stop_lead_ms = " << c.timing.stop_lead_ms << '\n'
        << "timing.heartbeat_interval_ms = " << c.timing.heartbeat_interval_ms << '\n'
        << "timing.link_lost_after_ms = " << c.timing.link_lost_after_ms << '\n'
        << "timing.finalise_report_wait_ms = " << c.timing.finalise_report_wait_ms << '\n'
        << "timing.max_take_seconds = " << c.timing.max_take_seconds << '\n';
    return out.str();
}

}  // namespace rr
