#pragma once

#include <cstdint>
#include <string_view>

/**
 * The two applications. The producer is the session authority; the performer
 * follows its acknowledged schedule (SESSION_STATE_MACHINE.md).
 */
enum class Role : uint8_t
{
    Producer = 1,
    Performer = 2,
};

/** Stable lower-case identifier used in file names and logs ("producer"). */
std::string_view roleId(Role role) noexcept;

/** Name shown to users ("Producer Studio"). */
std::string_view roleDisplayName(Role role) noexcept;

/** Executable base name ("ProducerStudio"). */
std::string_view roleExecutableName(Role role) noexcept;

/** One-line description of what the role does. */
std::string_view roleSummary(Role role) noexcept;

