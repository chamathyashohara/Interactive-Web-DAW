#include "rr/shared/Config.h"

#include <sstream>

AppConfig AppConfig::defaultsFor(Role role)
{
    AppConfig config;
    config.role = role;
    return config;
}

bool isAllowedLiveFrameUs(uint32_t frameUs) noexcept
{
    switch (frameUs)
    {
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

std::vector<std::string> validate(const AppConfig& config)
{
    std::vector<std::string> problems;
    const NetworkConfig& net = config.network;
    if (net.controlTcpPort == 0 || net.mediaUdpPort == 0 || net.transferTcpPort == 0)
    {
        problems.emplace_back("network ports must be non-zero");
    }
    if (net.controlTcpPort == net.transferTcpPort)
    {
        problems.emplace_back("control and transfer TCP ports must differ");
    }

    const AudioConfig& audio = config.audio;
    if (audio.requiredSampleRateHz != 48000)
    {
        problems.emplace_back("required sample rate must be 48000 Hz (ADR-003, OQ-11)");
    }
    if (!isAllowedLiveFrameUs(audio.liveFrameUs))
    {
        problems.emplace_back("live frame duration must be 2.5, 5, 10, 20, 40 or 60 ms (ADR-006)");
    }
    if (audio.jitterDepthFrames < 1 || audio.jitterDepthFrames > 16)
    {
        problems.emplace_back("jitter buffer depth must be 1..16 frames (ADR-011)");
    }
    if (audio.recordRingSeconds < 1)
    {
        problems.emplace_back("record ring must hold at least 1 s");
    }

    const SessionTimingConfig& t = config.timing;
    if (t.startLeadMs <= t.armAckMarginMs)
    {
        problems.emplace_back("start lead must be longer than the ARM_ACK margin");
    }
    if (t.linkLostAfterMs <= t.heartbeatIntervalMs)
    {
        problems.emplace_back("link-lost threshold must be longer than the heartbeat interval");
    }
    // WAV data size is a 32-bit field: float32 x up to 2 channels must stay under 4 GiB.
    const unsigned long long maxBytes = static_cast<unsigned long long>(t.maxTakeSeconds) *
                                         audio.requiredSampleRateHz * 4ULL * 2ULL;
    if (t.maxTakeSeconds == 0 || maxBytes >= 0xFFFFFFFFULL - 1024ULL)
    {
        problems.emplace_back("maximum take length must be > 0 and fit a WAV file (< 4 GiB)");
    }
    return problems;
}

std::string describe(const AppConfig& c)
{
    std::ostringstream out;
    out << "role = " << roleId(c.role) << '\n'
        << "network.control_tcp_port = " << c.network.controlTcpPort << '\n'
        << "network.media_udp_port = " << c.network.mediaUdpPort << '\n'
        << "network.transfer_tcp_port = " << c.network.transferTcpPort << '\n'
        << "audio.required_sample_rate_hz = " << c.audio.requiredSampleRateHz << '\n'
        << "audio.live_frame_us = " << c.audio.liveFrameUs << '\n'
        << "audio.jitter_depth_frames = " << c.audio.jitterDepthFrames << '\n'
        << "audio.device_period_ms = " << c.audio.devicePeriodMs << '\n'
        << "audio.record_ring_seconds = " << c.audio.recordRingSeconds << '\n'
        << "timing.start_lead_ms = " << c.timing.startLeadMs << '\n'
        << "timing.auto_start_lead = " << (c.timing.autoStartLead ? "yes" : "no") << '\n'
        << "timing.arm_ack_margin_ms = " << c.timing.armAckMarginMs << '\n'
        << "timing.stop_lead_ms = " << c.timing.stopLeadMs << '\n'
        << "timing.heartbeat_interval_ms = " << c.timing.heartbeatIntervalMs << '\n'
        << "timing.link_lost_after_ms = " << c.timing.linkLostAfterMs << '\n'
        << "timing.finalise_report_wait_ms = " << c.timing.finaliseReportWaitMs << '\n'
        << "timing.max_take_seconds = " << c.timing.maxTakeSeconds << '\n';
    return out.str();
}

