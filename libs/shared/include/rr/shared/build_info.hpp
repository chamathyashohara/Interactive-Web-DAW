#pragma once

#include <cstdint>
#include <string>

namespace rr {

// Control/media protocol version (PROTOCOL_OVERVIEW.md §7). Major must match between peers.
inline constexpr std::uint16_t kProtocolMajor = 1;
inline constexpr std::uint16_t kProtocolMinor = 0;

struct BuildInfo {
    std::string version;              // "0.1.0"
    std::string git_commit;           // short hash at configure time, "-dirty" if uncommitted changes
    std::string protocol_version;     // "1.0"
    std::string compiler;             // e.g. "MSVC 193933523" or "GCC 16.2.0"
    std::string build_config;         // "Debug" / "Release"
    std::string cxx_standard;         // value of __cplusplus
    std::string toolchain_deviation;  // "none" for the pinned toolchain
};

BuildInfo build_info();

// "0.1.0 (commit abc123, Debug)".
std::string version_line();

}  // namespace rr
