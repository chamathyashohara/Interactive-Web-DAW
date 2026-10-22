#include <catch2/catch_test_macros.hpp>

#include <set>
#include <tuple>

#include "rr/session/SessionMachine.h"

using S = SessionState;
using E = SessionEvent;

namespace
{

using Edge = std::tuple<S, E, S>;

// The complete documented tables (SESSION_STATE_MACHINE.md, revised in Stage 6). Every
// (state, event) pair not listed here must be rejected.
const std::set<Edge> kCommon = {
    {S::NotReady, E::ReadinessOk, S::Ready},     {S::NotReady, E::ReadinessLost, S::NotReady},
    {S::NotReady, E::LinkLost, S::NotReady},     {S::NotReady, E::EngineFault, S::Error},
    {S::NotReady, E::Shutdown, S::Closed},       {S::Ready, E::ReadinessOk, S::Ready},
    {S::Ready, E::ReadinessLost, S::NotReady},   {S::Ready, E::LinkLost, S::NotReady},
    {S::Ready, E::EngineFault, S::Error},        {S::Ready, E::Shutdown, S::Closed},
    {S::Completed, E::ReadinessOk, S::Ready},    {S::Completed, E::ReadinessLost, S::NotReady},
    {S::Completed, E::LinkLost, S::NotReady},    {S::Completed, E::Shutdown, S::Closed},
    {S::Error, E::UserRetry, S::Recovery},       {S::Error, E::Shutdown, S::Closed},
    {S::Recovery, E::RecoveryOk, S::NotReady},   {S::Recovery, E::RecoveryFailed, S::Error},
    {S::Recovery, E::Shutdown, S::Closed},
};

std::set<Edge> producerEdges()
{
    std::set<Edge> e = kCommon;
    e.insert({
        {S::Ready, E::UserRecord, S::Armed},
        {S::Armed, E::ArmAckReceived, S::Armed},       {S::Armed, E::StartAckReceived, S::Scheduled},
        {S::Armed, E::TakeRefused, S::NotReady},       {S::Armed, E::LinkLost, S::NotReady},
        {S::Armed, E::Shutdown, S::Closed},
        {S::Scheduled, E::LocalTakeStarted, S::Recording}, {S::Scheduled, E::TakeRefused, S::NotReady},
        {S::Scheduled, E::LinkLost, S::NotReady},      {S::Scheduled, E::Shutdown, S::Closed},
        {S::Recording, E::UserStop, S::Stopping},      {S::Recording, E::LinkLost, S::Recording},
        {S::Recording, E::LocalFault, S::Finalising},  {S::Recording, E::Shutdown, S::Stopping},
        {S::Stopping, E::UserStop, S::Stopping},       {S::Stopping, E::LocalFinalised, S::Finalising},
        {S::Stopping, E::LocalFault, S::Finalising},   {S::Stopping, E::LinkLost, S::Stopping},
        {S::Stopping, E::Shutdown, S::Stopping},
        {S::Finalising, E::LocalFinalised, S::Finalising}, {S::Finalising, E::TakeComplete, S::Completed},
        {S::Finalising, E::LinkLost, S::Finalising},   {S::Finalising, E::Shutdown, S::Closed},
    });
    return e;
}

std::set<Edge> performerEdges()
{
    std::set<Edge> e = kCommon;
    e.insert({
        {S::Ready, E::ArmReceived, S::Armed},
        {S::Armed, E::ScheduleReceived, S::Scheduled}, {S::Armed, E::CancelReceived, S::Ready},
        {S::Armed, E::ArmExpired, S::Ready},           {S::Armed, E::TakeRefused, S::Ready},
        {S::Armed, E::LinkLost, S::NotReady},          {S::Armed, E::Shutdown, S::Closed},
        {S::Scheduled, E::LocalTakeStarted, S::Recording}, {S::Scheduled, E::CancelReceived, S::Ready},
        {S::Scheduled, E::TakeRefused, S::Ready},      {S::Scheduled, E::LinkLost, S::NotReady},
        {S::Scheduled, E::Shutdown, S::Closed},
        {S::Recording, E::StopReceived, S::Stopping},  {S::Recording, E::UserStopAndSave, S::Stopping},
        {S::Recording, E::LinkLost, S::Recording},     {S::Recording, E::LocalFault, S::Finalising},
        {S::Recording, E::Shutdown, S::Stopping},
        {S::Stopping, E::StopReceived, S::Stopping},   {S::Stopping, E::UserStopAndSave, S::Stopping},
        {S::Stopping, E::LocalFinalised, S::Completed}, {S::Stopping, E::LocalFault, S::Finalising},
        {S::Stopping, E::LinkLost, S::Stopping},       {S::Stopping, E::Shutdown, S::Stopping},
        {S::Finalising, E::LocalFinalised, S::Completed}, {S::Finalising, E::LinkLost, S::Finalising},
        {S::Finalising, E::Shutdown, S::Closed},
    });
    return e;
}

void checkTable(Role role, const std::set<Edge>& expected)
{
    int valid = 0;
    for (S s : kAllSessionStates)
    {
        for (E e : kAllSessionEvents)
        {
            const Transition t = sessionTransition(role, s, e);
            const bool listed = [&] {
                for (const Edge& edge : expected)
                {
                    if (std::get<0>(edge) == s && std::get<1>(edge) == e)
                    {
                        return true;
                    }
                }
                return false;
            }();
            INFO(sessionStateName(s) << " + " << sessionEventName(e));
            CHECK(t.valid == listed);
            if (listed)
            {
                ++valid;
                CHECK(expected.count({s, e, t.next}) == 1);
            }
        }
    }
    CHECK(valid == static_cast<int>(expected.size()));
}

}  // namespace

TEST_CASE("producer transition table matches the documented edges exactly", "[session][machine]")
{
    checkTable(Role::Producer, producerEdges());
}

TEST_CASE("performer transition table matches the documented edges exactly", "[session][machine]")
{
    checkTable(Role::Performer, performerEdges());
}

TEST_CASE("roles cannot use each other's take-starting events", "[session][machine]")
{
    CHECK_FALSE(performerTransition(S::Ready, E::UserRecord).valid);  // SES-08
    CHECK_FALSE(producerTransition(S::Ready, E::ArmReceived).valid);
    CHECK_FALSE(performerTransition(S::Ready, E::ScheduleReceived).valid);  // no SCHEDULE without ARM
    CHECK_FALSE(performerTransition(S::NotReady, E::ArmReceived).valid);    // not ready -> refused
    CHECK_FALSE(producerTransition(S::Recording, E::UserRecord).valid);     // no second take
}

TEST_CASE("losing the link never stops a running take but cancels a pending one", "[session][machine]")
{
    for (Role role : {Role::Producer, Role::Performer})
    {
        CHECK(sessionTransition(role, S::Recording, E::LinkLost).next == S::Recording);
        CHECK(sessionTransition(role, S::Stopping, E::LinkLost).next == S::Stopping);
        CHECK(sessionTransition(role, S::Scheduled, E::LinkLost).next == S::NotReady);
        CHECK(sessionTransition(role, S::Armed, E::LinkLost).next == S::NotReady);
    }
}
