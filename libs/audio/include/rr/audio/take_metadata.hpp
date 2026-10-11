#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "rr/shared/error_codes.hpp"
#include "rr/shared/role.hpp"

namespace rr::audio {

// Where the samples came from and what happened to them before reaching the file.
struct CaptureDescription {
    std::string source_kind = "device";      // "device", or "TEST SIGNAL (not a microphone)"
    std::string backend;                      // e.g. "WASAPI"
    std::string device_name;
    std::uint32_t sample_rate = 0;            // rate of the samples written
    std::uint32_t channels = 0;               // channels of the samples written
    std::string device_internal_format;       // e.g. "f32" (WASAPI shared-mode mix format)
    std::uint32_t device_internal_rate = 0;
    std::uint32_t device_internal_channels = 0;
    std::uint32_t device_period_frames = 0;
    std::uint32_t device_periods = 0;
    std::vector<std::string> conversion_notes;  // every known transformation, stated plainly
};

struct TakeGap {
    std::uint64_t file_frame = 0;  // position in the file where silence was inserted
    std::uint64_t frames = 0;      // number of missing frames, filled with silence
};

// Everything recorded about one take; written as "<stem>.json" next to the WAV.
struct TakeMetadata {
    std::uint32_t take_number = 0;
    Role role = Role::Producer;
    std::string session_id;
    std::string app_version;
    std::string file_name;          // final WAV name (exists only if finalised)
    std::string partial_file_name;  // ".wav.partial" name used while recording
    std::string metadata_file_name;
    TakeStatus status = TakeStatus::IncompleteCrash;
    std::string stop_reason;        // "user", "shutdown", "safety_limit", "device_lost", "disk_error"
    bool finalised = false;         // header written, flushed, renamed to .wav
    std::string error;              // empty if none

    std::uint64_t frames = 0;
    std::uint32_t sample_rate = 0;
    std::uint32_t channels = 0;
    std::uint16_t wav_format_tag = 0;
    CaptureDescription capture;

    std::string started_utc;
    std::string stopped_utc;
    std::int64_t start_mono_ns = 0;
    std::uint64_t first_capture_frame = 0;  // capture frame index of the first sample in the file

    bool has_gaps = false;
    bool gap_positions_complete = true;
    std::vector<TakeGap> gaps;
    std::uint64_t timing_anomalies = 0;

    double duration_seconds() const noexcept {
        return sample_rate ? static_cast<double>(frames) / sample_rate : 0.0;
    }
};

std::string to_json(const TakeMetadata& meta);

}  // namespace rr::audio
