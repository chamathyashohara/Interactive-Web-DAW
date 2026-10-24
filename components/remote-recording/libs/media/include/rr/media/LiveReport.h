#pragma once

// Status lines and the one-page live diagnostics report (Stage 8, ADR-018). Shared by the apps
// and rr_session_probe, so both export the same report. Plain text, about one printed page.

#include <cstdint>
#include <string>

#include "rr/media/LiveEndpoint.h"

/** One line each, for the five separate status rows (Stage 8 task 4). */
std::string outgoingStatusText(const OutgoingStats& o, const EndpointStats& e);
std::string incomingStatusText(const IncomingStats& i, const EndpointStats& e);

/** What only the caller knows (devices, recording, control link, test set-up). */
struct LiveReportConditions
{
    std::string generatedUtc;
    std::string role;                     // "Producer" / "Performer"
    std::string appVersion;
    std::string sessionId;
    std::string captureDevice;
    uint32_t captureRate = 0;
    std::string outputDevice;
    uint32_t outputRate = 0;
    std::string localCaptureStatus;     // e.g. "running, 48000 Hz, 2 ch"
    std::string localRecordingStatus;   // e.g. "recording take 3" / "idle"
    std::string remoteParticipantStatus;// e.g. "connected (control link), RTT 0.4 ms"
    std::string testConditions;          // e.g. "two PCs, gigabit switch, headphones on both"
    std::string headphones;               // "confirmed by the user" / "not confirmed"
};

std::string liveReportText(const LiveReportConditions& c, const LiveEndpoint& endpoint);

