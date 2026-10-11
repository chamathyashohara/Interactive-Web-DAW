// Monitor path tests. TEST SIGNAL - NOT A MICROPHONE: blocks are pushed and rendered by the test
// thread through the same functions the capture and playback callbacks call.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <vector>

#include "rr/audio/monitor_bus.hpp"
#include "rr/shared/realtime_guard.hpp"

using rr::audio::MonitorBus;
using Catch::Approx;

namespace {

constexpr std::uint32_t kRate = 48000;
constexpr std::uint32_t kBlock = 480;  // 10 ms

// Stereo block whose left channel is `l` and right channel `r` for every frame.
std::vector<float> stereo(float l, float r, std::uint32_t frames = kBlock) {
    std::vector<float> v(static_cast<std::size_t>(frames) * 2);
    for (std::uint32_t f = 0; f < frames; ++f) {
        v[2 * f] = l;
        v[2 * f + 1] = r;
    }
    return v;
}

}  // namespace

TEST_CASE("disabled monitoring ignores input and renders silence", "[audio][monitor]") {
    MonitorBus bus(kRate, 200, 20);
    const auto in = stereo(0.5f, 0.5f);
    bus.push_capture(in.data(), kBlock, 2);
    std::vector<float> out(kBlock * 2, 1.0f);
    bus.render(out.data(), kBlock, 2);
    for (float x : out) {
        REQUIRE(x == 0.0f);
    }
    CHECK(bus.stats().pushed_frames == 0);
    CHECK(bus.stats().played_frames == kBlock);
    CHECK_FALSE(rr::rt::is_realtime_thread());
}

TEST_CASE("monitoring fills to the target, then plays exactly what was captured", "[audio][monitor]") {
    MonitorBus bus(kRate, 200, 20);  // target 960 frames
    bus.set_enabled(true);
    const auto a = stereo(0.25f, -0.5f);
    bus.push_capture(a.data(), kBlock, 2);  // 10 ms < target
    std::vector<float> out(kBlock * 2);
    bus.render(out.data(), kBlock, 2);
    CHECK(out[0] == 0.0f);                       // still filling: silence, not an underrun
    CHECK(bus.stats().underrun_events == 0);
    bus.push_capture(a.data(), kBlock, 2);      // now 20 ms buffered
    bus.render(out.data(), kBlock, 2);
    CHECK(bus.stats().prefill_events == 1);
    CHECK(out[0] == 0.25f);
    CHECK(out[1] == -0.5f);
    CHECK(out[2 * kBlock - 1] == -0.5f);
}

TEST_CASE("channel maps: mono in -> L=R, stereo -> mono out averages, >2 ch in uses the first two", "[audio][monitor]") {
    std::vector<float> out(kBlock * 2);
    {
        MonitorBus bus(kRate, 200, 10);
        bus.set_enabled(true);
        std::vector<float> mono(kBlock, 0.3f);
        bus.push_capture(mono.data(), kBlock, 1);
        bus.render(out.data(), kBlock, 2);
        CHECK(out[0] == 0.3f);
        CHECK(out[1] == 0.3f);
    }
    {
        MonitorBus bus(kRate, 200, 10);
        bus.set_enabled(true);
        const auto a = stereo(0.2f, 0.6f);
        bus.push_capture(a.data(), kBlock, 2);
        std::vector<float> mono_out(kBlock);
        bus.render(mono_out.data(), kBlock, 1);
        CHECK(mono_out[0] == Approx(0.4f));
    }
    {
        MonitorBus bus(kRate, 200, 10);
        bus.set_enabled(true);
        std::vector<float> quad(kBlock * 4);
        for (std::uint32_t f = 0; f < kBlock; ++f) {
            quad[4 * f] = 0.1f;
            quad[4 * f + 1] = 0.2f;
            quad[4 * f + 2] = 0.9f;
            quad[4 * f + 3] = 0.9f;
        }
        bus.push_capture(quad.data(), kBlock, 4);
        std::vector<float> out4(kBlock * 4, 1.0f);
        bus.render(out4.data(), kBlock, 4);
        CHECK(out4[0] == 0.1f);
        CHECK(out4[1] == 0.2f);
        CHECK(out4[2] == 0.0f);  // extra output channels stay silent
        CHECK(out4[3] == 0.0f);
    }
}

TEST_CASE("running dry is counted as an underrun and plays silence", "[audio][monitor]") {
    MonitorBus bus(kRate, 200, 10);
    bus.set_enabled(true);
    const auto a = stereo(0.5f, 0.5f);
    bus.push_capture(a.data(), kBlock, 2);
    std::vector<float> out(kBlock * 2);
    bus.render(out.data(), kBlock, 2);  // plays the 480 frames
    bus.push_capture(a.data(), 100, 2);  // only 100 frames arrive while already playing
    std::vector<float> out2(kBlock * 2);
    bus.render(out2.data(), kBlock, 2);  // 100 frames of audio, then 380 frames of silence
    CHECK(bus.stats().underrun_events == 1);
    CHECK(bus.stats().underrun_frames == kBlock - 100);
    CHECK(out2[2 * 99] == 0.5f);
    CHECK(out2[2 * 100] == 0.0f);
    // After an underrun, playback waits for the target again before resuming (no stutter).
    bus.push_capture(a.data(), 100, 2);
    bus.render(out2.data(), kBlock, 2);
    CHECK(out2[0] == 0.0f);
    CHECK(bus.stats().underrun_events == 1);

    MonitorBus bus2(kRate, 200, 10);
    bus2.set_enabled(true);
    bus2.push_capture(a.data(), kBlock, 2);  // exactly the target: starts without a trim
    bus2.render(out.data(), kBlock, 2);
    const auto tail = stereo(0.5f, 0.5f, 120);
    bus2.push_capture(tail.data(), 120, 2);
    bus2.render(out2.data(), kBlock, 2);  // 120 frames of audio, then underrun
    const auto s = bus2.stats();
    CHECK(s.underrun_events == 1);
    CHECK(s.underrun_frames == kBlock - 120);
    CHECK(out2[2 * 119] == 0.5f);
    CHECK(out2[2 * 120] == 0.0f);
}

TEST_CASE("a full monitor buffer drops capture blocks and counts them", "[audio][monitor]") {
    MonitorBus bus(kRate, 50, 10);  // ring rounds up to 4096 stereo frames
    bus.set_enabled(true);
    const auto a = stereo(0.1f, 0.1f);
    for (int i = 0; i < 20; ++i) {
        bus.push_capture(a.data(), kBlock, 2);
    }
    const auto s = bus.stats();
    CHECK(s.overflow_events > 0);
    CHECK(s.overflow_frames == s.overflow_events * kBlock);
    CHECK(s.pushed_frames == 20 * kBlock);
}

TEST_CASE("monitor gain changes only what is heard", "[audio][monitor]") {
    MonitorBus bus(kRate, 200, 10);
    bus.set_enabled(true);
    bus.set_gain_db(-6.0206f);
    const auto a = stereo(0.8f, 0.8f);
    bus.push_capture(a.data(), kBlock, 2);
    std::vector<float> out(kBlock * 2);
    bus.render(out.data(), kBlock, 2);
    CHECK(out[0] == Approx(0.4f).epsilon(1e-4));
    CHECK(a[0] == 0.8f);  // the captured buffer itself is untouched
    bus.set_gain_db(100.0f);
    CHECK(bus.gain_db() == 12.0f);  // clamped
}

TEST_CASE("a backlog present when monitoring (re)starts is dropped down to the target", "[audio][monitor]") {
    MonitorBus bus(kRate, 1000, 20);  // target 960
    bus.set_enabled(true);
    const auto a = stereo(0.1f, 0.1f);
    for (int i = 0; i < 8; ++i) {  // 80 ms piled up while the output was not running
        bus.push_capture(a.data(), kBlock, 2);
    }
    std::vector<float> out(kBlock * 2);
    bus.render(out.data(), kBlock, 2);
    const auto s = bus.stats();
    CHECK(s.prefill_events == 1);
    CHECK(s.start_trim_frames == 8 * kBlock - 960);
    CHECK(s.fill_frames == 960 - kBlock);  // started at the target, then one block played
    CHECK(out[0] == 0.1f);
}

TEST_CASE("persistently excess buffered audio is trimmed back to the target", "[audio][monitor]") {
    MonitorBus bus(kRate, 2000, 10);  // target 480
    bus.set_enabled(true);
    const auto a = stereo(0.1f, 0.1f);
    bus.push_capture(a.data(), kBlock, 2);
    std::vector<float> out(kBlock * 2);
    bus.render(out.data(), kBlock, 2);  // starts at the target
    // Capture clock "faster" than playback: two blocks in for every block out.
    std::uint32_t max_fill = 0;
    for (int i = 0; i < 70; ++i) {
        bus.push_capture(a.data(), kBlock, 2);
        bus.push_capture(a.data(), kBlock, 2);
        bus.render(out.data(), kBlock, 2);
        max_fill = std::max(max_fill, bus.stats().fill_frames);
    }
    const auto s = bus.stats();
    CHECK(s.drift_trim_events >= 1);
    CHECK(s.drift_trim_frames > 0);
    CHECK(s.overflow_events == 0);
    CHECK(max_fill < 60u * kBlock);  // bounded: without trimming it would reach 70 blocks
}

TEST_CASE("test tone plays for the requested time, independent of monitoring", "[audio][monitor]") {
    MonitorBus bus(kRate, 200, 20);
    bus.start_test_tone(1000.0f, -20.0f, 0.005f);  // 240 frames
    CHECK(bus.test_tone_active());
    std::vector<float> out(kBlock * 2);
    bus.render(out.data(), kBlock, 2);
    float peak = 0.0f;
    for (std::uint32_t f = 0; f < 240; ++f) {
        peak = std::max(peak, std::fabs(out[2 * f]));
    }
    CHECK(peak == Approx(0.1f).epsilon(0.02));  // -20 dBFS
    CHECK(out[2 * 300] == 0.0f);
    CHECK_FALSE(bus.test_tone_active());
}
