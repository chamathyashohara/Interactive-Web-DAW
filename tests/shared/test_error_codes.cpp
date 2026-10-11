#include <catch2/catch_test_macros.hpp>

#include <set>
#include <string>

#include "rr/shared/error_codes.hpp"

TEST_CASE("error code numbers match PROTOCOL_OVERVIEW section 6.1", "[shared][errors]") {
    CHECK(static_cast<int>(rr::ErrorCode::Ok) == 0);
    CHECK(static_cast<int>(rr::ErrorCode::VersionUnsupported) == 2);
    CHECK(static_cast<int>(rr::ErrorCode::ArmTooLate) == 8);
    CHECK(static_cast<int>(rr::ErrorCode::DiskWrite) == 13);
    CHECK(static_cast<int>(rr::ErrorCode::Internal) == 22);
    // Codes are contiguous 0..22, in order.
    for (std::size_t i = 0; i < rr::kAllErrorCodes.size(); ++i) {
        CHECK(static_cast<std::size_t>(rr::kAllErrorCodes[i]) == i);
    }
}

TEST_CASE("every error code has a unique protocol name", "[shared][errors]") {
    std::set<std::string> names;
    for (rr::ErrorCode code : rr::kAllErrorCodes) {
        const std::string name(rr::error_code_name(code));
        CHECK(name != "E_UNKNOWN_CODE");
        CHECK(names.insert(name).second);
    }
    CHECK(rr::error_code_name(rr::ErrorCode::DiskWrite) == "E_DISK_WRITE");
}

TEST_CASE("take statuses have unique names and only two count as complete", "[shared][errors]") {
    std::set<std::string> names;
    int complete = 0;
    for (rr::TakeStatus status : rr::kAllTakeStatuses) {
        CHECK(names.insert(std::string(rr::take_status_name(status))).second);
        complete += rr::take_status_is_complete(status) ? 1 : 0;
    }
    CHECK(complete == 2);
    CHECK_FALSE(rr::take_status_is_complete(rr::TakeStatus::IncompleteCrash));
}
