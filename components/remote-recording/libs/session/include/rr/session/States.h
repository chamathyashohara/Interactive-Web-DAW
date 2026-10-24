#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "rr/shared/Role.h"

/** Link machine (SESSION_STATE_MACHINE.md §2). */
enum class LinkState : uint8_t
{
    Disconnected,
    Listening,    // producer waiting for a performer
    Connecting,   // performer opening the TCP connection
    Handshaking,
    Connected,
    LinkLost,
};

inline constexpr std::array<LinkState, 6> kAllLinkStates = {
    LinkState::Disconnected, LinkState::Listening, LinkState::Connecting,
    LinkState::Handshaking, LinkState::Connected, LinkState::LinkLost,
};

/** Session/take machine (SESSION_STATE_MACHINE.md §3). */
enum class SessionState : uint8_t
{
    NotReady,
    Ready,
    Armed,
    Scheduled,
    Recording,
    Stopping,
    Finalising,
    Completed,
    Error,
    Recovery,
    Closed,
};

inline constexpr std::array<SessionState, 11> kAllSessionStates = {
    SessionState::NotReady, SessionState::Ready, SessionState::Armed,
    SessionState::Scheduled, SessionState::Recording, SessionState::Stopping,
    SessionState::Finalising, SessionState::Completed, SessionState::Error,
    SessionState::Recovery, SessionState::Closed,
};

std::string_view linkStateName(LinkState state) noexcept;        // "Disconnected"
std::string_view linkStateLabel(LinkState state) noexcept;       // "Not connected"
std::string_view sessionStateName(SessionState state) noexcept;  // "NotReady"

/** True while a take file may be open (Scheduled .. Finalising), see invariant 1. */
bool isTakeActive(SessionState state) noexcept;

/** What the UI renders. Windows never keep their own state flags (§1 rule 1). */
struct SessionSnapshot
{
    Role role = Role::Producer;
    LinkState link = LinkState::Disconnected;
    SessionState session = SessionState::NotReady;
    std::vector<std::string> notReadyReasons;
};

/**
 * The state every app starts in: not connected, not ready, with the reasons. Until
 * networking and session control exist nothing changes it. Local test recordings (Stage 4)
 * are not session takes and do not change this state.
 */
SessionSnapshot initialSnapshot(Role role);

/** One-line session status for the UI, e.g. "Not ready: audio devices not set up". */
std::string sessionStatusText(const SessionSnapshot& snapshot);

