#include "rr/shared/BuildInfo.h"

#include "rr/VersionInfo.h"

#ifndef RR_BUILD_CONFIG
#define RR_BUILD_CONFIG "unknown"
#endif

namespace
{

std::string compilerString()
{
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

BuildInfo buildInfo()
{
    BuildInfo info;
    info.version = kVersion;
    info.gitCommit = kGitCommit;
    info.protocolVersion = std::to_string(kProtocolMajor) + "." + std::to_string(kProtocolMinor);
    info.compiler = compilerString();
    info.buildConfig = RR_BUILD_CONFIG;
    info.cxxStandard = std::to_string(__cplusplus);
    info.toolchainDeviation = kToolchainDeviation;
    return info;
}

std::string versionLine()
{
    const BuildInfo info = buildInfo();
    return info.version + " (commit " + info.gitCommit + ", " + info.buildConfig + ")";
}

