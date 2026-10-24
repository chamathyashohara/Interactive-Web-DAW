#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "rr/shared/ErrorCodes.h"
#include "rr/shared/Role.h"

/** Where the samples came from and what happened to them before reaching the file. */
struct CaptureDescription
{
    std::string sourceKind = "device";      // "device", or "TEST SIGNAL (not a microphone)"
    std::string backend;                      // e.g. "WASAPI"
    std::string deviceName;
    uint32_t sampleRate = 0;            // rate of the samples written
    uint32_t channels = 0;               // channels of the samples written
    std::string deviceInternalFormat;       // e.g. "f32" (WASAPI shared-mode mix format)
    uint32_t deviceInternalRate = 0;
    uint32_t deviceInternalChannels = 0;
    uint32_t devicePeriodFrames = 0;
    uint32_t devicePeriods = 0;
    std::vector<std::string> conversionNotes;  // every known transformation, stated plainly
};

struct TakeGap
{
    uint64_t fileFrame = 0;  // position in the file where silence was inserted
    uint64_t frames = 0;      // number of missing frames, filled with silence
};

/** Everything recorded about one take; written as "<stem>.json" next to the WAV. */
struct TakeMetadata
{
    uint32_t takeNumber = 0;
    Role role = Role::Producer;
    std::string sessionId;
    std::string appVersion;
    std::string fileName;          // final WAV name (exists only if finalised)
    std::string partialFileName;  // ".wav.partial" name used while recording
    std::string metadataFileName;
    TakeStatus status = TakeStatus::IncompleteCrash;
    std::string stopReason;        // "user", "shutdown", "safety_limit", "device_lost", "disk_error"
    bool finalised = false;         // header written, flushed, renamed to .wav
    std::string error;              // empty if none

    uint64_t frames = 0;
    uint32_t sampleRate = 0;
    uint32_t channels = 0;
    uint16_t wavFormatTag = 0;
    CaptureDescription capture;

    std::string startedUtc;
    std::string stoppedUtc;
    int64_t startMonoNs = 0;
    uint64_t firstCaptureFrame = 0;  // capture frame index of the first sample in the file
    /** Scheduling (Stage 6). Monotonic ns of THIS PC; 0 = not scheduled (started/stopped at once). */
    int64_t scheduledStartNs = 0;
    int64_t firstSampleNsEst = 0;   // estimated callback-time of the first sample (ADR-010)
    uint64_t lateStartFrames = 0;    // how far the scheduled start was missed (0 = on time)
    int64_t scheduledStopNs = 0;

    bool hasGaps = false;
    bool gapPositionsComplete = true;
    std::vector<TakeGap> gaps;
    uint64_t timingAnomalies = 0;

    double durationSeconds() const noexcept
    {
        return sampleRate ? static_cast<double>(frames) / sampleRate : 0.0;
    }
};

std::string toJson(const TakeMetadata& meta);

