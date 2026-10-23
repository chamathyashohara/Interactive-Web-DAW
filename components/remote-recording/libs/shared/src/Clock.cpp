#include "rr/shared/Clock.h"

#include <chrono>
#include <cstdio>

int64_t monotonicNs() noexcept
{
    using namespace std::chrono;
    return duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count();
}

int64_t utcNowMs() noexcept
{
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

namespace
{

// Floor division for possibly negative values.
int64_t floorDiv(int64_t a, int64_t b) noexcept
{
    int64_t q = a / b;
    if ((a % b != 0) && ((a < 0) != (b < 0)))
    {
        --q;
    }
    return q;
}

struct CivilDate
{
    int64_t year;
    unsigned month;
    unsigned day;
};

// Days since 1970-01-01 to proleptic Gregorian date (H. Hinnant, "chrono-Compatible
// Low-Level Date Algorithms", civilFromDays).
CivilDate civilFromDays(int64_t z) noexcept
{
    z += 719468;
    const int64_t era = floorDiv(z, 146097);
    const auto doe = static_cast<unsigned>(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t y = static_cast<int64_t>(yoe) + era * 400;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    const unsigned d = doy - (153 * mp + 2) / 5 + 1;
    const unsigned m = mp < 10 ? mp + 3 : mp - 9;
    return CivilDate{m <= 2 ? y + 1 : y, m, d};
}

}  // namespace

std::string formatUtcIso8601Ms(int64_t utcMs)
{
    const int64_t days = floorDiv(utcMs, 86'400'000);
    const int64_t msOfDay = utcMs - days * 86'400'000;
    const CivilDate date = civilFromDays(days);
    const auto hour = static_cast<int>(msOfDay / 3'600'000);
    const auto minute = static_cast<int>((msOfDay / 60'000) % 60);
    const auto second = static_cast<int>((msOfDay / 1000) % 60);
    const auto millis = static_cast<int>(msOfDay % 1000);

    char buffer[40];
    std::snprintf(buffer, sizeof buffer, "%04lld-%02u-%02uT%02d:%02d:%02d.%03dZ",
                  static_cast<long long>(date.year), date.month, date.day, hour, minute, second,
                  millis);
    return buffer;
}

