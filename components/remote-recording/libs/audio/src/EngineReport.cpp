#include <cstdio>
#include <sstream>
#include <string>
#include <vector>

#include "rr/audio/AudioEngine.h"
#include "rr/shared/JsonEscape.h"

namespace
{

std::string q(const std::string& s)
{
    return "\"" + jsonEscape(s) + "\"";
}

std::string list(const std::vector<std::string>& items)
{
    std::string out = "[";
    for (size_t i = 0; i < items.size(); ++i)
    {
        out += (i ? ", " : "") + q(items[i]);
    }
    return out + "]";
}

std::string ms(uint64_t frames, uint32_t rate)
{
    char text[32];
    std::snprintf(text, sizeof text, "%.1f", rate ? static_cast<double>(frames) * 1000.0 / rate : 0.0);
    return text;
}

const char* faultName(DeviceFault f)
{
    switch (f)
    {
    case DeviceFault::None: return "none";
    case DeviceFault::StoppedUnexpectedly: return "stopped_unexpectedly";
    case DeviceFault::Rerouted: return "rerouted";
    }
    return "unknown";
}

}  // namespace

std::string engineReportJson(const AudioEngine& engine)
{
    std::ostringstream o;
    o << "{\n  \"backend\": " << q(engine.backendName()) << ",\n";

    // ---- capture / master path ----
    o << "  \"capture\": {\n    \"open\": " << (engine.captureOpen() ? "true" : "false")
      << ",\n    \"fault\": " << q(faultName(engine.captureFault()));
    if (const CaptureIngest* ingest = engine.ingest())
    {
        const CaptureDescription& d = engine.captureDescription();
        const IngestStats s = ingest->stats();
        o << ",\n    \"device\": " << q(d.deviceName) << ",\n    \"sample_rate\": " << d.sampleRate
          << ",\n    \"channels\": " << d.channels << ",\n    \"device_internal\": "
          << q(d.deviceInternalFormat + ", " + std::to_string(d.deviceInternalRate) + " Hz, " +
               std::to_string(d.deviceInternalChannels) + " ch, period " + std::to_string(d.devicePeriodFrames) +
               " x " + std::to_string(d.devicePeriods))
          << ",\n    \"master_processing\": " << list(d.conversionNotes)
          << ",\n    \"callbacks\": " << s.callbacks << ",\n    \"frames_captured\": " << s.framesCaptured
          << ",\n    \"record_ring_capacity_ms\": " << ms(s.ringCapacityFrames, d.sampleRate)
          << ",\n    \"record_ring_fill_ms\": " << ms(s.ringFillFrames, d.sampleRate)
          << ",\n    \"record_ring_max_fill_ms\": " << ms(s.ringMaxFillFrames, d.sampleRate)
          << ",\n    \"record_ring_overrun_events\": " << s.overrunEvents
          << ",\n    \"record_ring_overrun_frames\": " << s.overrunFrames
          << ",\n    \"gap_events_lost\": " << s.gapEventsLost
          << ",\n    \"callback_timing_anomalies\": " << s.timingAnomalies
          << ",\n    \"clipped_samples\": " << s.clippedSamples
          << ",\n    \"max_callback_us\": " << (s.maxCallbackNs / 1000);
    }
    o << "\n  },\n";

    // ---- playback / monitor path ----
    const MonitorBus& bus = engine.monitor();
    const MonitorStats m = bus.stats();
    o << "  \"playback\": {\n    \"open\": " << (engine.playbackOpen() ? "true" : "false")
      << ",\n    \"fault\": " << q(faultName(engine.playbackFault()));
    if (engine.playbackOpen())
    {
        const PlaybackDescription& p = engine.playbackDescription();
        o << ",\n    \"device\": " << q(p.deviceName) << ",\n    \"sample_rate\": " << p.sampleRate
          << ",\n    \"channels\": " << p.channels << ",\n    \"device_internal\": "
          << q(p.deviceInternalFormat + ", " + std::to_string(p.deviceInternalRate) + " Hz, " +
               std::to_string(p.deviceInternalChannels) + " ch, period " + std::to_string(p.devicePeriodFrames) +
               " x " + std::to_string(p.devicePeriods))
          << ",\n    \"monitor_processing\": " << list(p.notes);
    }
    char gain[16];
    std::snprintf(gain, sizeof gain, "%.1f", static_cast<double>(bus.getGainDb()));
    o << ",\n    \"monitoring_enabled\": " << (bus.isEnabled() ? "true" : "false") << ",\n    \"monitor_gain_db\": " << gain
      << ",\n    \"monitor_rate\": " << bus.getSampleRate()
      << ",\n    \"monitor_target_ms\": " << ms(m.targetFrames, bus.getSampleRate())
      << ",\n    \"monitor_capacity_ms\": " << ms(m.capacityFrames, bus.getSampleRate())
      << ",\n    \"monitor_fill_ms\": " << ms(m.fillFrames, bus.getSampleRate())
      << ",\n    \"monitor_max_fill_ms\": " << ms(m.maxFillFrames, bus.getSampleRate())
      << ",\n    \"render_callbacks\": " << m.renderCallbacks << ",\n    \"frames_played\": " << m.playedFrames
      << ",\n    \"monitor_frames_pushed\": " << m.pushedFrames
      << ",\n    \"monitor_overflow_events\": " << m.overflowEvents
      << ",\n    \"monitor_overflow_frames\": " << m.overflowFrames
      << ",\n    \"monitor_underrun_events\": " << m.underrunEvents
      << ",\n    \"monitor_underrun_frames\": " << m.underrunFrames
      << ",\n    \"monitor_prefill_events\": " << m.prefillEvents
      << ",\n    \"monitor_start_trim_frames\": " << m.startTrimFrames
      << ",\n    \"monitor_drift_trim_events\": " << m.driftTrimEvents
      << ",\n    \"monitor_drift_trim_frames\": " << m.driftTrimFrames
      << ",\n    \"max_render_us\": " << (m.maxRenderNs / 1000) << "\n  },\n";

    const DeviceEventCounts e = engine.deviceEvents();
    o << "  \"device_events\": {\"capture_opens\": " << e.captureOpens << ", \"capture_faults\": " << e.captureFaults
      << ", \"playback_opens\": " << e.playbackOpens << ", \"playback_faults\": " << e.playbackFaults << "}\n}";
    return o.str();
}

