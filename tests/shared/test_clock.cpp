#include <catch2/catch_test_macros.hpp>

#include "rr/shared/clock.hpp"

using rr::time::format_utc_iso8601_ms;

TEST_CASE("monotonic clock never goes backwards", "[shared][clock]") {
    std::int64_t previous = rr::time::monotonic_ns();
    for (int i = 0; i < 10000; ++i) {
        const std::int64_t now = rr::time::monotonic_ns();
        REQUIRE(now >= previous);
        previous = now;
    }
}

TEST_CASE("UTC formatting of known instants", "[shared][clock]") {
    CHECK(format_utc_iso8601_ms(0) == "1970-01-01T00:00:00.000Z");
    CHECK(format_utc_iso8601_ms(951782400000) == "2000-02-29T00:00:00.000Z");  // leap day
    CHECK(format_utc_iso8601_ms(1791676800123) == "2026-10-11T00:00:00.123Z");
    CHECK(format_utc_iso8601_ms(1791763199999) == "2026-10-11T23:59:59.999Z");
    CHECK(format_utc_iso8601_ms(-1) == "1969-12-31T23:59:59.999Z");
}

TEST_CASE("UTC now is after the project start", "[shared][clock]") {
    // 2026-08-01T00:00:00Z; guards against a broken system_clock conversion.
    CHECK(rr::time::utc_now_ms() > 1785542400000LL);
}
