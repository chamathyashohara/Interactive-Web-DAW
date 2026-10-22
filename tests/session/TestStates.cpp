#include <catch2/catch_test_macros.hpp>

#include <set>
#include <string>

#include "rr/session/States.h"

TEST_CASE("apps start disconnected and not ready, never recording", "[session][states]")
{
    for (Role role : {Role::Producer, Role::Performer})
    {
        const SessionSnapshot s = initialSnapshot(role);
        CHECK(s.role == role);
        CHECK(s.link == LinkState::Disconnected);
        CHECK(s.session == SessionState::NotReady);
        CHECK_FALSE(isTakeActive(s.session));
        CHECK_FALSE(s.notReadyReasons.empty());
        CHECK(linkStateLabel(s.link) == "Not connected");
        const std::string status = sessionStatusText(s);
        CHECK(status.rfind("Not ready", 0) == 0);
        CHECK(status.find("Recording") == std::string::npos);
    }
}

TEST_CASE("every state has a unique name and label", "[session][states]")
{
    std::set<std::string> linkNames, linkLabels, sessionNames;
    for (LinkState s : kAllLinkStates)
    {
        CHECK(linkNames.insert(std::string(linkStateName(s))).second);
        CHECK(linkLabels.insert(std::string(linkStateLabel(s))).second);
    }
    for (SessionState s : kAllSessionStates)
    {
        CHECK(sessionNames.insert(std::string(sessionStateName(s))).second);
        CHECK(sessionStatusText(SessionSnapshot{Role::Producer, LinkState::Connected, s, {}}) != "Unknown");
    }
}

TEST_CASE("take-active states are exactly Scheduled..Finalising", "[session][states]")
{
    int active = 0;
    for (SessionState s : kAllSessionStates)
    {
        active += isTakeActive(s) ? 1 : 0;
    }
    CHECK(active == 4);
    CHECK(isTakeActive(SessionState::Recording));
    CHECK_FALSE(isTakeActive(SessionState::Ready));
    CHECK_FALSE(isTakeActive(SessionState::Completed));
}
