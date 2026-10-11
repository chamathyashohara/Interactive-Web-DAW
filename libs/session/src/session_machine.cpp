#include "rr/session/session_machine.hpp"

namespace rr::session {
namespace {

using S = SessionState;
using E = SessionEvent;

constexpr Transition ok(S next) { return Transition{true, next}; }
constexpr Transition invalid() { return Transition{false, S::NotReady}; }

// Transitions shared by both roles; returns invalid() when not covered.
Transition common(S from, E e) {
    switch (from) {
    case S::NotReady:
        switch (e) {
        case E::ReadinessOk: return ok(S::Ready);
        case E::ReadinessLost: return ok(S::NotReady);
        case E::LinkLost: return ok(S::NotReady);
        case E::EngineFault: return ok(S::Error);
        case E::Shutdown: return ok(S::Closed);
        default: return invalid();
        }
    case S::Ready:
        switch (e) {
        case E::ReadinessOk: return ok(S::Ready);
        case E::ReadinessLost: return ok(S::NotReady);
        case E::LinkLost: return ok(S::NotReady);
        case E::EngineFault: return ok(S::Error);
        case E::Shutdown: return ok(S::Closed);
        default: return invalid();
        }
    case S::Completed:  // short-lived: the controller re-checks readiness immediately
        switch (e) {
        case E::ReadinessOk: return ok(S::Ready);
        case E::ReadinessLost: return ok(S::NotReady);
        case E::LinkLost: return ok(S::NotReady);
        case E::Shutdown: return ok(S::Closed);
        default: return invalid();
        }
    case S::Error:
        switch (e) {
        case E::UserRetry: return ok(S::Recovery);
        case E::Shutdown: return ok(S::Closed);
        default: return invalid();
        }
    case S::Recovery:
        switch (e) {
        case E::RecoveryOk: return ok(S::NotReady);
        case E::RecoveryFailed: return ok(S::Error);
        case E::Shutdown: return ok(S::Closed);
        default: return invalid();
        }
    case S::Closed:
        return invalid();
    default:
        return invalid();
    }
}

}  // namespace

const char* session_event_name(SessionEvent e) noexcept {
    switch (e) {
    case E::ReadinessOk: return "ReadinessOk";
    case E::ReadinessLost: return "ReadinessLost";
    case E::UserRecord: return "UserRecord";
    case E::ArmAckReceived: return "ArmAckReceived";
    case E::StartAckReceived: return "StartAckReceived";
    case E::TakeRefused: return "TakeRefused";
    case E::ArmReceived: return "ArmReceived";
    case E::ScheduleReceived: return "ScheduleReceived";
    case E::CancelReceived: return "CancelReceived";
    case E::ArmExpired: return "ArmExpired";
    case E::LocalTakeStarted: return "LocalTakeStarted";
    case E::UserStop: return "UserStop";
    case E::StopReceived: return "StopReceived";
    case E::UserStopAndSave: return "UserStopAndSave";
    case E::LocalFault: return "LocalFault";
    case E::LocalFinalised: return "LocalFinalised";
    case E::TakeComplete: return "TakeComplete";
    case E::LinkLost: return "LinkLost";
    case E::EngineFault: return "EngineFault";
    case E::UserRetry: return "UserRetry";
    case E::RecoveryOk: return "RecoveryOk";
    case E::RecoveryFailed: return "RecoveryFailed";
    case E::Shutdown: return "Shutdown";
    }
    return "Unknown";
}

Transition producer_transition(SessionState from, SessionEvent e) noexcept {
    switch (from) {
    case S::Ready:
        if (e == E::UserRecord) {
            return ok(S::Armed);  // ARM sent, waiting for ARM_ACK
        }
        return common(from, e);
    case S::Armed:  // waiting for ARM_ACK, then (after SCHEDULE_START) for START_ACK
        switch (e) {
        case E::ArmAckReceived: return ok(S::Armed);
        case E::StartAckReceived: return ok(S::Scheduled);
        case E::TakeRefused: return ok(S::NotReady);
        case E::LinkLost: return ok(S::NotReady);
        case E::Shutdown: return ok(S::Closed);
        default: return invalid();
        }
    case S::Scheduled:  // both agreed on the start time; waiting for the local start
        switch (e) {
        case E::LocalTakeStarted: return ok(S::Recording);
        case E::TakeRefused: return ok(S::NotReady);
        case E::LinkLost: return ok(S::NotReady);  // never start a take the producer cannot see (A-3)
        case E::Shutdown: return ok(S::Closed);
        default: return invalid();
        }
    case S::Recording:
        switch (e) {
        case E::UserStop: return ok(S::Stopping);
        case E::LinkLost: return ok(S::Recording);  // local recording continues (ERR-03)
        case E::LocalFault: return ok(S::Finalising);
        case E::Shutdown: return ok(S::Stopping);
        default: return invalid();
        }
    case S::Stopping:
        switch (e) {
        case E::UserStop: return ok(S::Stopping);
        case E::LocalFinalised: return ok(S::Finalising);
        case E::LocalFault: return ok(S::Finalising);
        case E::LinkLost: return ok(S::Stopping);
        case E::Shutdown: return ok(S::Stopping);
        default: return invalid();
        }
    case S::Finalising:  // local result known or pending; waiting for the performer's report
        switch (e) {
        case E::LocalFinalised: return ok(S::Finalising);
        case E::TakeComplete: return ok(S::Completed);
        case E::LinkLost: return ok(S::Finalising);
        case E::Shutdown: return ok(S::Closed);
        default: return invalid();
        }
    default:
        return common(from, e);
    }
}

Transition performer_transition(SessionState from, SessionEvent e) noexcept {
    switch (from) {
    case S::Ready:
        if (e == E::ArmReceived) {
            return ok(S::Armed);
        }
        return common(from, e);
    case S::Armed:
        switch (e) {
        case E::ScheduleReceived: return ok(S::Scheduled);
        case E::CancelReceived: return ok(S::Ready);
        case E::ArmExpired: return ok(S::Ready);
        case E::TakeRefused: return ok(S::Ready);
        case E::LinkLost: return ok(S::NotReady);
        case E::Shutdown: return ok(S::Closed);
        default: return invalid();
        }
    case S::Scheduled:
        switch (e) {
        case E::LocalTakeStarted: return ok(S::Recording);
        case E::CancelReceived: return ok(S::Ready);
        case E::TakeRefused: return ok(S::Ready);
        case E::LinkLost: return ok(S::NotReady);  // no recording starts without a live link at T
        case E::Shutdown: return ok(S::Closed);
        default: return invalid();
        }
    case S::Recording:
        switch (e) {
        case E::StopReceived: return ok(S::Stopping);
        case E::UserStopAndSave: return ok(S::Stopping);
        case E::LinkLost: return ok(S::Recording);  // keep recording locally (ERR-03, OQ-02 proposal)
        case E::LocalFault: return ok(S::Finalising);
        case E::Shutdown: return ok(S::Stopping);
        default: return invalid();
        }
    case S::Stopping:
        switch (e) {
        case E::StopReceived: return ok(S::Stopping);
        case E::UserStopAndSave: return ok(S::Stopping);
        case E::LocalFinalised: return ok(S::Completed);
        case E::LocalFault: return ok(S::Finalising);
        case E::LinkLost: return ok(S::Stopping);
        case E::Shutdown: return ok(S::Stopping);
        default: return invalid();
        }
    case S::Finalising:
        switch (e) {
        case E::LocalFinalised: return ok(S::Completed);
        case E::LinkLost: return ok(S::Finalising);
        case E::Shutdown: return ok(S::Closed);
        default: return invalid();
        }
    default:
        return common(from, e);
    }
}

Transition session_transition(Role role, SessionState from, SessionEvent event) noexcept {
    return role == Role::Producer ? producer_transition(from, event) : performer_transition(from, event);
}

}  // namespace rr::session
