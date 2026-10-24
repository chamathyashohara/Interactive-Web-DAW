#pragma once

#include <cstdint>
#include <string>

/**
 * Monotonic time in nanoseconds (std::chrono::steady_clock; QueryPerformanceCounter on
 * MSVC). Use for all intervals and protocol timestamps (ADR-010). Not related to UTC.
 */
int64_t monotonicNs() noexcept;

/** Wall-clock UTC in milliseconds since 1970-01-01. Labels only, never for intervals. */
int64_t utcNowMs() noexcept;

/**
 * "2026-10-11T04:05:06.789Z". Pure arithmetic (no C runtime time-zone calls), so it
 * behaves identically on every compiler and thread.
 */
std::string formatUtcIso8601Ms(int64_t utcMs);

