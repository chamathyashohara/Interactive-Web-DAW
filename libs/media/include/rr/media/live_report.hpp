#pragma once

// Status lines and the one-page live diagnostics report (Stage 8, ADR-018). Shared by the apps
// and rr_session_probe, so both export the same report. Plain text, about one printed page.

#include <cstdint>
#include <string>

#include "rr/media/live_endpoint.hpp"

namespace rr::media {

// One line each, for the five separate status rows (Stage 8 task 4).
std::string outgoing_status_text(const OutgoingStats& o, const EndpointStats& e);
std::string incoming_status_text(const IncomingStats& i, const EndpointStats& e);

// What only the caller knows (devices, recording, control link, test set-up).
struct LiveReportConditions {
    std::string generated_utc;
    std::string role;                     // "Producer" / "Performer"
    std::string app_version;
    std::string session_id;
    std::string capture_device;
    std::uint32_t capture_rate = 0;
    std::string output_device;
    std::uint32_t output_rate = 0;
    std::string local_capture_status;     // e.g. "running, 48000 Hz, 2 ch"
    std::string local_recording_status;   // e.g. "recording take 3" / "idle"
    std::string remote_participant_status;// e.g. "connected (control link), RTT 0.4 ms"
    std::string test_conditions;          // e.g. "two PCs, gigabit switch, headphones on both"
    std::string headphones;               // "confirmed by the user" / "not confirmed"
};

std::string live_report_text(const LiveReportConditions& c, const LiveEndpoint& endpoint);

}  // namespace rr::media
