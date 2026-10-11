#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "rr/shared/role.hpp"

namespace rr {

// Defaults are the provisional values from PROTOCOL_OVERVIEW.md §8 and
// ASSUMPTIONS_AND_OPEN_QUESTIONS.md §3. They are starting settings, not tuned values.
// Nothing reads them from a file yet; the diagnostics screen shows them.

struct NetworkConfig {
    std::uint16_t control_tcp_port = 52000;
    std::uint16_t media_udp_port = 52001;
    std::uint16_t transfer_tcp_port = 52002;
};

struct AudioConfig {
    std::uint32_t required_sample_rate_hz = 48000;
    std::uint32_t live_frame_us = 10000;  // 10 ms; must be a legal frame duration
    std::uint32_t jitter_depth_frames = 3;
    std::uint32_t device_period_ms = 10;
    std::uint32_t record_ring_seconds = 10;
};

struct SessionTimingConfig {
    std::uint32_t start_lead_ms = 1000;
    std::uint32_t arm_ack_margin_ms = 100;
    std::uint32_t stop_lead_ms = 300;
    std::uint32_t heartbeat_interval_ms = 1000;
    std::uint32_t link_lost_after_ms = 3000;
    std::uint32_t finalise_report_wait_ms = 10000;
    std::uint32_t max_take_seconds = 1800;
};

struct AppConfig {
    Role role = Role::Producer;
    NetworkConfig network;
    AudioConfig audio;
    SessionTimingConfig timing;

    static AppConfig defaults_for(Role role);
};

// Live frame durations allowed by ADR-006 (microseconds).
bool is_allowed_live_frame_us(std::uint32_t frame_us) noexcept;

// Returns human-readable problems; empty means valid.
std::vector<std::string> validate(const AppConfig& config);

// Multi-line "key = value" text for the diagnostics screen and the startup log.
std::string describe(const AppConfig& config);

}  // namespace rr
