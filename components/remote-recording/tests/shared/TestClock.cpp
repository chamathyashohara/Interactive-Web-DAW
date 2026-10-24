#include <catch2/catch_test_macros.hpp>

#include "rr/shared/Clock.h"

TEST_CASE("monotonic clock never goes backwards", "[shared][clock]")
{
    int64_t previous = monotonicNs();
    for (int i = 0; i < 10000; ++i)
    {
        const int64_t now = monotonicNs();
        REQUIRE(now >= previous);
        previous = now;
    }
}

TEST_CASE("UTC formatting of known instants", "[shared][clock]")
{
    CHECK(formatUtcIso8601Ms(0) == "1970-01-01T00:00:00.000Z");
    CHECK(formatUtcIso8601Ms(951782400000) == "2000-02-29T00:00:00.000Z");  // leap day
    CHECK(formatUtcIso8601Ms(1791676800123) == "2026-10-11T00:00:00.123Z");
    CHECK(formatUtcIso8601Ms(1791763199999) == "2026-10-11T23:59:59.999Z");
    CHECK(formatUtcIso8601Ms(-1) == "1969-12-31T23:59:59.999Z");
}

TEST_CASE("UTC now is after the project start", "[shared][clock]")
{
    // 2026-08-01T00:00:00Z; guards against a broken system_clock conversion.
    CHECK(utcNowMs() > 1785542400000LL);
}
