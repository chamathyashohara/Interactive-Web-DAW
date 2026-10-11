#include <catch2/catch_test_macros.hpp>

#include "rr/network/clock_offset.hpp"

using rr::net::ClockOffsetEstimator;

TEST_CASE("symmetric path recovers the true offset exactly", "[network][clock]") {
    // Responder clock is 5 ms ahead; one-way delay 1 ms each way; responder works 0.2 ms.
    const std::int64_t offset = 5'000'000;
    const std::int64_t t1 = 1'000'000'000;
    const std::int64_t t2 = t1 + 1'000'000 + offset;
    const std::int64_t t3 = t2 + 200'000;
    const std::int64_t t4 = (t3 - offset) + 1'000'000;
    ClockOffsetEstimator e;
    REQUIRE(e.add_sample(t1, t2, t3, t4));
    CHECK(e.theta_ns() == offset);
    CHECK(e.uncertainty_ns() == 1'000'000);  // delta 2 ms / 2
}

TEST_CASE("asymmetric delay stays within theta +/- uncertainty", "[network][clock]") {
    const std::int64_t offset = -3'000'000;
    const std::int64_t t1 = 0;
    const std::int64_t t2 = t1 + 4'000'000 + offset;  // slow direction
    const std::int64_t t3 = t2 + 100'000;
    const std::int64_t t4 = (t3 - offset) + 1'000'000;  // fast direction
    ClockOffsetEstimator e;
    REQUIRE(e.add_sample(t1, t2, t3, t4));
    const auto error = e.theta_ns() - offset;
    CHECK(error != 0);
    CHECK((error <= e.uncertainty_ns() && error >= -e.uncertainty_ns()));
}

TEST_CASE("the sample with the smallest round trip wins; bad samples are rejected", "[network][clock]") {
    ClockOffsetEstimator e(4, 50'000'000);
    CHECK(e.add_sample(0, 10'000'000, 10'000'000, 20'000'000));  // delta 20 ms, theta 0
    CHECK(e.add_sample(0, 2'500'000, 2'500'000, 2'000'000));     // delta 2 ms, theta 1.5 ms
    CHECK_FALSE(e.add_sample(0, 1, 2, -5));                      // t4 < t1
    CHECK_FALSE(e.add_sample(0, 0, 0, 90'000'000));              // delta over the limit
    CHECK(e.theta_ns() == 1'500'000);
    CHECK(e.uncertainty_ns() == 1'000'000);
    CHECK(e.rejected() == 2);
    e.reset();
    CHECK_FALSE(e.has_estimate());
}
