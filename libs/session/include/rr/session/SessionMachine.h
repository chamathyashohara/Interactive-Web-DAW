#pragma once

#include <array>
#include <cstdint>

#include "rr/session/States.h"

/**
 * Events of the session/take machine (SESSION_STATE_MACHINE.md §3, refined in Stage 6 for the
 * two-step ARM -> SCHEDULE_START exchange). The controller turns user actions, control messages,
 * timers and local recorder reports into these events and asks the tables below whether they are
 * allowed. An event that is not listed for a state is INVALID: it changes nothing, is logged and
 * (for a message) answered with an error.
 */
enum class SessionEvent : uint8_t
{
    ReadinessOk,         // all readiness conditions hold
    ReadinessLost,
    UserRecord,          // producer pressed Record
    ArmAckReceived,      // producer: performer accepted ARM
    StartAckReceived,    // producer: performer accepted SCHEDULE_START
    TakeRefused,         // ARM/START refused or timed out, or the local schedule failed
    ArmReceived,         // performer: valid ARM
    ScheduleReceived,    // performer: valid SCHEDULE_START for the armed take
    CancelReceived,      // performer: CANCEL for the current take
    ArmExpired,          // performer: no SCHEDULE_START in time after ARM
    LocalTakeStarted,    // local recorder wrote its first sample
    UserStop,            // producer pressed Stop
    StopReceived,        // performer: STOP_SCHEDULE for the current take
    UserStopAndSave,     // performer pressed Stop & save
    LocalFault,          // local take ended early (device lost, disk error)
    LocalFinalised,      // local take file finalised (or abandoned) and reported
    TakeComplete,        // producer: local and peer results known (or peer report timed out)
    LinkLost,
    EngineFault,
    UserRetry,
    RecoveryOk,
    RecoveryFailed,
    Shutdown,
};

inline constexpr std::array<SessionEvent, 23> kAllSessionEvents = {
    SessionEvent::ReadinessOk,      SessionEvent::ReadinessLost,  SessionEvent::UserRecord,
    SessionEvent::ArmAckReceived,   SessionEvent::StartAckReceived, SessionEvent::TakeRefused,
    SessionEvent::ArmReceived,      SessionEvent::ScheduleReceived, SessionEvent::CancelReceived,
    SessionEvent::ArmExpired,       SessionEvent::LocalTakeStarted, SessionEvent::UserStop,
    SessionEvent::StopReceived,     SessionEvent::UserStopAndSave,  SessionEvent::LocalFault,
    SessionEvent::LocalFinalised,   SessionEvent::TakeComplete,     SessionEvent::LinkLost,
    SessionEvent::EngineFault,      SessionEvent::UserRetry,        SessionEvent::RecoveryOk,
    SessionEvent::RecoveryFailed,   SessionEvent::Shutdown,
};

const char* sessionEventName(SessionEvent event) noexcept;

struct Transition
{
    bool valid = false;
    SessionState next = SessionState::NotReady;
};

Transition producerTransition(SessionState from, SessionEvent event) noexcept;
Transition performerTransition(SessionState from, SessionEvent event) noexcept;
Transition sessionTransition(Role role, SessionState from, SessionEvent event) noexcept;

