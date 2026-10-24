// Meter values computed by the capture callback path. TEST SIGNAL - NOT A MICROPHONE.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "rr/audio/CaptureIngest.h"
#include "rr/shared/Clock.h"

using Catch::Approx;

TEST_CASE("peak, RMS and clip counts per channel, reset on read", "[audio][levels]")
{
    CaptureIngest ingest(2, 48000, 1);
    std::vector<float> block(480 * 2);
    for (size_t f = 0; f < 480; ++f)
    {
        block[2 * f] = 0.5f;                                                        // ch1: DC 0.5
        block[2 * f + 1] = 0.8f * static_cast<float>(std::sin(6.283185307 * static_cast<double>(f) / 48.0));  // ch2: 1 kHz
    }
    block[10] = 1.0f;  // one clipped sample on ch1
    ingest.onBlock(block.data(), 480, monotonicNs());

    const auto ch1 = ingest.takeLevels(0);
    CHECK(ch1.peak == 1.0f);
    CHECK(ch1.clipped == 1);
    CHECK(ch1.samples == 480);
    CHECK(ch1.rms == Approx(0.5f).epsilon(0.01));
    const auto ch2 = ingest.takeLevels(1);
    CHECK(ch2.peak == Approx(0.8f).epsilon(0.01));
    CHECK(ch2.rms == Approx(0.8f / std::sqrt(2.0f)).epsilon(0.01));
    CHECK(ch2.clipped == 0);

    const auto again = ingest.takeLevels(0);  // reset after reading
    CHECK(again.peak == 0.0f);
    CHECK(again.samples == 0);
    CHECK(ingest.stats().clippedSamples == 1);
}

TEST_CASE("record ring fill level is tracked with its maximum", "[audio][levels]")
{
    CaptureIngest ingest(1, 48000, 1);
    std::vector<float> block(480, 0.1f);
    for (int i = 0; i < 5; ++i)
    {
        ingest.onBlock(block.data(), 480, monotonicNs());
    }
    auto s = ingest.stats();
    CHECK(s.ringFillFrames == 2400);
    CHECK(s.ringMaxFillFrames == 2400);
    CHECK(s.ringCapacityFrames >= 48000);
    std::vector<float> sink(2400);
    ingest.getSamples().read(sink.data(), sink.size());  // consumer drains
    ingest.onBlock(block.data(), 480, monotonicNs());
    s = ingest.stats();
    CHECK(s.ringFillFrames == 480);
    CHECK(s.ringMaxFillFrames == 2400);
}
