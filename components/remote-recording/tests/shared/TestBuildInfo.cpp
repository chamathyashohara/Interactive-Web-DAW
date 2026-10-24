#include <catch2/catch_test_macros.hpp>

#include "rr/shared/BuildInfo.h"
#include "rr/VersionInfo.h"

TEST_CASE("build info reports the project version and protocol 1.0", "[shared][version]")
{
    const BuildInfo info = buildInfo();
    CHECK(info.version == "0.1.0");
    CHECK(info.version == kVersion);
    CHECK(info.protocolVersion == "1.2");
    CHECK_FALSE(info.gitCommit.empty());
    CHECK_FALSE(info.compiler.empty());
    CHECK_FALSE(info.buildConfig.empty());
    // C++17 or later (201703L); MSVC reports this only with /Zc:__cplusplus.
    CHECK(std::stol(info.cxxStandard) >= 201703L);
}

TEST_CASE("version line contains version and commit", "[shared][version]")
{
    const std::string line = versionLine();
    CHECK(line.find("0.1.0") != std::string::npos);
    CHECK(line.find(kGitCommit) != std::string::npos);
}
