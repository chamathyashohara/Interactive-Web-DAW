#include <catch2/catch_test_macros.hpp>

#include "rr/shared/role.hpp"

using rr::Role;

TEST_CASE("the two roles have distinct names", "[shared][role]") {
    CHECK(rr::role_display_name(Role::Producer) == "Producer Studio");
    CHECK(rr::role_display_name(Role::Performer) == "Performer Client");
    CHECK(rr::role_executable_name(Role::Producer) == "ProducerStudio");
    CHECK(rr::role_executable_name(Role::Performer) == "PerformerClient");
    CHECK(rr::role_id(Role::Producer) != rr::role_id(Role::Performer));
    CHECK_FALSE(rr::role_summary(Role::Producer).empty());
    CHECK(rr::role_summary(Role::Producer) != rr::role_summary(Role::Performer));
}
