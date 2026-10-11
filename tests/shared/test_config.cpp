#include <catch2/catch_test_macros.hpp>

#include "rr/shared/config.hpp"

using rr::AppConfig;
using rr::Role;

TEST_CASE("default configuration is valid for both roles", "[shared][config]") {
    for (Role role : {Role::Producer, Role::Performer}) {
        const AppConfig config = AppConfig::defaults_for(role);
        CHECK(config.role == role);
        CHECK(rr::validate(config).empty());
    }
}

TEST_CASE("defaults match the provisional values in PROTOCOL_OVERVIEW section 8", "[shared][config]") {
    const AppConfig c = AppConfig::defaults_for(Role::Producer);
    CHECK(c.network.control_tcp_port == 52000);
    CHECK(c.network.media_udp_port == 52001);
    CHECK(c.network.transfer_tcp_port == 52002);
    CHECK(c.audio.required_sample_rate_hz == 48000);
    CHECK(c.audio.live_frame_us == 10000);
    CHECK(c.audio.jitter_depth_frames == 3);
    CHECK(c.timing.start_lead_ms == 1000);
    CHECK(c.timing.link_lost_after_ms == 3000);
    CHECK(c.timing.max_take_seconds == 1800);
}

TEST_CASE("only legal Opus/PCM frame durations are accepted", "[shared][config]") {
    for (std::uint32_t ok : {2500u, 5000u, 10000u, 20000u, 40000u, 60000u}) {
        CHECK(rr::is_allowed_live_frame_us(ok));
    }
    for (std::uint32_t bad : {0u, 1000u, 15000u, 80000u, 120000u}) {
        CHECK_FALSE(rr::is_allowed_live_frame_us(bad));
    }
}

TEST_CASE("invalid settings are reported", "[shared][config]") {
    AppConfig c = AppConfig::defaults_for(Role::Performer);
    c.audio.jitter_depth_frames = 0;
    c.timing.start_lead_ms = 50;  // shorter than the 100 ms ARM_ACK margin
    c.network.transfer_tcp_port = c.network.control_tcp_port;
    c.audio.live_frame_us = 80000;
    CHECK(rr::validate(c).size() == 4);
}

TEST_CASE("describe lists every setting", "[shared][config]") {
    const std::string text = rr::describe(AppConfig::defaults_for(Role::Producer));
    CHECK(text.find("role = producer") != std::string::npos);
    CHECK(text.find("network.media_udp_port = 52001") != std::string::npos);
    CHECK(text.find("timing.max_take_seconds = 1800") != std::string::npos);
}
