#include "rr/audio/take_metadata.hpp"

#include <cstdio>

#include "rr/shared/json_escape.hpp"

namespace rr::audio {
namespace {

class JsonObject {
public:
    explicit JsonObject(std::string& out, int indent) : out_(out), indent_(indent) { out_ += "{\n"; }

    void str(const char* key, const std::string& value) {
        begin(key);
        out_ += '"';
        append_json_escaped(out_, value);
        out_ += '"';
    }
    void num(const char* key, std::uint64_t value) {
        begin(key);
        out_ += std::to_string(value);
    }
    void inum(const char* key, std::int64_t value) {
        begin(key);
        out_ += std::to_string(value);
    }
    void real(const char* key, double value) {
        begin(key);
        char text[32];
        std::snprintf(text, sizeof text, "%.6f", value);
        out_ += text;
    }
    void boolean(const char* key, bool value) {
        begin(key);
        out_ += value ? "true" : "false";
    }
    void raw(const char* key, const std::string& json) {
        begin(key);
        out_ += json;
    }
    void end() {
        out_ += '\n';
        out_.append(static_cast<std::size_t>(indent_ - 2), ' ');
        out_ += '}';
    }

private:
    void begin(const char* key) {
        if (!first_) {
            out_ += ",\n";
        }
        first_ = false;
        out_.append(static_cast<std::size_t>(indent_), ' ');
        out_ += '"';
        out_ += key;
        out_ += "\": ";
    }

    std::string& out_;
    int indent_;
    bool first_ = true;
};

}  // namespace

std::string to_json(const TakeMetadata& m) {
    std::string out;
    JsonObject root(out, 2);
    root.str("schema", "rr.take.v1");
    root.num("take", m.take_number);
    root.str("role", std::string(role_id(m.role)));
    root.str("session_id", m.session_id);
    root.str("app_version", m.app_version);
    root.str("status", std::string(take_status_name(m.status)));
    root.boolean("finalised", m.finalised);
    root.str("stop_reason", m.stop_reason);
    root.str("error", m.error);
    root.str("file", m.file_name);
    root.str("partial_file", m.partial_file_name);

    root.str("sample_format", "float32 (IEEE 754), little-endian, interleaved");
    root.num("wav_format_tag", m.wav_format_tag);
    root.num("sample_rate", m.sample_rate);
    root.num("channels", m.channels);
    root.num("frames", m.frames);
    root.real("duration_s", m.duration_seconds());

    std::string capture;
    {
        JsonObject c(capture, 4);
        c.str("source_kind", m.capture.source_kind);
        c.str("backend", m.capture.backend);
        c.str("device_name", m.capture.device_name);
        c.str("device_internal_format", m.capture.device_internal_format);
        c.num("device_internal_rate", m.capture.device_internal_rate);
        c.num("device_internal_channels", m.capture.device_internal_channels);
        c.num("device_period_frames", m.capture.device_period_frames);
        c.num("device_periods", m.capture.device_periods);
        std::string notes = "[";
        for (std::size_t i = 0; i < m.capture.conversion_notes.size(); ++i) {
            notes += i ? ", \"" : "\"";
            append_json_escaped(notes, m.capture.conversion_notes[i]);
            notes += '"';
        }
        notes += ']';
        c.raw("conversion_notes", notes);
        c.end();
    }
    root.raw("capture", capture);

    root.str("started_utc", m.started_utc);
    root.str("stopped_utc", m.stopped_utc);
    root.inum("start_monotonic_ns", m.start_mono_ns);
    root.num("first_capture_frame", m.first_capture_frame);
    root.inum("scheduled_start_monotonic_ns", m.scheduled_start_ns);
    root.inum("first_sample_monotonic_ns_estimate", m.first_sample_ns_est);
    root.num("late_start_frames", m.late_start_frames);
    root.inum("scheduled_stop_monotonic_ns", m.scheduled_stop_ns);

    root.boolean("has_gaps", m.has_gaps);
    root.boolean("gap_positions_complete", m.gap_positions_complete);
    std::string gaps = "[";
    for (std::size_t i = 0; i < m.gaps.size(); ++i) {
        gaps += i ? ", " : "";
        gaps += "{\"file_frame\": " + std::to_string(m.gaps[i].file_frame) +
                ", \"frames\": " + std::to_string(m.gaps[i].frames) + ", \"filled_with\": \"silence\"}";
    }
    gaps += ']';
    root.raw("gaps", gaps);
    root.num("callback_timing_anomalies", m.timing_anomalies);
    root.end();
    out += '\n';
    return out;
}

}  // namespace rr::audio
