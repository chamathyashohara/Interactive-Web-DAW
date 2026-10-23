#pragma once

#include <cstdint>
#include <string>

/** Control/media protocol version (PROTOCOL_OVERVIEW.md §7). Major must match between peers. */
inline constexpr uint16_t kProtocolMajor = 1;
inline constexpr uint16_t kProtocolMinor = 2;  // 1.1 (Stage 9): ReadyChecks, SessionId on commands; 1.2 (Stage 11): TRANSFER_REQUEST/ACK

struct BuildInfo
{
    std::string version;              // "0.1.0"
    std::string gitCommit;           // short hash at configure time, "-dirty" if uncommitted changes
    std::string protocolVersion;     // "1.0"
    std::string compiler;             // e.g. "MSVC 193933523" or "GCC 16.2.0"
    std::string buildConfig;         // "Debug" / "Release"
    std::string cxxStandard;         // value of __cplusplus
    std::string toolchainDeviation;  // "none" for the pinned toolchain
};

BuildInfo buildInfo();

/** "0.1.0 (commit abc123, Debug)". */
std::string versionLine();

