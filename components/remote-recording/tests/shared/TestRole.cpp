#include <catch2/catch_test_macros.hpp>

#include "rr/shared/Role.h"

TEST_CASE("the two roles have distinct names", "[shared][role]")
{
    CHECK(roleDisplayName(Role::Producer) == "Producer Studio");
    CHECK(roleDisplayName(Role::Performer) == "Performer Client");
    CHECK(roleExecutableName(Role::Producer) == "ProducerStudio");
    CHECK(roleExecutableName(Role::Performer) == "PerformerClient");
    CHECK(roleId(Role::Producer) != roleId(Role::Performer));
    CHECK_FALSE(roleSummary(Role::Producer).empty());
    CHECK(roleSummary(Role::Producer) != roleSummary(Role::Performer));
}
