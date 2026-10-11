#include <catch2/catch_test_macros.hpp>

#include "rr/shared/build_info.hpp"
#include "rr/version_info.hpp"

TEST_CASE("build info reports the project version and protocol 1.0", "[shared][version]") {
    const rr::BuildInfo info = rr::build_info();
    CHECK(info.version == "0.1.0");
    CHECK(info.version == rr::build::kVersion);
    CHECK(info.protocol_version == "1.1");
    CHECK_FALSE(info.git_commit.empty());
    CHECK_FALSE(info.compiler.empty());
    CHECK_FALSE(info.build_config.empty());
    // C++17 or later (201703L); MSVC reports this only with /Zc:__cplusplus.
    CHECK(std::stol(info.cxx_standard) >= 201703L);
}

TEST_CASE("version line contains version and commit", "[shared][version]") {
    const std::string line = rr::version_line();
    CHECK(line.find("0.1.0") != std::string::npos);
    CHECK(line.find(rr::build::kGitCommit) != std::string::npos);
}
