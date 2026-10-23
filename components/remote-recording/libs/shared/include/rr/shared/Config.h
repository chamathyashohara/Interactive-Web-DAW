#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "rr/shared/Role.h"

// Defaults are the provisional values from PROTOCOL_OVERVIEW.md §8 and
// ASSUMPTIONS_AND_OPEN_QUESTIONS.md §3. They are starting settings, not tuned values.
// Nothing reads them from a file yet; the diagnostics screen shows them.

struct NetworkConfig
{
    uint16_t controlTcpPort = 52000;
    uint16_t mediaUdpPort = 52001;
    uint16_t transferTcpPort = 52002;
};

struct AudioConfig
{
    uint32_t requiredSampleRateHz = 48000;
    uint32_t liveFrameUs = 10000;  // 10 ms; must be a legal frame duration
    uint32_t jitterDepthFrames = 3;
    uint32_t devicePeriodMs = 10;
    uint32_t recordRingSeconds = 10;
};

struct SessionTimingConfig
{
    uint32_t startLeadMs = 1000;
    /**
     * Stage 12: the producer sizes the lead for the link it measured (never below start_lead_ms).
     * A cabled LAN keeps a short lead; a wireless link gets a longer one without the user having
     * to know why. Turn it off to pin the lead by hand, e.g. to reproduce a timing experiment.
     */
    bool autoStartLead = true;
    uint32_t armAckMarginMs = 100;
    uint32_t stopLeadMs = 300;
    uint32_t heartbeatIntervalMs = 1000;
    /**
     * Stage 12: was 3000, i.e. three missed heartbeats. A wireless adapter roaming between access
     * points or waking from power saving stalls for longer than that, and the link was being
     * declared lost on a link that was merely slow. 6 s still detects a genuine loss well inside
     * the finalise window, at the cost of noticing it later. Local recording is unaffected either
     * way: both PCs keep writing their own master file (REC-02).
     */
    uint32_t linkLostAfterMs = 6000;
    uint32_t finaliseReportWaitMs = 10000;
    uint32_t maxTakeSeconds = 1800;
};

struct AppConfig
{
    Role role = Role::Producer;
    NetworkConfig network;
    AudioConfig audio;
    SessionTimingConfig timing;

    static AppConfig defaultsFor(Role role);
};

/** Live frame durations allowed by ADR-006 (microseconds). */
bool isAllowedLiveFrameUs(uint32_t frameUs) noexcept;

/** Returns human-readable problems; empty means valid. */
std::vector<std::string> validate(const AppConfig& config);

/** Multi-line "key = value" text for the diagnostics screen and the startup log. */
std::string describe(const AppConfig& config);

