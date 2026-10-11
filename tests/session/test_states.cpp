#include <catch2/catch_test_macros.hpp>

#include <set>
#include <string>

#include "rr/session/states.hpp"

using namespace rr::session;
using rr::Role;

TEST_CASE("apps start disconnected and not ready, never recording", "[session][states]") {
    for (Role role : {Role::Producer, Role::Performer}) {
        const SessionSnapshot s = initial_snapshot(role);
        CHECK(s.role == role);
        CHECK(s.link == LinkState::Disconnected);
        CHECK(s.session == SessionState::NotReady);
        CHECK_FALSE(is_take_active(s.session));
        CHECK_FALSE(s.not_ready_reasons.empty());
        CHECK(link_state_label(s.link) == "Not connected");
        const std::string status = session_status_text(s);
        CHECK(status.rfind("Not ready", 0) == 0);
        CHECK(status.find("Recording") == std::string::npos);
    }
}

TEST_CASE("every state has a unique name and label", "[session][states]") {
    std::set<std::string> link_names, link_labels, session_names;
    for (LinkState s : kAllLinkStates) {
        CHECK(link_names.insert(std::string(link_state_name(s))).second);
        CHECK(link_labels.insert(std::string(link_state_label(s))).second);
    }
    for (SessionState s : kAllSessionStates) {
        CHECK(session_names.insert(std::string(session_state_name(s))).second);
        CHECK(session_status_text(SessionSnapshot{Role::Producer, LinkState::Connected, s, {}}) != "Unknown");
    }
}

TEST_CASE("take-active states are exactly Scheduled..Finalising", "[session][states]") {
    int active = 0;
    for (SessionState s : kAllSessionStates) {
        active += is_take_active(s) ? 1 : 0;
    }
    CHECK(active == 4);
    CHECK(is_take_active(SessionState::Recording));
    CHECK_FALSE(is_take_active(SessionState::Ready));
    CHECK_FALSE(is_take_active(SessionState::Completed));
}
