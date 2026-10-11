// rr_session_probe: scriptable command-line producer or performer, using exactly the library
// code of the apps (rr_control). For two-instance tests on one PC and two-PC tests without Qt.
//
//   rr_session_probe --interfaces
//   rr_session_probe --producer  [--bind <ip>] [--port <n>] [--code-file <path>] [--audio] [--out <dir>]
//                                [--log <file.jsonl>] [--script "<commands>"]
//   rr_session_probe --performer --host <ip> [--port <n>] (--code <digits> | --code-file <path>) [--audio]
//                                [--out <dir>] [--log <file.jsonl>] [--script "<commands>"]
//
// Script: commands separated by ';'
//   wait-ready [s]        until the session state is Ready (default timeout 20 s)
//   wait <s>              keep polling for s seconds
//   wait-state <State> [s]
//   wait-link <State> [s]
//   record | stop | stop-and-save | drop-link | leave | quit
//   consent on|off
//   live on|off           producer: send the live stream; performer: play it (Stage 7)
//   live-stats            print the live counters now
// Default scripts: producer "wait-ready; record; wait 3; stop; wait-state Ready 10; wait 1; quit",
//                  performer "wait-ready 30; wait-closed".
// Without --audio the TEST RECORDER (no audio, nothing written) is used and labelled as such.
//
// Live audio (Stage 7, one way: producer -> performer; ADR-017), enabled with --live:
//   --media-port <n>          UDP media port on the producer (default: control port + 1)
//   --live-source tone|mic    producer: TEST TONE (440 Hz, -20 dBFS, labelled) or the open input
//                             (mic needs --audio); default: mic with --audio, else tone
//   --live-sink null|wav:<file>|device
//                             performer: a 10 ms TEST PLAYBACK CLOCK that discards (null) or
//                             saves (wav) what would be played, or the default output device
//   --live-gain-db <dB>       -60..0 (default -12)   --jitter-frames <n> 1..16 (default 3)
//   --frame-ms 2.5|5|10|20 (default 10)   --bitrate <bit/s> 16000..128000 (default 64000)
//   --application lowdelay|audio (default lowdelay)
//   test only: --sim-loss <pct> --sim-dup <pct> --sim-reorder <pct> --sim-burst <every>:<length>
//              --sim-seed <n>   (applied by the producer's sender before sendto)
// Exit code 0 = script completed, 1 = a step failed or timed out, 2 = usage error.

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <functional>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "rr/audio/audio_engine.hpp"
#include "rr/audio/wav_writer.hpp"
#include "rr/control/session_controller.hpp"
#include "rr/media/live_receiver.hpp"
#include "rr/media/live_sender.hpp"
#include "rr/network/socket.hpp"
#include "rr/shared/build_info.hpp"
#include "rr/shared/clock.hpp"
#include "rr/shared/log_sinks.hpp"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <timeapi.h>
#endif

using namespace rr;
using session::LinkState;
using session::SessionState;

namespace {

int usage() {
    std::fprintf(stderr,
                 "usage:\n  rr_session_probe --interfaces\n"
                 "  rr_session_probe --producer [--bind <ip>] [--port <n>] [--code-file <path>] [--audio] [--out <dir>] "
                 "[--log <file>] [--script \"...\"]\n"
                 "  rr_session_probe --performer --host <ip> [--port <n>] (--code <digits>|--code-file <path>) [--audio] "
                 "[--out <dir>] [--log <file>] [--script \"...\"]\n"
                 "  live audio (one way, producer -> performer): --live [--media-port <n>] [--live-source tone|mic]\n"
                 "    [--live-sink null|wav:<file>|device] [--live-gain-db <dB>] [--jitter-frames <n>] [--frame-ms <ms>]\n"
                 "    [--bitrate <bit/s>] [--application lowdelay|audio]\n"
                 "  test only: --test-protocol-major <n> announces a different protocol major version in HELLO\n"
                 "  test only: --sim-loss <pct> --sim-dup <pct> --sim-reorder <pct> --sim-burst <every>:<len> --sim-seed <n>\n");
    return 2;
}

std::vector<std::string> split(const std::string& s, char sep) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (c == sep) {
            out.push_back(cur);
            cur.clear();
        } else {
            cur += c;
        }
    }
    out.push_back(cur);
    return out;
}

std::string trim(std::string s) {
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) {
        s.erase(s.begin());
    }
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r' || s.back() == '\n')) {
        s.pop_back();
    }
    return s;
}

struct Probe {
    control::SessionController& c;
    std::size_t printed = 0;
    const char* who;
    std::function<void()> on_pump;

    void pump() {
        c.poll();
        if (on_pump) {
            on_pump();
        }
        const auto lines = c.take_history();
        for (std::size_t i = printed; i < lines.size(); ++i) {
            std::printf("[%s] %s\n", who, lines[i].c_str());
        }
        printed = lines.size();
        std::fflush(stdout);
    }

    bool run_for(double seconds) {
        const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(static_cast<long long>(seconds * 1000));
        while (std::chrono::steady_clock::now() < end) {
            pump();
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        return true;
    }

    template <typename Pred>
    bool until(Pred pred, double seconds) {
        const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(static_cast<long long>(seconds * 1000));
        while (std::chrono::steady_clock::now() < end) {
            pump();
            if (pred()) {
                return true;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        pump();
        return pred();
    }
};

void print_summary(const control::ControllerSnapshot& s, const char* who) {
    const auto& t = s.take;
    std::printf("\n[%s] SUMMARY\n", who);
    std::printf("  link %s, session %s, session id %s, peer '%s' at %s\n",
                std::string(session::link_state_name(s.link)).c_str(),
                std::string(session::session_state_name(s.session)).c_str(), s.session_id.c_str(), s.peer_name.c_str(),
                s.peer_address.c_str());
    std::printf("  recorder: %s\n", s.recorder_description.c_str());
    std::printf("  control RTT %.3f ms, clock offset (peer - local) %.3f ms +/- %.3f ms from %llu samples\n",
                static_cast<double>(s.link_stats.control_rtt_ns) / 1e6, static_cast<double>(s.link_stats.theta_ns) / 1e6,
                static_cast<double>(s.link_stats.theta_uncertainty_ns) / 1e6,
                static_cast<unsigned long long>(s.link_stats.offset_samples));
    std::printf("  frames sent %llu received %llu, stale dropped %llu, protocol errors %llu, reconnect attempts %llu\n",
                static_cast<unsigned long long>(s.link_stats.frames_sent),
                static_cast<unsigned long long>(s.link_stats.frames_received),
                static_cast<unsigned long long>(s.link_stats.stale_frames_dropped),
                static_cast<unsigned long long>(s.link_stats.protocol_errors),
                static_cast<unsigned long long>(s.link_stats.reconnect_attempts));
    std::printf("  invalid events %llu, refused messages %llu, duplicates %llu\n",
                static_cast<unsigned long long>(s.invalid_events), static_cast<unsigned long long>(s.refused_messages),
                static_cast<unsigned long long>(s.duplicate_messages));
    if (t.take_id != 0) {
        std::printf("  last take %u: local %s (%s, %llu frames%s)\n", t.take_id, t.local_started ? "started" : "NOT started",
                    t.local_finalised ? std::string(take_status_name(t.local_status)).c_str() : "not finalised",
                    static_cast<unsigned long long>(t.local_frames), t.local_file.empty() ? "" : (", " + t.local_file).c_str());
        if (s.role == Role::Producer) {
            std::printf("  performer confirmations: ARM_ACK %s, START_ACK %s, TAKE_STARTED %s, STOP_ACK %s, TAKE_FINALISED %s%s\n",
                        t.peer_arm_ack ? "yes" : "no", t.peer_start_ack ? "yes" : "no", t.peer_started ? "yes" : "no",
                        t.peer_stop_ack ? "yes" : "no",
                        t.peer_finalised ? std::string(take_status_name(t.peer_status)).c_str() : "no",
                        t.peer_report_timed_out ? " (timed out: UNKNOWN)" : "");
            if (t.has_start_offset) {
                std::printf("  estimated recording-start offset (performer - producer): %.3f ms +/- %.3f ms "
                            "(clock-offset uncertainty only; device input latency not included)\n",
                            t.start_offset_ms, t.start_offset_unc_ms);
            }
        }
    }
    if (!s.last_error.empty()) {
        std::printf("  last error: %s\n", s.last_error.c_str());
    }
}

constexpr double kPi = 3.14159265358979323846;

// Sleeps until `deadline`. On Windows, MinGW's std::this_thread::sleep_until stays at the 15.6 ms
// system tick even after timeBeginPeriod(1) (measured on the development PC: 10 ms deadlines
// arrived with p95 21 ms), so wait in Sleep(1) steps instead (about 1-2 ms each at 1 ms timer
// resolution).
void sleep_until_precise(std::chrono::steady_clock::time_point deadline) {
#ifdef _WIN32
    while (std::chrono::steady_clock::now() < deadline) {
        Sleep(1);
    }
#else
    std::this_thread::sleep_until(deadline);
#endif
}

// Calls `tick` every 10 ms on its own thread, on absolute deadlines (no cumulative drift).
// TEST CLOCK: stands in for a capture or playback callback when no device is used.
class TenMsClock {
public:
    explicit TenMsClock(std::function<void()> tick) : tick_(std::move(tick)) {
        thread_ = std::thread([this] {
            auto next = std::chrono::steady_clock::now();
            while (!stop_.load()) {
                next += std::chrono::milliseconds(10);
                sleep_until_precise(next);
                tick_();
            }
        });
    }
    ~TenMsClock() {
        stop_.store(true);
        thread_.join();
    }
    TenMsClock(const TenMsClock&) = delete;
    TenMsClock& operator=(const TenMsClock&) = delete;

private:
    std::function<void()> tick_;
    std::atomic<bool> stop_{false};
    std::thread thread_;
};

struct LiveOptions {
    bool enabled = false;
    std::uint16_t media_port = 0;
    std::string source = "auto";
    std::string sink = "null";
    media::LiveCodecSettings codec;
    media::LivePlayoutSettings playout;
    media::ImpairmentSettings sim;
};

unsigned long long u(std::uint64_t v) {
    return static_cast<unsigned long long>(v);
}

void print_live(const char* who, const media::LiveSender* sender, const media::LiveReceiver* receiver, bool full) {
    if (sender != nullptr && sender->running()) {
        const auto s = sender->stats();
        std::printf("[%s] live send: %s, peer %s, packets %llu (%llu B), encode errors %llu, send errors %llu, "
                    "tap gaps %llu fr, backlog trims %llu fr, sim dropped/dup/reorder %llu/%llu/%llu\n",
                    who, s.streaming ? "STREAMING" : (s.sending_enabled ? "waiting for performer" : "off"),
                    s.peer_known ? s.peer_endpoint.c_str() : "-", u(s.packets_sent), u(s.bytes_sent), u(s.encode_errors),
                    u(s.send_errors), u(s.tap_gap_frames), u(s.backlog_trim_frames), u(s.test_dropped),
                    u(s.test_duplicated), u(s.test_reordered));
        if (s.has_report) {
            const auto& r = s.last_report;
            std::printf("[%s]   performer reports (%.0f ms ago): received %llu, lost est %llu, late %u, dup %u, "
                        "reordered %u, jitter %.3f ms, buffer %u/%u, underruns %u, concealed %u, decode errors %u, "
                        "invalid %u\n",
                        who, s.last_report_age_ms, u(r.received), u(r.lost_estimate), r.late, r.duplicates, r.reordered,
                        r.jitter_us / 1000.0, r.jb_fill, r.jb_target, r.underruns, r.concealed, r.decode_errors,
                        r.invalid_packets);
        }
        if (full) {
            std::printf("[%s]   codec %s, %s, frame %u samples (%.1f ms), %d bit/s CBR, complexity %d, lookahead %d "
                        "samples (%.2f ms); streams %llu, reports %llu, peer timeouts %llu, invalid in %llu (src %llu, "
                        "crc %llu, session %llu), max encode %.3f ms, tap overflow events %llu\n",
                        who, s.opus_version.c_str(), s.application.c_str(), s.frame_samples,
                        media::frame_ms(s.frame_samples), s.bitrate_bps, s.complexity, s.lookahead_samples,
                        s.lookahead_samples / 48.0, u(s.streams_started), u(s.reports_received), u(s.peer_timeouts),
                        u(s.invalid.total()), u(s.invalid.src_rejected), u(s.invalid.bad_crc), u(s.invalid.bad_session),
                        static_cast<double>(s.max_encode_ns) / 1e6, u(s.tap.overflow_events));
        }
    }
    if (receiver != nullptr && receiver->running()) {
        const auto r = receiver->stats();
        std::printf("[%s] live receive: %s, received %llu, lost est %llu, dup %llu, reordered %llu, late %llu, "
                    "jitter %.3f ms, max gap %.1f ms, buffer %u/%u (max %u), underruns %llu, concealed %llu, "
                    "decode errors %llu, invalid %llu, output peak %.1f dBFS\n",
                    who, r.output_enabled ? (r.jb_playing ? "PLAYING" : "filling") : "output off", u(r.arrival.received),
                    u(r.arrival.lost_estimate), u(r.arrival.duplicates), u(r.arrival.reordered), u(r.jb.late),
                    r.arrival.jitter_ms, r.arrival.max_gap_ms, r.jb_held, r.jb_target, r.jb_max_held, u(r.jb.underruns),
                    u(r.concealed), u(r.decode_errors), u(r.invalid.total()), static_cast<double>(r.output_peak_dbfs));
        if (full) {
            std::printf("[%s]   played %llu, lost (concealed) %llu, rebuffers %llu, drift skips %llu, too-early resets "
                        "%llu, stream resets %llu, end-of-stream %llu, queue-full drops %llu, render callbacks %llu, "
                        "max render %.3f ms, wrong-rate callbacks %llu, reports sent %llu, gain %.1f dB\n",
                        who, u(r.jb.played), u(r.jb.lost), u(r.jb.rebuffers), u(r.jb.drift_skips),
                        u(r.jb.too_early_resets), u(r.jb.resets), u(r.end_of_stream), u(r.queue_full_drops),
                        u(r.render_callbacks), static_cast<double>(r.max_render_ns) / 1e6, u(r.wrong_rate_callbacks),
                        u(r.reports_sent), static_cast<double>(r.gain_db));
            std::printf("[%s]   invalid by reason: src %llu, oversized %llu, length %llu, version %llu, type %llu, "
                        "crc %llu, session %llu, payload %llu\n",
                        who, u(r.invalid.src_rejected), u(r.invalid.oversized), u(r.invalid.bad_length),
                        u(r.invalid.bad_version), u(r.invalid.bad_type), u(r.invalid.bad_crc), u(r.invalid.bad_session),
                        u(r.invalid.bad_payload));
        }
    }
    std::fflush(stdout);
}

}  // namespace

int main(int argc, char* argv[]) {
    if (argc < 2) {
        return usage();
    }
    std::string mode = argv[1];
    if (mode == "--interfaces") {
        std::string error;
        net::init_sockets(error);
        for (const auto& i : net::list_ipv4_interfaces()) {
            std::printf("%-16s %-40s %s%s\n", i.address.c_str(), i.name.c_str(), i.loopback ? "loopback" : "",
                        i.private_lan ? "private LAN" : "");
        }
        return 0;
    }
    if (mode != "--producer" && mode != "--performer") {
        return usage();
    }
    const bool producer = mode == "--producer";
    std::string bind = "127.0.0.1";
    std::string host;
    std::uint16_t port = 52000;
    std::string code;
    std::string code_file;
    bool use_audio = false;
    long device = -1;
    std::filesystem::path out = "rr_session_takes";
    std::string log_path;
    std::uint16_t test_major = 0;
    LiveOptions live;
    std::string script = producer ? "wait-ready; record; wait 3; stop; wait-state Ready 10; wait 1; quit"
                                  : "wait-ready 30; wait-closed";
    for (int i = 2; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : std::string(); };
        if (a == "--bind") bind = next();
        else if (a == "--host") host = next();
        else if (a == "--port") port = static_cast<std::uint16_t>(std::atoi(next().c_str()));
        else if (a == "--code") code = next();
        else if (a == "--code-file") code_file = next();
        else if (a == "--audio") use_audio = true;
        else if (a == "--device") device = std::atol(next().c_str());
        else if (a == "--out") out = next();
        else if (a == "--log") log_path = next();
        else if (a == "--script") script = next();
        else if (a == "--test-protocol-major") test_major = static_cast<std::uint16_t>(std::atoi(next().c_str()));
        else if (a == "--live") live.enabled = true;
        else if (a == "--media-port") live.media_port = static_cast<std::uint16_t>(std::atoi(next().c_str()));
        else if (a == "--live-source") live.source = next();
        else if (a == "--live-sink") live.sink = next();
        else if (a == "--live-gain-db") live.playout.gain_db = static_cast<float>(std::atof(next().c_str()));
        else if (a == "--jitter-frames") live.playout.target_frames = static_cast<std::uint32_t>(std::atoi(next().c_str()));
        else if (a == "--frame-ms") live.codec.frame_samples = static_cast<std::uint32_t>(std::lround(std::atof(next().c_str()) * 48.0));
        else if (a == "--bitrate") live.codec.bitrate_bps = static_cast<std::uint32_t>(std::atoi(next().c_str()));
        else if (a == "--application") live.codec.application = next() == "audio" ? media::OpusApplication::Audio
                                                                                   : media::OpusApplication::RestrictedLowDelay;
        else if (a == "--sim-loss") live.sim.loss_percent = std::atof(next().c_str());
        else if (a == "--sim-dup") live.sim.duplicate_percent = std::atof(next().c_str());
        else if (a == "--sim-reorder") live.sim.reorder_percent = std::atof(next().c_str());
        else if (a == "--sim-seed") live.sim.seed = static_cast<std::uint32_t>(std::atoi(next().c_str()));
        else if (a == "--sim-burst") {
            const auto parts = split(next(), ':');
            if (parts.size() != 2) return usage();
            live.sim.burst_every = static_cast<std::uint32_t>(std::atoi(parts[0].c_str()));
            live.sim.burst_length = static_cast<std::uint32_t>(std::atoi(parts[1].c_str()));
        }
        else return usage();
    }
    if (!producer && host.empty()) {
        return usage();
    }
    if (live.media_port == 0) {
        live.media_port = static_cast<std::uint16_t>(port + 1);
    }
    if (live.enabled) {
        std::string bad = media::validate(live.codec);
        if (bad.empty()) {
            bad = media::validate(live.playout);
        }
        if (!bad.empty()) {
            std::fprintf(stderr, "live settings: %s\n", bad.c_str());
            return 2;
        }
        if (live.source == "auto") {
            live.source = use_audio ? "mic" : "tone";
        }
        if (live.source == "mic" && !use_audio) {
            std::fprintf(stderr, "--live-source mic needs --audio (an open input device)\n");
            return 2;
        }
    }

    log::Logger logger;
    std::shared_ptr<log::JsonLinesFileSink> file_sink;
    if (!log_path.empty()) {
        file_sink = std::make_shared<log::JsonLinesFileSink>(log_path);
        logger.add_sink(file_sink);
    }
    logger.start();

    AppConfig app = AppConfig::defaults_for(producer ? Role::Producer : Role::Performer);
    control::ControllerConfig cfg;
    cfg.role = app.role;
    cfg.timing = app.timing;
    cfg.app_version = build_info().version + " (rr_session_probe)";
    cfg.display_name = producer ? "Probe producer" : "Probe performer";
    cfg.test_protocol_major = test_major;

    std::unique_ptr<audio::AudioEngine> engine;
    std::unique_ptr<control::RecorderPort> port_impl;
    const bool device_sink = live.enabled && !producer && live.sink == "device";
    if (use_audio || device_sink) {
        engine = std::make_unique<audio::AudioEngine>();
        std::string error;
        if (!engine->initialise(error)) {
            std::fprintf(stderr, "audio: %s\n", error.c_str());
            return 1;
        }
    }
    if (device_sink) {
        std::string error;
        const auto outputs = engine->playback_devices(error);
        std::size_t index = 0;
        for (const auto& d : outputs) {
            if (d.is_default) {
                index = d.index;
            }
        }
        if (outputs.empty() || !engine->open_playback(index, audio::PlaybackOptions{}, error)) {
            std::fprintf(stderr, "audio output: %s\n", outputs.empty() ? "no output device" : error.c_str());
            return 1;
        }
        std::printf("[performer] live output: %s at %u Hz, gain %.1f dB. Use HEADPHONES (feedback and bleed into the "
                    "master).\n",
                    engine->playback_description().device_name.c_str(), static_cast<unsigned>(engine->playback_rate()),
                    static_cast<double>(live.playout.gain_db));
    }
    if (use_audio) {
        std::string error;
        const auto devices = engine->capture_devices(error);
        std::size_t index = 0;
        for (const auto& d : devices) {
            if (d.is_default) {
                index = d.index;
            }
        }
        if (device >= 0) {
            index = static_cast<std::size_t>(device);
        }
        if (!engine->open_capture(index, audio::CaptureOptions{}, audio::RecorderOptions{}, error)) {
            std::fprintf(stderr, "audio: %s\n", error.c_str());
            return 1;
        }
        port_impl = std::make_unique<control::AudioRecorderPort>(*engine, out, app);
    } else {
        port_impl = std::make_unique<control::TestRecorderPort>();
    }

    control::SessionController controller(cfg, *port_impl, logger);
    const char* who = producer ? "producer" : "performer";
    Probe probe{controller, 0, who, nullptr};

    // ---- live audio (Stage 7): started once the session is connected ----
    std::unique_ptr<media::LiveSender> sender;
    std::unique_ptr<media::LiveReceiver> receiver;
    audio::LiveTap tone_tap;
    std::unique_ptr<TenMsClock> source_clock;
    std::unique_ptr<TenMsClock> sink_clock;
    std::vector<float> sink_samples;  // wav sink: what the TEST PLAYBACK CLOCK would have played
    std::string wav_path;
    bool live_on = true;
    std::int64_t last_live_print = 0;
    if (live.enabled) {
#ifdef _WIN32
        timeBeginPeriod(1);  // 1 ms sleep granularity for the 10 ms test clocks
#endif
        if (producer) {
            sender = std::make_unique<media::LiveSender>(&logger);
            if (live.source == "tone") {
                std::printf("[producer] live source: TEST TONE 440 Hz at -20 dBFS (not a microphone)\n");
                tone_tap.set_source_rate(48000);
                source_clock = std::make_unique<TenMsClock>([&tone_tap, phase = std::uint64_t{0}]() mutable {
                    float block[480];
                    for (std::size_t i = 0; i < 480; ++i) {
                        block[i] = 0.1f * static_cast<float>(
                                              std::sin(2.0 * kPi * 440.0 * static_cast<double>(phase + i) / 48000.0));
                    }
                    phase += 480;
                    tone_tap.push_capture(block, 480, 1);
                });
            } else {
                std::printf("[producer] live source: input device '%s'\n",
                            engine->capture_description().device_name.c_str());
            }
        } else {
            receiver = std::make_unique<media::LiveReceiver>(&logger);
            if (live.sink.rfind("wav:", 0) == 0) {
                wav_path = live.sink.substr(4);
            }
            if (!device_sink) {
                std::printf("[performer] live sink: TEST PLAYBACK CLOCK (10 ms), %s\n",
                            wav_path.empty() ? "output discarded" : ("output saved to " + wav_path).c_str());
                sink_samples.reserve(static_cast<std::size_t>(48000) * 120);  // at most 120 s are kept
            }
        }
    }
    std::uint32_t media_session = 0;
    probe.on_pump = [&]() {
        if (!live.enabled) {
            return;
        }
        const auto snap = controller.snapshot();
        if (snap.link == LinkState::Connected && media_session == 0 &&
            media::session_id_to_u32(snap.session_id, media_session)) {
            std::string error;
            if (producer) {
                media::LiveSenderConfig sc;
                sc.bind_address = bind;
                sc.media_port = live.media_port;
                sc.session_id = media_session;
                sc.expected_peer_address = snap.peer_address;
                sc.codec = live.codec;
                sc.test_impairment = live.sim;
                audio::LiveTap& tap = live.source == "tone" ? tone_tap : engine->live_tap();
                if (!sender->start(sc, tap, error)) {
                    std::printf("[producer] LIVE SEND FAILED: %s\n", error.c_str());
                } else {
                    sender->set_sending(live_on);
                    std::printf("[producer] live sender on UDP %s:%u for performer %s%s\n", bind.c_str(),
                                static_cast<unsigned>(live.media_port), snap.peer_address.c_str(),
                                live.sim.active() ? "  ** TEST IMPAIRMENT ON **" : "");
                }
            } else {
                media::LiveReceiverConfig rc;
                rc.producer_host = host;
                rc.media_port = live.media_port;
                rc.session_id = media_session;
                rc.playout = live.playout;
                if (!receiver->start(rc, error)) {
                    std::printf("[performer] LIVE RECEIVE FAILED: %s\n", error.c_str());
                } else {
                    receiver->set_output_enabled(live_on);
                    if (device_sink) {
                        engine->attach_playback_contributor(receiver.get());
                    } else {
                        media::LiveReceiver* r = receiver.get();
                        std::vector<float>* keep = wav_path.empty() ? nullptr : &sink_samples;
                        sink_clock = std::make_unique<TenMsClock>([r, keep]() {
                            float block[480] = {};
                            r->render_add(block, 480, 1, 48000);
                            if (keep != nullptr && keep->size() + 480 <= keep->capacity()) {
                                keep->insert(keep->end(), block, block + 480);
                            }
                        });
                    }
                    std::printf("[performer] live receiver for %s:%u\n", host.c_str(),
                                static_cast<unsigned>(live.media_port));
                }
            }
        }
        const std::int64_t now = time::monotonic_ns();
        if (now - last_live_print > 2000000000ll) {
            last_live_print = now;
            print_live(who, sender.get(), receiver.get(), false);
        }
    };
    std::printf("[%s] recorder: %s\n", who, port_impl->description().c_str());
    std::string error;
    if (producer) {
        if (!controller.create_session(bind, port, error)) {
            std::fprintf(stderr, "[producer] %s\n", error.c_str());
            return 1;
        }
        const std::string pairing = controller.snapshot().pairing_code;
        std::printf("[producer] session %s on %s:%u  PAIRING CODE %s (shown to the user only; never logged)\n",
                    controller.snapshot().session_id.c_str(), bind.c_str(), static_cast<unsigned>(port), pairing.c_str());
        if (!code_file.empty()) {
            std::ofstream(code_file) << pairing;
        }
    } else {
        if (code.empty() && !code_file.empty()) {
            // Wait up to 10 s for the producer to write the file (two-process tests).
            for (int i = 0; i < 1000 && code.empty(); ++i) {
                std::ifstream in(code_file);
                std::getline(in, code);
                code = trim(code);
                if (code.size() != 6) {
                    code.clear();
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                }
            }
        }
        if (!controller.join(host, port, code, error)) {
            std::fprintf(stderr, "[performer] %s\n", error.c_str());
            return 1;
        }
    }
    controller.set_consent(true);

    int rc = 0;
    for (std::string step : split(script, ';')) {
        step = trim(step);
        if (step.empty()) {
            continue;
        }
        std::printf("[%s] > %s\n", who, step.c_str());
        std::istringstream in(step);
        std::string cmd;
        in >> cmd;
        bool ok = true;
        if (cmd == "wait") {
            double s = 1;
            in >> s;
            probe.run_for(s);
        } else if (cmd == "wait-ready") {
            double s = 20;
            in >> s;
            ok = probe.until([&] { return controller.snapshot().session == SessionState::Ready; }, s);
        } else if (cmd == "wait-state" || cmd == "wait-link") {
            std::string name;
            double s = 20;
            in >> name >> s;
            ok = probe.until(
                [&] {
                    const auto snap = controller.snapshot();
                    return cmd == "wait-state" ? std::string(session::session_state_name(snap.session)) == name
                                               : std::string(session::link_state_name(snap.link)) == name;
                },
                s);
        } else if (cmd == "wait-closed") {
            ok = probe.until(
                [&] {
                    const auto snap = controller.snapshot();
                    return snap.link == LinkState::Disconnected;
                },
                600);
        } else if (cmd == "record") {
            ok = controller.start_take(error);
        } else if (cmd == "stop") {
            ok = probe.until([&] { return controller.snapshot().session == SessionState::Recording; }, 5) &&
                 controller.stop_take(error);
        } else if (cmd == "stop-and-save") {
            ok = controller.stop_and_save(error);
        } else if (cmd == "drop-link") {
            if (controller.link()) {
                controller.link()->test_drop_connection();
            }
        } else if (cmd == "consent") {
            std::string v;
            in >> v;
            controller.set_consent(v == "on");
        } else if (cmd == "live") {
            std::string v;
            in >> v;
            live_on = v == "on";
            if (sender) {
                sender->set_sending(live_on);
            }
            if (receiver) {
                receiver->set_output_enabled(live_on);
            }
        } else if (cmd == "live-stats") {
            print_live(who, sender.get(), receiver.get(), true);
        } else if (cmd == "leave") {
            controller.leave();
        } else if (cmd == "quit") {
            break;
        } else {
            std::printf("[%s] unknown command '%s'\n", who, cmd.c_str());
            ok = false;
        }
        if (!ok) {
            std::printf("[%s] STEP FAILED: %s %s\n", who, step.c_str(), error.c_str());
            rc = 1;
            break;
        }
    }
    probe.pump();
    print_summary(controller.snapshot(), who);
    if (live.enabled) {
        std::printf("\n[%s] LIVE SUMMARY (live monitor stream only; the master recordings are separate files)\n", who);
        print_live(who, sender.get(), receiver.get(), true);
    }
    // Live teardown: stop the test clocks and detach from the device before the objects go away.
    source_clock.reset();
    sink_clock.reset();
    if (engine) {
        engine->detach_playback_contributor();
    }
    if (sender) {
        sender->stop();
    }
    if (receiver) {
        receiver->stop();
    }
    if (!wav_path.empty()) {
        audio::WavWriter w;
        audio::WavFormat f;
        f.sample_rate = 48000;
        f.channels = 1;
        if (w.open(wav_path, f) && w.write_frames(sink_samples.data(), sink_samples.size()) && w.finalise()) {
            std::printf("[performer] live sink saved: %s (%zu frames; TEST PLAYBACK CLOCK output, not a recording)\n",
                        wav_path.c_str(), sink_samples.size());
        } else {
            std::printf("[performer] could not save %s: %s\n", wav_path.c_str(), w.error().c_str());
        }
    }
#ifdef _WIN32
    if (live.enabled) {
        timeEndPeriod(1);
    }
#endif
    controller.shutdown();
    if (engine) {
        engine->close_capture();
    }
    logger.stop();
    return rc;
}
