#include <catch2/catch_test_macros.hpp>

#include "rr/shared/Config.h"

TEST_CASE("default configuration is valid for both roles", "[shared][config]")
{
    for (Role role : {Role::Producer, Role::Performer})
    {
        const AppConfig config = AppConfig::defaultsFor(role);
        CHECK(config.role == role);
        CHECK(validate(config).empty());
    }
}

TEST_CASE("defaults match the provisional values in PROTOCOL_OVERVIEW section 8", "[shared][config]")
{
    const AppConfig c = AppConfig::defaultsFor(Role::Producer);
    CHECK(c.network.controlTcpPort == 52000);
    CHECK(c.network.mediaUdpPort == 52001);
    CHECK(c.network.transferTcpPort == 52002);
    CHECK(c.audio.requiredSampleRateHz == 48000);
    CHECK(c.audio.liveFrameUs == 10000);
    CHECK(c.audio.jitterDepthFrames == 3);
    CHECK(c.timing.startLeadMs == 1000);
    CHECK(c.timing.autoStartLead);              // Stage 12: sized for the measured link
    CHECK(c.timing.linkLostAfterMs == 6000);   // Stage 12: was 3000, too short for Wi-Fi
    CHECK(c.timing.maxTakeSeconds == 1800);
}

TEST_CASE("only legal Opus/PCM frame durations are accepted", "[shared][config]")
{
    for (uint32_t ok : {2500u, 5000u, 10000u, 20000u, 40000u, 60000u})
    {
        CHECK(isAllowedLiveFrameUs(ok));
    }
    for (uint32_t bad : {0u, 1000u, 15000u, 80000u, 120000u})
    {
        CHECK_FALSE(isAllowedLiveFrameUs(bad));
    }
}

TEST_CASE("invalid settings are reported", "[shared][config]")
{
    AppConfig c = AppConfig::defaultsFor(Role::Performer);
    c.audio.jitterDepthFrames = 0;
    c.timing.startLeadMs = 50;  // shorter than the 100 ms ARM_ACK margin
    c.network.transferTcpPort = c.network.controlTcpPort;
    c.audio.liveFrameUs = 80000;
    CHECK(validate(c).size() == 4);
}

TEST_CASE("describe lists every setting", "[shared][config]")
{
    const std::string text = describe(AppConfig::defaultsFor(Role::Producer));
    CHECK(text.find("role = producer") != std::string::npos);
    CHECK(text.find("network.media_udp_port = 52001") != std::string::npos);
    CHECK(text.find("timing.max_take_seconds = 1800") != std::string::npos);
}
