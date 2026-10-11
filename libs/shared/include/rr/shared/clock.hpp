#pragma once

#include <cstdint>
#include <string>

namespace rr::time {

// Monotonic time in nanoseconds (std::chrono::steady_clock; QueryPerformanceCounter on
// MSVC). Use for all intervals and protocol timestamps (ADR-010). Not related to UTC.
std::int64_t monotonic_ns() noexcept;

// Wall-clock UTC in milliseconds since 1970-01-01. Labels only, never for intervals.
std::int64_t utc_now_ms() noexcept;

// "2026-10-11T04:05:06.789Z". Pure arithmetic (no C runtime time-zone calls), so it
// behaves identically on every compiler and thread.
std::string format_utc_iso8601_ms(std::int64_t utc_ms);

}  // namespace rr::time
