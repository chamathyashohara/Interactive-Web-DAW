#include "rr/shared/build_info.hpp"

#include "rr/version_info.hpp"

#ifndef RR_BUILD_CONFIG
#define RR_BUILD_CONFIG "unknown"
#endif

namespace rr {
namespace {

std::string compiler_string() {
#if defined(_MSC_VER) && !defined(__clang__)
    return "MSVC " + std::to_string(_MSC_FULL_VER);
#elif defined(__clang__)
    return std::string("Clang ") + __clang_version__;
#elif defined(__GNUC__)
    return std::string("GCC ") + __VERSION__;
#else
    return "unknown compiler";
#endif
}

}  // namespace

BuildInfo build_info() {
    BuildInfo info;
    info.version = build::kVersion;
    info.git_commit = build::kGitCommit;
    info.protocol_version = std::to_string(kProtocolMajor) + "." + std::to_string(kProtocolMinor);
    info.compiler = compiler_string();
    info.build_config = RR_BUILD_CONFIG;
    info.cxx_standard = std::to_string(__cplusplus);
    info.toolchain_deviation = build::kToolchainDeviation;
    return info;
}

std::string version_line() {
    const BuildInfo info = build_info();
    return info.version + " (commit " + info.git_commit + ", " + info.build_config + ")";
}

}  // namespace rr
