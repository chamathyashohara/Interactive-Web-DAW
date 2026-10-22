#include <catch2/catch_test_macros.hpp>

#include <set>
#include <string>

#include "rr/shared/ErrorCodes.h"

TEST_CASE("error code numbers match PROTOCOL_OVERVIEW section 6.1", "[shared][errors]")
{
    CHECK(static_cast<int>(ErrorCode::Ok) == 0);
    CHECK(static_cast<int>(ErrorCode::VersionUnsupported) == 2);
    CHECK(static_cast<int>(ErrorCode::ArmTooLate) == 8);
    CHECK(static_cast<int>(ErrorCode::DiskWrite) == 13);
    CHECK(static_cast<int>(ErrorCode::Internal) == 22);
    // Codes are contiguous 0..22, in order.
    for (size_t i = 0; i < kAllErrorCodes.size(); ++i)
    {
        CHECK(static_cast<size_t>(kAllErrorCodes[i]) == i);
    }
}

TEST_CASE("every error code has a unique protocol name", "[shared][errors]")
{
    std::set<std::string> names;
    for (ErrorCode code : kAllErrorCodes)
    {
        const std::string name(errorCodeName(code));
        CHECK(name != "E_UNKNOWN_CODE");
        CHECK(names.insert(name).second);
    }
    CHECK(errorCodeName(ErrorCode::DiskWrite) == "E_DISK_WRITE");
}

TEST_CASE("take statuses have unique names and only two count as complete", "[shared][errors]")
{
    std::set<std::string> names;
    int complete = 0;
    for (TakeStatus status : kAllTakeStatuses)
    {
        CHECK(names.insert(std::string(takeStatusName(status))).second);
        complete += takeStatusIsComplete(status) ? 1 : 0;
    }
    CHECK(complete == 2);
    CHECK_FALSE(takeStatusIsComplete(TakeStatus::IncompleteCrash));
}
