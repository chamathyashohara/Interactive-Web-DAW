#include "rr/session/States.h"

std::string_view linkStateName(LinkState state) noexcept
{
    switch (state)
    {
    case LinkState::Disconnected: return "Disconnected";
    case LinkState::Listening: return "Listening";
    case LinkState::Connecting: return "Connecting";
    case LinkState::Handshaking: return "Handshaking";
    case LinkState::Connected: return "Connected";
    case LinkState::LinkLost: return "LinkLost";
    }
    return "Unknown";
}

std::string_view linkStateLabel(LinkState state) noexcept
{
    switch (state)
    {
    case LinkState::Disconnected: return "Not connected";
    case LinkState::Listening: return "Waiting for the performer to join";
    case LinkState::Connecting: return "Connecting...";
    case LinkState::Handshaking: return "Connecting (checking versions)...";
    case LinkState::Connected: return "Connected";
    case LinkState::LinkLost: return "Connection lost";
    }
    return "Unknown";
}

std::string_view sessionStateName(SessionState state) noexcept
{
    switch (state)
    {
    case SessionState::NotReady: return "NotReady";
    case SessionState::Ready: return "Ready";
    case SessionState::Armed: return "Armed";
    case SessionState::Scheduled: return "Scheduled";
    case SessionState::Recording: return "Recording";
    case SessionState::Stopping: return "Stopping";
    case SessionState::Finalising: return "Finalising";
    case SessionState::Completed: return "Completed";
    case SessionState::Error: return "Error";
    case SessionState::Recovery: return "Recovery";
    case SessionState::Closed: return "Closed";
    }
    return "Unknown";
}

bool isTakeActive(SessionState state) noexcept
{
    switch (state)
    {
    case SessionState::Scheduled:
    case SessionState::Recording:
    case SessionState::Stopping:
    case SessionState::Finalising:
        return true;
    default:
        return false;
    }
}

SessionSnapshot initialSnapshot(Role role)
{
    SessionSnapshot s;
    s.role = role;
    s.link = LinkState::Disconnected;
    s.session = SessionState::NotReady;
    // Stage 6: session control exists; live talkback (Stage 7) does not.
    s.notReadyReasons = {role == Role::Producer ? "no session created yet" : "not joined to a session"};
    return s;
}

std::string sessionStatusText(const SessionSnapshot& snapshot)
{
    switch (snapshot.session)
    {
    case SessionState::NotReady: {
        std::string text = "Not ready";
        if (!snapshot.notReadyReasons.empty())
        {
            text += ": ";
            for (size_t i = 0; i < snapshot.notReadyReasons.size(); ++i)
            {
                if (i > 0)
                {
                    text += "; ";
                }
                text += snapshot.notReadyReasons[i];
            }
        }
        return text;
    }
    case SessionState::Ready: return "Ready";
    case SessionState::Armed:
    case SessionState::Scheduled: return "Starting take...";
    case SessionState::Recording: return "Recording";
    case SessionState::Stopping:
    case SessionState::Finalising: return "Saving take...";
    case SessionState::Completed: return "Take finished";
    case SessionState::Error: return "Error";
    case SessionState::Recovery: return "Recovering...";
    case SessionState::Closed: return "Closed";
    }
    return "Unknown";
}

