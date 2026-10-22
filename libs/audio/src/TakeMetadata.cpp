#include "rr/audio/TakeMetadata.h"

#include <cstdio>

#include "rr/shared/JsonEscape.h"

namespace
{

class JsonObject
{
public:
    explicit JsonObject(std::string& out, int indent) : out(out), indent(indent) { this->out += "{\n"; }

    void str(const char* key, const std::string& value)
    {
        begin(key);
        out += '"';
        appendJsonEscaped(out, value);
        out += '"';
    }
    void num(const char* key, uint64_t value)
    {
        begin(key);
        out += std::to_string(value);
    }
    void inum(const char* key, int64_t value)
    {
        begin(key);
        out += std::to_string(value);
    }
    void real(const char* key, double value)
    {
        begin(key);
        char text[32];
        std::snprintf(text, sizeof text, "%.6f", value);
        out += text;
    }
    void boolean(const char* key, bool value)
    {
        begin(key);
        out += value ? "true" : "false";
    }
    void raw(const char* key, const std::string& json)
    {
        begin(key);
        out += json;
    }
    void end()
    {
        out += '\n';
        out.append(static_cast<size_t>(indent - 2), ' ');
        out += '}';
    }

private:
    void begin(const char* key)
    {
        if (!first)
        {
            out += ",\n";
        }
        first = false;
        out.append(static_cast<size_t>(indent), ' ');
        out += '"';
        out += key;
        out += "\": ";
    }

    std::string& out;
    int indent;
    bool first = true;
};

}  // namespace

std::string toJson(const TakeMetadata& m)
{
    std::string out;
    JsonObject root(out, 2);
    root.str("schema", "rr.take.v1");
    root.num("take", m.takeNumber);
    root.str("role", std::string(roleId(m.role)));
    root.str("session_id", m.sessionId);
    root.str("app_version", m.appVersion);
    root.str("status", std::string(takeStatusName(m.status)));
    root.boolean("finalised", m.finalised);
    root.str("stop_reason", m.stopReason);
    root.str("error", m.error);
    root.str("file", m.fileName);
    root.str("partial_file", m.partialFileName);

    root.str("sample_format", "float32 (IEEE 754), little-endian, interleaved");
    root.num("wav_format_tag", m.wavFormatTag);
    root.num("sample_rate", m.sampleRate);
    root.num("channels", m.channels);
    root.num("frames", m.frames);
    root.real("duration_s", m.durationSeconds());

    std::string capture;
    {
        JsonObject c(capture, 4);
        c.str("source_kind", m.capture.sourceKind);
        c.str("backend", m.capture.backend);
        c.str("device_name", m.capture.deviceName);
        c.str("device_internal_format", m.capture.deviceInternalFormat);
        c.num("device_internal_rate", m.capture.deviceInternalRate);
        c.num("device_internal_channels", m.capture.deviceInternalChannels);
        c.num("device_period_frames", m.capture.devicePeriodFrames);
        c.num("device_periods", m.capture.devicePeriods);
        std::string notes = "[";
        for (size_t i = 0; i < m.capture.conversionNotes.size(); ++i)
        {
            notes += i ? ", \"" : "\"";
            appendJsonEscaped(notes, m.capture.conversionNotes[i]);
            notes += '"';
        }
        notes += ']';
        c.raw("conversion_notes", notes);
        c.end();
    }
    root.raw("capture", capture);

    root.str("started_utc", m.startedUtc);
    root.str("stopped_utc", m.stoppedUtc);
    root.inum("start_monotonic_ns", m.startMonoNs);
    root.num("first_capture_frame", m.firstCaptureFrame);
    root.inum("scheduled_start_monotonic_ns", m.scheduledStartNs);
    root.inum("first_sample_monotonic_ns_estimate", m.firstSampleNsEst);
    root.num("late_start_frames", m.lateStartFrames);
    root.inum("scheduled_stop_monotonic_ns", m.scheduledStopNs);

    root.boolean("has_gaps", m.hasGaps);
    root.boolean("gap_positions_complete", m.gapPositionsComplete);
    std::string gaps = "[";
    for (size_t i = 0; i < m.gaps.size(); ++i)
    {
        gaps += i ? ", " : "";
        gaps += "{\"file_frame\": " + std::to_string(m.gaps[i].fileFrame) +
                ", \"frames\": " + std::to_string(m.gaps[i].frames) + ", \"filled_with\": \"silence\"}";
    }
    gaps += ']';
    root.raw("gaps", gaps);
    root.num("callback_timing_anomalies", m.timingAnomalies);
    root.end();
    out += '\n';
    return out;
}

