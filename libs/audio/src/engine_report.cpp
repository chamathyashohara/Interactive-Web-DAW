#include <cstdio>
#include <sstream>
#include <string>
#include <vector>

#include "rr/audio/audio_engine.hpp"
#include "rr/shared/json_escape.hpp"

namespace rr::audio {
namespace {

std::string q(const std::string& s) {
    return "\"" + json_escape(s) + "\"";
}

std::string list(const std::vector<std::string>& items) {
    std::string out = "[";
    for (std::size_t i = 0; i < items.size(); ++i) {
        out += (i ? ", " : "") + q(items[i]);
    }
    return out + "]";
}

std::string ms(std::uint64_t frames, std::uint32_t rate) {
    char text[32];
    std::snprintf(text, sizeof text, "%.1f", rate ? static_cast<double>(frames) * 1000.0 / rate : 0.0);
    return text;
}

const char* fault_name(DeviceFault f) {
    switch (f) {
    case DeviceFault::None: return "none";
    case DeviceFault::StoppedUnexpectedly: return "stopped_unexpectedly";
    case DeviceFault::Rerouted: return "rerouted";
    }
    return "unknown";
}

}  // namespace

std::string engine_report_json(const AudioEngine& engine) {
    std::ostringstream o;
    o << "{\n  \"backend\": " << q(engine.backend_name()) << ",\n";

    // ---- capture / master path ----
    o << "  \"capture\": {\n    \"open\": " << (engine.capture_open() ? "true" : "false")
      << ",\n    \"fault\": " << q(fault_name(engine.capture_fault()));
    if (const CaptureIngest* ingest = engine.ingest()) {
        const CaptureDescription& d = engine.capture_description();
        const IngestStats s = ingest->stats();
        o << ",\n    \"device\": " << q(d.device_name) << ",\n    \"sample_rate\": " << d.sample_rate
          << ",\n    \"channels\": " << d.channels << ",\n    \"device_internal\": "
          << q(d.device_internal_format + ", " + std::to_string(d.device_internal_rate) + " Hz, " +
               std::to_string(d.device_internal_channels) + " ch, period " + std::to_string(d.device_period_frames) +
               " x " + std::to_string(d.device_periods))
          << ",\n    \"master_processing\": " << list(d.conversion_notes)
          << ",\n    \"callbacks\": " << s.callbacks << ",\n    \"frames_captured\": " << s.frames_captured
          << ",\n    \"record_ring_capacity_ms\": " << ms(s.ring_capacity_frames, d.sample_rate)
          << ",\n    \"record_ring_fill_ms\": " << ms(s.ring_fill_frames, d.sample_rate)
          << ",\n    \"record_ring_max_fill_ms\": " << ms(s.ring_max_fill_frames, d.sample_rate)
          << ",\n    \"record_ring_overrun_events\": " << s.overrun_events
          << ",\n    \"record_ring_overrun_frames\": " << s.overrun_frames
          << ",\n    \"gap_events_lost\": " << s.gap_events_lost
          << ",\n    \"callback_timing_anomalies\": " << s.timing_anomalies
          << ",\n    \"clipped_samples\": " << s.clipped_samples
          << ",\n    \"max_callback_us\": " << (s.max_callback_ns / 1000);
    }
    o << "\n  },\n";

    // ---- playback / monitor path ----
    const MonitorBus& bus = engine.monitor();
    const MonitorStats m = bus.stats();
    o << "  \"playback\": {\n    \"open\": " << (engine.playback_open() ? "true" : "false")
      << ",\n    \"fault\": " << q(fault_name(engine.playback_fault()));
    if (engine.playback_open()) {
        const PlaybackDescription& p = engine.playback_description();
        o << ",\n    \"device\": " << q(p.device_name) << ",\n    \"sample_rate\": " << p.sample_rate
          << ",\n    \"channels\": " << p.channels << ",\n    \"device_internal\": "
          << q(p.device_internal_format + ", " + std::to_string(p.device_internal_rate) + " Hz, " +
               std::to_string(p.device_internal_channels) + " ch, period " + std::to_string(p.device_period_frames) +
               " x " + std::to_string(p.device_periods))
          << ",\n    \"monitor_processing\": " << list(p.notes);
    }
    char gain[16];
    std::snprintf(gain, sizeof gain, "%.1f", static_cast<double>(bus.gain_db()));
    o << ",\n    \"monitoring_enabled\": " << (bus.enabled() ? "true" : "false") << ",\n    \"monitor_gain_db\": " << gain
      << ",\n    \"monitor_rate\": " << bus.sample_rate()
      << ",\n    \"monitor_target_ms\": " << ms(m.target_frames, bus.sample_rate())
      << ",\n    \"monitor_capacity_ms\": " << ms(m.capacity_frames, bus.sample_rate())
      << ",\n    \"monitor_fill_ms\": " << ms(m.fill_frames, bus.sample_rate())
      << ",\n    \"monitor_max_fill_ms\": " << ms(m.max_fill_frames, bus.sample_rate())
      << ",\n    \"render_callbacks\": " << m.render_callbacks << ",\n    \"frames_played\": " << m.played_frames
      << ",\n    \"monitor_frames_pushed\": " << m.pushed_frames
      << ",\n    \"monitor_overflow_events\": " << m.overflow_events
      << ",\n    \"monitor_overflow_frames\": " << m.overflow_frames
      << ",\n    \"monitor_underrun_events\": " << m.underrun_events
      << ",\n    \"monitor_underrun_frames\": " << m.underrun_frames
      << ",\n    \"monitor_prefill_events\": " << m.prefill_events
      << ",\n    \"monitor_start_trim_frames\": " << m.start_trim_frames
      << ",\n    \"monitor_drift_trim_events\": " << m.drift_trim_events
      << ",\n    \"monitor_drift_trim_frames\": " << m.drift_trim_frames
      << ",\n    \"max_render_us\": " << (m.max_render_ns / 1000) << "\n  },\n";

    const DeviceEventCounts e = engine.device_events();
    o << "  \"device_events\": {\"capture_opens\": " << e.capture_opens << ", \"capture_faults\": " << e.capture_faults
      << ", \"playback_opens\": " << e.playback_opens << ", \"playback_faults\": " << e.playback_faults << "}\n}";
    return o.str();
}

}  // namespace rr::audio
