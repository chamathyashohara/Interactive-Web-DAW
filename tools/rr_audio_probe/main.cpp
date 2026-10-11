// rr_audio_probe: command-line check of the real capture and local-recording path, without
// the GUI. Uses exactly the same library code as the two apps (rr_audio).
//
//   rr_audio_probe --list
//   rr_audio_probe --record <seconds> --out <folder> [--device <index>] [--any-rate] [--role producer|performer]
//   rr_audio_probe --monitor <seconds> [--device <in>] [--output <out>] [--gain-db <g>] [--any-rate]
//                  [--reopen-input-at <second>]   (re-opens the input while the output runs)
//   rr_audio_probe --tone <seconds> [--output <out>] [--level-dbfs <l>]   (plays a test tone)
//   rr_audio_probe --inspect <file.wav | file.wav.partial>
//   rr_audio_probe --recover <file.wav.partial>
//
// Exit code 0 = success, 1 = failure (message on stderr), 2 = usage error.

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#include "rr/audio/audio_engine.hpp"
#include "rr/audio/file_io.hpp"
#include "rr/audio/take_naming.hpp"
#include "rr/audio/wav_inspect.hpp"
#include "rr/shared/build_info.hpp"
#include "rr/shared/clock.hpp"

using namespace rr::audio;

namespace {

int usage() {
    std::fprintf(stderr,
                 "usage:\n"
                 "  rr_audio_probe --list\n"
                 "  rr_audio_probe --record <seconds> --out <folder> [--device <index>] [--any-rate]"
                 " [--role producer|performer]\n"
                 "  rr_audio_probe --monitor <seconds> [--device <in>] [--output <out>] [--gain-db <g>] [--any-rate]\n"
                 "  rr_audio_probe --tone <seconds> [--output <out>] [--level-dbfs <l>]\n"
                 "  rr_audio_probe --inspect <file>\n"
                 "  rr_audio_probe --recover <file.wav.partial>\n");
    return 2;
}

double to_dbfs(float peak) {
    return peak > 1e-6f ? 20.0 * std::log10(static_cast<double>(peak)) : -120.0;
}

void print_info(const std::filesystem::path& path, const WavInfo& info) {
    std::printf("file: %s\n", path_to_utf8(path).c_str());
    std::printf("  valid finished float32 WAV: %s\n", info.is_complete_float_wav() ? "YES" : "NO");
    std::printf("  format tag %u, %u ch, %u Hz, %u bits, block %u\n", info.format_tag, info.channels,
                info.sample_rate, info.bits_per_sample, info.block_align);
    std::printf("  file %llu bytes, data offset %llu, data in header %llu, data present %llu\n",
                static_cast<unsigned long long>(info.file_bytes), static_cast<unsigned long long>(info.data_offset),
                static_cast<unsigned long long>(info.data_bytes_in_header),
                static_cast<unsigned long long>(info.data_bytes_in_file));
    std::printf("  frames %llu (fact %llu), duration %.3f s\n", static_cast<unsigned long long>(info.frames),
                static_cast<unsigned long long>(info.fact_frames),
                info.sample_rate ? static_cast<double>(info.frames) / info.sample_rate : 0.0);
    for (const auto& p : info.problems) {
        std::printf("  problem: %s\n", p.c_str());
    }
}

int list_devices() {
    AudioEngine engine;
    std::string error;
    if (!engine.initialise(error)) {
        std::fprintf(stderr, "%s\n", error.c_str());
        return 1;
    }
    std::printf("backend: %s\n\nINPUT devices:\n", engine.backend_name().c_str());
    for (const auto& d : engine.capture_devices(error)) {
        std::printf("  %2zu  %s%s\n", d.index, d.name.c_str(), d.is_default ? "   [default]" : "");
    }
    std::printf("\nOUTPUT devices:\n");
    for (const auto& d : engine.playback_devices(error)) {
        std::printf("  %2zu  %s%s\n", d.index, d.name.c_str(), d.is_default ? "   [default]" : "");
    }
    return error.empty() ? 0 : 1;
}

int record(double seconds, const std::filesystem::path& out_root, long device_index, bool any_rate, rr::Role role) {
    AudioEngine engine;
    std::string error;
    if (!engine.initialise(error)) {
        std::fprintf(stderr, "%s\n", error.c_str());
        return 1;
    }
    const auto devices = engine.capture_devices(error);
    if (devices.empty()) {
        std::fprintf(stderr, "no input devices found %s\n", error.c_str());
        return 1;
    }
    std::size_t index = 0;
    if (device_index >= 0) {
        index = static_cast<std::size_t>(device_index);
    } else {
        for (const auto& d : devices) {
            if (d.is_default) {
                index = d.index;
            }
        }
    }
    if (index >= devices.size()) {
        std::fprintf(stderr, "no input device %zu\n", index);
        return 1;
    }

    CaptureOptions options;
    options.required_sample_rate = any_rate ? 0 : 48000;
    if (!engine.open_capture(index, options, RecorderOptions{}, error)) {
        std::fprintf(stderr, "open failed: %s\n", error.c_str());
        return 1;
    }
    const CaptureDescription& desc = engine.capture_description();
    std::printf("device: [%zu] %s via %s\n", index, desc.device_name.c_str(), desc.backend.c_str());
    std::printf("format written: float32, %u ch, %u Hz\n", desc.channels, desc.sample_rate);
    std::printf("device internal: %s, %u ch, %u Hz, period %u frames x %u\n", desc.device_internal_format.c_str(),
                desc.device_internal_channels, desc.device_internal_rate, desc.device_period_frames,
                desc.device_periods);
    for (const auto& note : desc.conversion_notes) {
        std::printf("note: %s\n", note.c_str());
    }

    const std::string session_id = make_session_id();
    const std::filesystem::path session_dir =
        out_root / session_folder_name(rr::time::utc_now_ms(), session_id);
    std::error_code ec;
    std::filesystem::create_directories(session_dir, ec);
    if (ec) {
        std::fprintf(stderr, "cannot create %s: %s\n", path_to_utf8(session_dir).c_str(), ec.message().c_str());
        return 1;
    }

    TakeRequest request;
    request.session_dir = session_dir;
    request.take_number = next_free_take_number(session_dir, role, session_id);
    request.role = role;
    request.session_id = session_id;
    request.app_version = rr::build_info().version + " (rr_audio_probe)";
    request.max_take_seconds = 1800;
    request.capture = desc;
    if (!engine.recorder()->begin_take(request, error)) {
        std::fprintf(stderr, "begin take failed: %s\n", error.c_str());
        return 1;
    }

    const auto start = std::chrono::steady_clock::now();
    double next_report = 1.0;
    std::vector<float> peaks(desc.channels, 0.0f);
    while (true) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        for (std::uint32_t c = 0; c < desc.channels; ++c) {
            const float p = engine.ingest()->take_levels(c).peak;
            if (p > peaks[c]) {
                peaks[c] = p;
            }
        }
        const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
        if (elapsed >= next_report) {
            const RecorderStatus st = engine.recorder()->status();
            std::printf("t=%4.1fs state=%s frames=%llu peak dBFS:", elapsed, recorder_state_name(st.state),
                        static_cast<unsigned long long>(st.frames_written));
            for (std::uint32_t c = 0; c < desc.channels; ++c) {
                std::printf(" ch%u %.1f", c + 1, to_dbfs(peaks[c]));
                peaks[c] = 0.0f;
            }
            std::printf("\n");
            next_report += 1.0;
        }
        if (elapsed >= seconds) {
            break;
        }
    }
    engine.recorder()->end_take(StopReason::User);
    std::vector<TakeMetadata> results;
    for (int i = 0; i < 300 && results.empty(); ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        results = engine.recorder()->take_finished();
    }
    const IngestStats stats = engine.ingest()->stats();
    engine.close_capture();
    if (results.empty()) {
        std::fprintf(stderr, "take did not finish within 3 s\n");
        return 1;
    }
    const TakeMetadata& m = results.front();
    std::printf("\nresult: status=%s finalised=%s stop=%s frames=%llu duration=%.3fs has_gaps=%s\n",
                std::string(rr::take_status_name(m.status)).c_str(), m.finalised ? "yes" : "NO",
                m.stop_reason.c_str(), static_cast<unsigned long long>(m.frames), m.duration_seconds(),
                m.has_gaps ? "YES" : "no");
    if (!m.error.empty()) {
        std::printf("error: %s\n", m.error.c_str());
    }
    std::printf("capture stats: callbacks=%llu frames=%llu overruns=%llu (frames %llu) timing_anomalies=%llu "
                "clipped=%llu max_callback_us=%.1f\n",
                static_cast<unsigned long long>(stats.callbacks), static_cast<unsigned long long>(stats.frames_captured),
                static_cast<unsigned long long>(stats.overrun_events), static_cast<unsigned long long>(stats.overrun_frames),
                static_cast<unsigned long long>(stats.timing_anomalies), static_cast<unsigned long long>(stats.clipped_samples),
                static_cast<double>(stats.max_callback_ns) / 1000.0);
    std::printf("metadata: %s\n", path_to_utf8(session_dir / m.metadata_file_name).c_str());
    const std::filesystem::path wav = session_dir / (m.finalised ? m.file_name : m.partial_file_name);
    const WavInfo info = inspect_wav(wav);
    print_info(wav, info);
    const bool frames_match = info.frames == m.frames;
    std::printf("frames in file == metadata: %s\n", frames_match ? "yes" : "NO");
    return (m.status == rr::TakeStatus::Complete && info.is_complete_float_wav() && frames_match) ? 0 : 1;
}

std::size_t default_index(const std::vector<DeviceInfo>& devices) {
    for (const auto& d : devices) {
        if (d.is_default) {
            return d.index;
        }
    }
    return 0;
}

// Capture -> monitor bus -> output for `seconds`, or (tone_only) just a test tone. Prints one
// line of buffer/level counters per second and the engine report at the end.
int monitor(double seconds, long input, long output, float gain_db, bool any_rate, bool tone_only, float tone_dbfs,
            int reopen_input_at) {
    AudioEngine engine;
    std::string error;
    if (!engine.initialise(error)) {
        std::fprintf(stderr, "%s\n", error.c_str());
        return 1;
    }
    const auto inputs = engine.capture_devices(error);
    const auto outputs = engine.playback_devices(error);
    if (outputs.empty() || (!tone_only && inputs.empty())) {
        std::fprintf(stderr, "missing devices %s\n", error.c_str());
        return 1;
    }
    const std::size_t in_index = input >= 0 ? static_cast<std::size_t>(input) : default_index(inputs);
    const std::size_t out_index = output >= 0 ? static_cast<std::size_t>(output) : default_index(outputs);
    if (!tone_only) {
        CaptureOptions options;
        options.required_sample_rate = any_rate ? 0 : 48000;
        if (!engine.open_capture(in_index, options, RecorderOptions{}, error)) {
            std::fprintf(stderr, "input: %s\n", error.c_str());
            return 1;
        }
    }
    if (!engine.open_playback(out_index, PlaybackOptions{}, error)) {
        std::fprintf(stderr, "output: %s\n", error.c_str());
        return 1;
    }
    const PlaybackDescription& pd = engine.playback_description();
    std::printf("input:  %s\noutput: %s (renders %u Hz, %u ch; device stream %s, %u Hz, %u ch)\n",
                tone_only ? "(none: tone only)" : engine.capture_description().device_name.c_str(),
                pd.device_name.c_str(), pd.sample_rate, pd.channels, pd.device_internal_format.c_str(),
                pd.device_internal_rate, pd.device_internal_channels);
    for (const auto& n : pd.notes) {
        std::printf("monitor note: %s\n", n.c_str());
    }
    engine.monitor().set_gain_db(gain_db);
    if (tone_only) {
        engine.monitor().start_test_tone(440.0f, tone_dbfs, static_cast<float>(seconds));
    } else {
        engine.monitor().set_enabled(true);
    }
    const auto start = std::chrono::steady_clock::now();
    const int whole_seconds = static_cast<int>(std::ceil(seconds));
    for (int second = 1; second <= whole_seconds; ++second) {
        std::this_thread::sleep_until(start + std::chrono::seconds(second));
        if (second == reopen_input_at && !tone_only) {
            CaptureOptions options;
            options.required_sample_rate = any_rate ? 0 : 48000;
            const bool ok = engine.open_capture(in_index, options, RecorderOptions{}, error);
            std::printf("t=%2ds RE-OPENED INPUT while output running: %s %s (output open: %s)\n", second,
                        ok ? "ok" : "FAILED", error.c_str(), engine.playback_open() ? "yes" : "NO");
            error.clear();
        }
        const MonitorStats m = engine.monitor().stats();
        const double rate = engine.monitor().sample_rate();
        std::printf("t=%2ds monitor fill %.1f ms (max %.1f) underruns %llu overflows %llu trims %llu played %llu",
                    second, 1000.0 * m.fill_frames / rate, 1000.0 * m.max_fill_frames / rate,
                    static_cast<unsigned long long>(m.underrun_events), static_cast<unsigned long long>(m.overflow_events),
                    static_cast<unsigned long long>(m.drift_trim_events), static_cast<unsigned long long>(m.played_frames));
        if (CaptureIngest* ingest = engine.ingest()) {
            const ChannelLevels l = ingest->take_levels(0);
            std::printf(" | in ch1 peak %.1f rms %.1f dBFS clip %llu", to_dbfs(l.peak), to_dbfs(l.rms),
                        static_cast<unsigned long long>(l.clipped));
        }
        std::printf("\n");
    }
    std::printf("\nengine report:\n%s\n", engine_report_json(engine).c_str());
    engine.monitor().set_enabled(false);
    const MonitorStats final_stats = engine.monitor().stats();
    const bool faults = engine.playback_fault() != DeviceFault::None || engine.capture_fault() != DeviceFault::None;
    engine.close_playback();
    engine.close_capture();
    return (!faults && final_stats.render_callbacks > 0) ? 0 : 1;
}

}  // namespace

int main(int argc, char* argv[]) {
    if (argc < 2) {
        return usage();
    }
    const std::string cmd = argv[1];
    if (cmd == "--list") {
        return list_devices();
    }
    if (cmd == "--inspect" && argc == 3) {
        const WavInfo info = inspect_wav(argv[2]);
        print_info(argv[2], info);
        return info.is_complete_float_wav() ? 0 : 1;
    }
    if (cmd == "--recover" && argc == 3) {
        const RecoveryResult r = recover_partial(argv[2]);
        if (!r.ok) {
            std::fprintf(stderr, "recovery failed: %s\n", r.error.c_str());
            return 1;
        }
        std::printf("recovered %llu frames into %s (dropped %llu trailing bytes); original kept\n",
                    static_cast<unsigned long long>(r.frames), path_to_utf8(r.recovered_path).c_str(),
                    static_cast<unsigned long long>(r.trailing_bytes_dropped));
        return 0;
    }
    if (cmd == "--monitor" || cmd == "--tone") {
        double seconds = 0;
        long input = -1;
        long output = -1;
        float gain_db = 0.0f;
        float level_dbfs = -20.0f;
        bool any_rate = false;
        int reopen_at = -1;
        for (int i = 1; i < argc; ++i) {
            const std::string a = argv[i];
            if (a == "--reopen-input-at" && i + 1 < argc) {
                reopen_at = std::atoi(argv[++i]);
            } else if ((a == "--monitor" || a == "--tone") && i + 1 < argc) {
                seconds = std::atof(argv[++i]);
            } else if (a == "--device" && i + 1 < argc) {
                input = std::atol(argv[++i]);
            } else if (a == "--output" && i + 1 < argc) {
                output = std::atol(argv[++i]);
            } else if (a == "--gain-db" && i + 1 < argc) {
                gain_db = static_cast<float>(std::atof(argv[++i]));
            } else if (a == "--level-dbfs" && i + 1 < argc) {
                level_dbfs = static_cast<float>(std::atof(argv[++i]));
            } else if (a == "--any-rate") {
                any_rate = true;
            } else {
                return usage();
            }
        }
        if (seconds <= 0) {
            return usage();
        }
        return monitor(seconds, input, output, gain_db, any_rate, cmd == "--tone", level_dbfs, reopen_at);
    }
    if (cmd == "--record") {
        double seconds = 0;
        std::filesystem::path out;
        long device = -1;
        bool any_rate = false;
        rr::Role role = rr::Role::Producer;
        for (int i = 1; i < argc; ++i) {
            const std::string a = argv[i];
            if (a == "--record" && i + 1 < argc) {
                seconds = std::atof(argv[++i]);
            } else if (a == "--out" && i + 1 < argc) {
                out = argv[++i];
            } else if (a == "--device" && i + 1 < argc) {
                device = std::atol(argv[++i]);
            } else if (a == "--any-rate") {
                any_rate = true;
            } else if (a == "--role" && i + 1 < argc) {
                role = std::strcmp(argv[++i], "performer") == 0 ? rr::Role::Performer : rr::Role::Producer;
            } else {
                return usage();
            }
        }
        if (seconds <= 0 || out.empty()) {
            return usage();
        }
        return record(seconds, out, device, any_rate, role);
    }
    return usage();
}
