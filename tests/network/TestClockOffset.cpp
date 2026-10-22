#include <catch2/catch_test_macros.hpp>

#include "rr/network/ClockOffset.h"

TEST_CASE("symmetric path recovers the true offset exactly", "[network][clock]")
{
    // Responder clock is 5 ms ahead; one-way delay 1 ms each way; responder works 0.2 ms.
    const int64_t offset = 5'000'000;
    const int64_t t1 = 1'000'000'000;
    const int64_t t2 = t1 + 1'000'000 + offset;
    const int64_t t3 = t2 + 200'000;
    const int64_t t4 = (t3 - offset) + 1'000'000;
    ClockOffsetEstimator e;
    REQUIRE(e.addSample(t1, t2, t3, t4));
    CHECK(e.thetaNs() == offset);
    CHECK(e.uncertaintyNs() == 1'000'000);  // delta 2 ms / 2
}

TEST_CASE("asymmetric delay stays within theta +/- uncertainty", "[network][clock]")
{
    const int64_t offset = -3'000'000;
    const int64_t t1 = 0;
    const int64_t t2 = t1 + 4'000'000 + offset;  // slow direction
    const int64_t t3 = t2 + 100'000;
    const int64_t t4 = (t3 - offset) + 1'000'000;  // fast direction
    ClockOffsetEstimator e;
    REQUIRE(e.addSample(t1, t2, t3, t4));
    const auto error = e.thetaNs() - offset;
    CHECK(error != 0);
    CHECK((error <= e.uncertaintyNs() && error >= -e.uncertaintyNs()));
}

TEST_CASE("the sample with the smallest round trip wins; bad samples are rejected", "[network][clock]")
{
    ClockOffsetEstimator e(4, 50'000'000);
    CHECK(e.addSample(0, 10'000'000, 10'000'000, 20'000'000));  // delta 20 ms, theta 0
    CHECK(e.addSample(0, 2'500'000, 2'500'000, 2'000'000));     // delta 2 ms, theta 1.5 ms
    CHECK_FALSE(e.addSample(0, 1, 2, -5));                      // t4 < t1
    CHECK_FALSE(e.addSample(0, 0, 0, 90'000'000));              // delta over the limit
    CHECK(e.thetaNs() == 1'500'000);
    CHECK(e.uncertaintyNs() == 1'000'000);
    CHECK(e.getRejected() == 2);
    e.reset();
    CHECK_FALSE(e.hasEstimate());
}

TEST_CASE("Stage 12: an ordinary Wi-Fi round trip is measured, not rejected", "[network][clock]")
{
    // The old ceiling was 100 ms, below the round trip of a shared wireless link: every sample
    // was rejected, the sample count never grew and the performer could never become ready.
    ClockOffsetEstimator e;  // default ceiling
    const int64_t offset = 7'000'000;
    for (int i = 0; i < 4; ++i)
    {
        const int64_t oneWay = 60'000'000 + i * 10'000'000;  // 60..90 ms each way
        const int64_t t1 = static_cast<int64_t>(i) * 1'000'000'000;
        const int64_t t2 = t1 + oneWay + offset;
        const int64_t t3 = t2 + 500'000;
        const int64_t t4 = (t3 - offset) + oneWay;
        CHECK(e.addSample(t1, t2, t3, t4));
    }
    CHECK(e.getRejected() == 0);
    CHECK(e.sampleCount() == 4);
    CHECK(e.thetaNs() == offset);               // symmetric path: exact
    CHECK(e.bestDeltaNs() == 120'000'000);     // the fastest pair, 2 x 60 ms
    CHECK(e.uncertaintyNs() == 60'000'000);
}

TEST_CASE("Stage 12: a stalled link is still rejected", "[network][clock]")
{
    ClockOffsetEstimator e;
    CHECK_FALSE(e.addSample(0, 0, 0, 1'500'000'000));  // 1.5 s round trip
    CHECK(e.getRejected() == 1);
    CHECK_FALSE(e.hasEstimate());
    CHECK(e.bestDeltaNs() == -1);
}

TEST_CASE("Stage 12: the best round trip is the one the estimate came from", "[network][clock]")
{
    ClockOffsetEstimator e(4, 500'000'000);
    CHECK(e.addSample(0, 10'000'000, 10'000'000, 20'000'000));  // delta 20 ms
    CHECK(e.addSample(0, 2'500'000, 2'500'000, 2'000'000));     // delta 2 ms  <- best
    CHECK(e.addSample(0, 40'000'000, 40'000'000, 80'000'000));  // delta 80 ms
    CHECK(e.bestDeltaNs() == 2'000'000);
    CHECK(e.uncertaintyNs() == 1'000'000);      // best / 2
    CHECK(e.lastDeltaNs() == 80'000'000);      // the latest is far worse, and does not win
}
