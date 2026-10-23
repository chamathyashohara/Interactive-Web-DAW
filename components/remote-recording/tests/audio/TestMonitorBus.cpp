// Monitor path tests. TEST SIGNAL - NOT A MICROPHONE: blocks are pushed and rendered by the test
// thread through the same functions the capture and playback callbacks call.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <vector>

#include "rr/audio/MonitorBus.h"
#include "rr/shared/RealtimeGuard.h"

using Catch::Approx;

namespace
{

constexpr uint32_t kRate = 48000;
constexpr uint32_t kBlock = 480;  // 10 ms

// Stereo block whose left channel is `l` and right channel `r` for every frame.
std::vector<float> stereo(float l, float r, uint32_t frames = kBlock)
{
    std::vector<float> v(static_cast<size_t>(frames) * 2);
    for (uint32_t f = 0; f < frames; ++f)
    {
        v[2 * f] = l;
        v[2 * f + 1] = r;
    }
    return v;
}

}  // namespace

TEST_CASE("disabled monitoring ignores input and renders silence", "[audio][monitor]")
{
    MonitorBus bus(kRate, 200, 20);
    const auto in = stereo(0.5f, 0.5f);
    bus.pushCapture(in.data(), kBlock, 2);
    std::vector<float> out(kBlock * 2, 1.0f);
    bus.render(out.data(), kBlock, 2);
    for (float x : out)
    {
        REQUIRE(x == 0.0f);
    }
    CHECK(bus.stats().pushedFrames == 0);
    CHECK(bus.stats().playedFrames == kBlock);
    CHECK_FALSE(isRealtimeThread());
}

TEST_CASE("monitoring fills to the target, then plays exactly what was captured", "[audio][monitor]")
{
    MonitorBus bus(kRate, 200, 20);  // target 960 frames
    bus.setEnabled(true);
    const auto a = stereo(0.25f, -0.5f);
    bus.pushCapture(a.data(), kBlock, 2);  // 10 ms < target
    std::vector<float> out(kBlock * 2);
    bus.render(out.data(), kBlock, 2);
    CHECK(out[0] == 0.0f);                       // still filling: silence, not an underrun
    CHECK(bus.stats().underrunEvents == 0);
    bus.pushCapture(a.data(), kBlock, 2);      // now 20 ms buffered
    bus.render(out.data(), kBlock, 2);
    CHECK(bus.stats().prefillEvents == 1);
    CHECK(out[0] == 0.25f);
    CHECK(out[1] == -0.5f);
    CHECK(out[2 * kBlock - 1] == -0.5f);
}

TEST_CASE("channel maps: mono in -> L=R, stereo -> mono out averages, >2 ch in uses the first two", "[audio][monitor]")
{
    std::vector<float> out(kBlock * 2);
    {
        MonitorBus bus(kRate, 200, 10);
        bus.setEnabled(true);
        std::vector<float> mono(kBlock, 0.3f);
        bus.pushCapture(mono.data(), kBlock, 1);
        bus.render(out.data(), kBlock, 2);
        CHECK(out[0] == 0.3f);
        CHECK(out[1] == 0.3f);
    }
    {
        MonitorBus bus(kRate, 200, 10);
        bus.setEnabled(true);
        const auto a = stereo(0.2f, 0.6f);
        bus.pushCapture(a.data(), kBlock, 2);
        std::vector<float> monoOut(kBlock);
        bus.render(monoOut.data(), kBlock, 1);
        CHECK(monoOut[0] == Approx(0.4f));
    }
    {
        MonitorBus bus(kRate, 200, 10);
        bus.setEnabled(true);
        std::vector<float> quad(kBlock * 4);
        for (uint32_t f = 0; f < kBlock; ++f)
        {
            quad[4 * f] = 0.1f;
            quad[4 * f + 1] = 0.2f;
            quad[4 * f + 2] = 0.9f;
            quad[4 * f + 3] = 0.9f;
        }
        bus.pushCapture(quad.data(), kBlock, 4);
        std::vector<float> out4(kBlock * 4, 1.0f);
        bus.render(out4.data(), kBlock, 4);
        CHECK(out4[0] == 0.1f);
        CHECK(out4[1] == 0.2f);
        CHECK(out4[2] == 0.0f);  // extra output channels stay silent
        CHECK(out4[3] == 0.0f);
    }
}

TEST_CASE("running dry is counted as an underrun and plays silence", "[audio][monitor]")
{
    MonitorBus bus(kRate, 200, 10);
    bus.setEnabled(true);
    const auto a = stereo(0.5f, 0.5f);
    bus.pushCapture(a.data(), kBlock, 2);
    std::vector<float> out(kBlock * 2);
    bus.render(out.data(), kBlock, 2);  // plays the 480 frames
    bus.pushCapture(a.data(), 100, 2);  // only 100 frames arrive while already playing
    std::vector<float> out2(kBlock * 2);
    bus.render(out2.data(), kBlock, 2);  // 100 frames of audio, then 380 frames of silence
    CHECK(bus.stats().underrunEvents == 1);
    CHECK(bus.stats().underrunFrames == kBlock - 100);
    CHECK(out2[2 * 99] == 0.5f);
    CHECK(out2[2 * 100] == 0.0f);
    // After an underrun, playback waits for the target again before resuming (no stutter).
    bus.pushCapture(a.data(), 100, 2);
    bus.render(out2.data(), kBlock, 2);
    CHECK(out2[0] == 0.0f);
    CHECK(bus.stats().underrunEvents == 1);

    MonitorBus bus2(kRate, 200, 10);
    bus2.setEnabled(true);
    bus2.pushCapture(a.data(), kBlock, 2);  // exactly the target: starts without a trim
    bus2.render(out.data(), kBlock, 2);
    const auto tail = stereo(0.5f, 0.5f, 120);
    bus2.pushCapture(tail.data(), 120, 2);
    bus2.render(out2.data(), kBlock, 2);  // 120 frames of audio, then underrun
    const auto s = bus2.stats();
    CHECK(s.underrunEvents == 1);
    CHECK(s.underrunFrames == kBlock - 120);
    CHECK(out2[2 * 119] == 0.5f);
    CHECK(out2[2 * 120] == 0.0f);
}

TEST_CASE("a full monitor buffer drops capture blocks and counts them", "[audio][monitor]")
{
    MonitorBus bus(kRate, 50, 10);  // ring rounds up to 4096 stereo frames
    bus.setEnabled(true);
    const auto a = stereo(0.1f, 0.1f);
    for (int i = 0; i < 20; ++i)
    {
        bus.pushCapture(a.data(), kBlock, 2);
    }
    const auto s = bus.stats();
    CHECK(s.overflowEvents > 0);
    CHECK(s.overflowFrames == s.overflowEvents * kBlock);
    CHECK(s.pushedFrames == 20 * kBlock);
}

TEST_CASE("monitor gain changes only what is heard", "[audio][monitor]")
{
    MonitorBus bus(kRate, 200, 10);
    bus.setEnabled(true);
    bus.setGainDb(-6.0206f);
    const auto a = stereo(0.8f, 0.8f);
    bus.pushCapture(a.data(), kBlock, 2);
    std::vector<float> out(kBlock * 2);
    bus.render(out.data(), kBlock, 2);
    CHECK(out[0] == Approx(0.4f).epsilon(1e-4));
    CHECK(a[0] == 0.8f);  // the captured buffer itself is untouched
    bus.setGainDb(100.0f);
    CHECK(bus.getGainDb() == 12.0f);  // clamped
}

TEST_CASE("a backlog present when monitoring (re)starts is dropped down to the target", "[audio][monitor]")
{
    MonitorBus bus(kRate, 1000, 20);  // target 960
    bus.setEnabled(true);
    const auto a = stereo(0.1f, 0.1f);
    for (int i = 0; i < 8; ++i) {  // 80 ms piled up while the output was not running
        bus.pushCapture(a.data(), kBlock, 2);
    }
    std::vector<float> out(kBlock * 2);
    bus.render(out.data(), kBlock, 2);
    const auto s = bus.stats();
    CHECK(s.prefillEvents == 1);
    CHECK(s.startTrimFrames == 8 * kBlock - 960);
    CHECK(s.fillFrames == 960 - kBlock);  // started at the target, then one block played
    CHECK(out[0] == 0.1f);
}

TEST_CASE("persistently excess buffered audio is trimmed back to the target", "[audio][monitor]")
{
    MonitorBus bus(kRate, 2000, 10);  // target 480
    bus.setEnabled(true);
    const auto a = stereo(0.1f, 0.1f);
    bus.pushCapture(a.data(), kBlock, 2);
    std::vector<float> out(kBlock * 2);
    bus.render(out.data(), kBlock, 2);  // starts at the target
    // Capture clock "faster" than playback: two blocks in for every block out.
    uint32_t maxFill = 0;
    for (int i = 0; i < 70; ++i)
    {
        bus.pushCapture(a.data(), kBlock, 2);
        bus.pushCapture(a.data(), kBlock, 2);
        bus.render(out.data(), kBlock, 2);
        maxFill = std::max(maxFill, bus.stats().fillFrames);
    }
    const auto s = bus.stats();
    CHECK(s.driftTrimEvents >= 1);
    CHECK(s.driftTrimFrames > 0);
    CHECK(s.overflowEvents == 0);
    CHECK(maxFill < 60u * kBlock);  // bounded: without trimming it would reach 70 blocks
}

TEST_CASE("test tone plays for the requested time, independent of monitoring", "[audio][monitor]")
{
    MonitorBus bus(kRate, 200, 20);
    bus.startTestTone(1000.0f, -20.0f, 0.005f);  // 240 frames
    CHECK(bus.testToneActive());
    std::vector<float> out(kBlock * 2);
    bus.render(out.data(), kBlock, 2);
    float peak = 0.0f;
    for (uint32_t f = 0; f < 240; ++f)
    {
        peak = std::max(peak, std::fabs(out[2 * f]));
    }
    CHECK(peak == Approx(0.1f).epsilon(0.02));  // -20 dBFS
    CHECK(out[2 * 300] == 0.0f);
    CHECK_FALSE(bus.testToneActive());
}
