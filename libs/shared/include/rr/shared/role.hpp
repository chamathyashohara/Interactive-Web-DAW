#pragma once

#include <cstdint>
#include <string_view>

namespace rr {

// The two applications. The producer is the session authority; the performer
// follows its acknowledged schedule (SESSION_STATE_MACHINE.md).
enum class Role : std::uint8_t {
    Producer = 1,
    Performer = 2,
};

// Stable lower-case identifier used in file names and logs ("producer").
std::string_view role_id(Role role) noexcept;

// Name shown to users ("Producer Studio").
std::string_view role_display_name(Role role) noexcept;

// Executable base name ("ProducerStudio").
std::string_view role_executable_name(Role role) noexcept;

// One-line description of what the role does.
std::string_view role_summary(Role role) noexcept;

}  // namespace rr
