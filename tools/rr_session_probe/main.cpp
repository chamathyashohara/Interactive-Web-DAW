// rr_session_probe: scriptable command-line producer or performer, using exactly the library
// code of the apps (rr_control, rr_media). For two-instance tests on one PC and two-PC tests without Qt.
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
//   live on|off           send this side's live stream (Stage 7/8)
//   mute on|off           send flagged silence instead of the microphone (stream keeps running)
//   hear on|off           play the incoming live stream (receive mute)
//   blackhole on|off      TEST ONLY: drop every received media datagram (one direction fails)
//   reopen-input          re-open the input device (device-change test; needs --audio)
//   reopen-output         re-open the output device (device-change test; needs --live-sink device)
//   live-stats            print the live counters now
//   live-report <file>    write the one-page live diagnostics report now
// Default scripts: producer "wait-ready; record; wait 3; stop; wait-state Ready 10; wait 1; quit",
//                  performer "wait-ready 30; wait-closed".
// Without --audio the TEST RECORDER (no audio, nothing written) is used and labelled as such.
//
// Live audio (ADR-017, ADR-018), enabled with --live. Two-way by default (Stage 8): the producer
// sends stream 1 and receives stream 2, the performer the opposite. --one-way = Stage 7
// (producer -> performer only).
//   --media-port <n>          UDP media port on the producer (default: control port + 1)
//   --live-source tone|bursts|silence|echo|mic
//                             tone = TEST TONE (producer 440 Hz, performer 660 Hz, -20 dBFS);
//                             bursts = 50 ms of that tone every 500 ms (for delay measurement);
//                             echo = TEST: send back what this side hears (simulates speakers
//                             feeding the microphone); mic = the open input (needs --audio).
//                             Default: mic with --audio, else tone.
//   --live-sink null|wav:<file>|device
//                             null/wav: a 10 ms TEST PLAYBACK CLOCK (wav saves what would play);
//                             device: the default output device
//   --source-wav <file>       save what the test source sent, on the same clock as the sink
//   --live-gain-db <dB>       -60..0 (default -12)   --jitter-frames <n> 1..16 (default 3)
//   --frame-ms 2.5|5|10|20 (default 10)   --bitrate <bit/s> 16000..128000 (default 64000)
//   --application lowdelay|audio (default lowdelay)
//   --no-control-hint         do not treat the control link as proof that the peer is reachable
//   --report <file>           write the one-page live diagnostics report at the end
//   --conditions "<text>"     test conditions written into the report
//   test only: --sim-loss <pct> --sim-dup <pct> --sim-reorder <pct> --sim-burst <every>:<length>
//              --sim-seed <n>   (applied to THIS side's outgoing stream before sendto)
// Exit code 0 = script completed, 1 = a step failed or timed out, 2 = usage error.

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "rr/audio/audio_engine.hpp"
#include "rr/audio/wav_writer.hpp"
#include "rr/control/session_controller.hpp"
#include "rr/media/live_endpoint.hpp"
#include "rr/media/live_report.hpp"
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
                 "  live audio (two-way; --one-way = producer -> performer only): --live [--media-port <n>]\n"
                 "    [--live-source tone|bursts|silence|echo|mic] [--live-sink null|wav:<file>|device] [--source-wav <file>]\n"
                 "    [--live-gain-db <dB>] [--jitter-frames <n>] [--frame-ms <ms>] [--bitrate <bit/s>]\n"
                 "    [--application lowdelay|audio] [--no-control-hint] [--report <file>] [--conditions \"<text>\"]\n"
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
// TEST CLOCK: stands in for the capture and playback callbacks when no device is used.
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
    bool one_way = false;
    bool control_hint = true;
    std::uint16_t media_port = 0;
    std::string source = "auto";
    std::string sink = "null";
    std::string source_wav;
    std::string report_path;
    std::string conditions = "two processes on one PC (development PC)";
    media::LiveCodecSettings codec;
    media::LivePlayoutSettings playout;
    media::ImpairmentSettings sim;
};

unsigned long long u(std::uint64_t v) {
    return static_cast<unsigned long long>(v);
}

// What the TEST CLOCK sends and what it plays, sample-aligned (same tick).
struct TestAudio {
    std::mutex mutex;
    std::vector<float> sent;
    std::vector<float> heard;
};

bool save_wav(const std::string& path, const std::vector<float>& samples) {
    audio::WavWriter w;
    audio::WavFormat f;
    f.sample_rate = 48000;
    f.channels = 1;
    return w.open(path, f) && w.write_frames(samples.data(), samples.size()) && w.finalise();
}

void print_live(const char* who, const media::LiveEndpoint& ep) {
    if (!ep.running()) {
        return;
    }
    const media::EndpointStats e = ep.stats();
    if (const media::OutgoingStream* out = ep.outgoing()) {
        const auto o = out->stats();
        std::printf("[%s] OUT stream %u: %s | packets %llu, muted frames %llu, send errors %llu, tap gaps %llu fr, "
                    "backlog trims %llu fr, sim drop/dup/reorder %llu/%llu/%llu\n",
                    who, o.stream_id, media::outgoing_status_text(o, e).c_str(), u(o.packets_sent), u(o.muted_frames),
                    u(o.send_errors), u(o.tap_gap_frames), u(o.backlog_trim_frames), u(o.test_dropped),
                    u(o.test_duplicated), u(o.test_reordered));
        if (e.has_remote_report) {
            const auto& r = e.remote_report;
            std::printf("[%s]   remote reports on it: received %llu, lost est %llu, late %u, dup %u, reordered %u, "
                        "jitter %.3f ms, buffer %u/%u, underruns %u, concealed %u\n",
                        who, u(r.received), u(r.lost_estimate), r.late, r.duplicates, r.reordered, r.jitter_us / 1000.0,
                        r.jb_fill, r.jb_target, r.underruns, r.concealed);
        }
    }
    if (const media::IncomingStream* in = ep.incoming()) {
        const auto i = in->stats();
        std::printf("[%s] IN  stream %u: %s | received %llu, lost est %llu, dup %llu, reordered %llu, late %llu, "
                    "jitter %.3f ms, max gap %.1f ms, buffer %u/%u (max %u), underruns %llu, concealed %llu, catch-up %llu, "
                    "queue-full %llu, resyncs %llu\n",
                    who, i.stream_id, media::incoming_status_text(i, e).c_str(), u(i.arrival.received),
                    u(i.arrival.lost_estimate), u(i.arrival.duplicates), u(i.arrival.reordered), u(i.jb.late),
                    i.arrival.jitter_ms, i.arrival.max_gap_ms, i.jb_held, i.jb_target, i.jb_max_held, u(i.jb.underruns),
                    u(i.concealed), u(i.jb.catchup_frames), u(i.queue_full_drops), u(i.jb.resyncs));
    }
    if (e.invalid.total() > 0 || e.test_blackholed > 0) {
        std::printf("[%s]   invalid %llu (wrong stream %llu), TEST blackholed %llu\n", who, u(e.invalid.total()),
                    u(e.invalid.wrong_stream), u(e.test_blackholed));
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
        else if (a == "--one-way") live.one_way = true;
        else if (a == "--no-control-hint") live.control_hint = false;
        else if (a == "--media-port") live.media_port = static_cast<std::uint16_t>(std::atoi(next().c_str()));
        else if (a == "--live-source") live.source = next();
        else if (a == "--live-sink") live.sink = next();
        else if (a == "--source-wav") live.source_wav = next();
        else if (a == "--report") live.report_path = next();
        else if (a == "--conditions") live.conditions = next();
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
    // Which streams this side has.
    const bool has_out = live.enabled && (producer || !live.one_way);
    const bool has_in = live.enabled && (!producer || !live.one_way);
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
        if (live.source != "mic" && live.source != "tone" && live.source != "bursts" && live.source != "silence" &&
            live.source != "echo") {
            return usage();
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
    const char* who = producer ? "producer" : "performer";

    std::unique_ptr<audio::AudioEngine> engine;
    std::unique_ptr<control::RecorderPort> port_impl;
    const bool device_sink = has_in && live.sink == "device";
    std::size_t input_index = 0;
    std::size_t output_index = 0;
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
        for (const auto& d : outputs) {
            if (d.is_default) {
                output_index = d.index;
            }
        }
        if (outputs.empty() || !engine->open_playback(output_index, audio::PlaybackOptions{}, error)) {
            std::fprintf(stderr, "audio output: %s\n", outputs.empty() ? "no output device" : error.c_str());
            return 1;
        }
        std::printf("[%s] live output: %s at %u Hz, gain %.1f dB. Use HEADPHONES (no echo cancellation).\n", who,
                    engine->playback_description().device_name.c_str(), static_cast<unsigned>(engine->playback_rate()),
                    static_cast<double>(live.playout.gain_db));
    }
    if (use_audio) {
        std::string error;
        const auto devices = engine->capture_devices(error);
        for (const auto& d : devices) {
            if (d.is_default) {
                input_index = d.index;
            }
        }
        if (device >= 0) {
            input_index = static_cast<std::size_t>(device);
        }
        if (!engine->open_capture(input_index, audio::CaptureOptions{}, audio::RecorderOptions{}, error)) {
            std::fprintf(stderr, "audio: %s\n", error.c_str());
            return 1;
        }
        port_impl = std::make_unique<control::AudioRecorderPort>(*engine, out, app);
    } else {
        port_impl = std::make_unique<control::TestRecorderPort>();
    }

    control::SessionController controller(cfg, *port_impl, logger);
    Probe probe{controller, 0, who, nullptr};

    // ---- live audio: started once the session is connected ----
    media::LiveEndpoint endpoint(&logger);
    audio::LiveTap test_tap;   // fed by the TEST CLOCK when the source is not the microphone
    TestAudio test_audio;
    std::unique_ptr<TenMsClock> clock;
    std::string sink_wav;
    bool send_on = true;
    bool hear_on = true;
    bool mute_on = false;
    std::int64_t last_live_print = 0;
    const bool test_source = has_out && live.source != "mic";
    const bool test_sink = has_in && !device_sink;
    if (live.enabled) {
#ifdef _WIN32
        timeBeginPeriod(1);  // 1 ms sleep granularity for the 10 ms test clock
#endif
        if (live.sink.rfind("wav:", 0) == 0) {
            sink_wav = live.sink.substr(4);
        }
        const double hz = producer ? 440.0 : 660.0;
        if (has_out) {
            if (live.source == "mic") {
                std::printf("[%s] live source: input device '%s'\n", who, engine->capture_description().device_name.c_str());
            } else {
                std::printf("[%s] live source: TEST %s%s (not a microphone)\n", who,
                            live.source == "echo"     ? "ECHO: sends back what this side hears (simulated speaker->mic)"
                            : live.source == "silence" ? "SILENCE"
                                                       : (live.source == "bursts" ? "BURSTS 50 ms / 500 ms of " : "TONE "),
                            (live.source == "tone" || live.source == "bursts")
                                ? (std::to_string(static_cast<int>(hz)) + " Hz at -20 dBFS").c_str()
                                : "");
            }
        }
        if (test_sink) {
            std::printf("[%s] live sink: TEST PLAYBACK CLOCK (10 ms), %s\n", who,
                        sink_wav.empty() ? "output discarded" : ("output saved to " + sink_wav).c_str());
        }
        test_tap.set_source_rate(48000);
        test_audio.sent.reserve(static_cast<std::size_t>(48000) * 120);   // at most 120 s are kept
        test_audio.heard.reserve(static_cast<std::size_t>(48000) * 120);
    }
    // One TEST CLOCK renders the incoming stream and then pushes the test source, so `sent` and
    // `heard` are sample-aligned (same tick = same time).
    auto clock_tick = [&, phase = std::uint64_t{0}, hz = producer ? 440.0 : 660.0]() mutable {
        float heard[480] = {};
        if (test_sink && endpoint.incoming() != nullptr) {
            endpoint.incoming()->render_add(heard, 480, 1, 48000);
        }
        float sent[480] = {};
        if (test_source) {
            for (std::size_t i = 0; i < 480; ++i) {
                const std::uint64_t n = phase + i;
                const bool on = live.source == "tone" || (live.source == "bursts" && (n % 24000) < 2400);
                sent[i] = on ? 0.1f * static_cast<float>(std::sin(2.0 * kPi * hz * static_cast<double>(n) / 48000.0)) : 0.0f;
                if (live.source == "echo") {
                    sent[i] = heard[i];
                }
            }
            test_tap.push_capture(sent, 480, 1);
        }
        phase += 480;
        std::lock_guard<std::mutex> lock(test_audio.mutex);
        if (test_audio.sent.size() + 480 <= test_audio.sent.capacity()) {
            test_audio.sent.insert(test_audio.sent.end(), sent, sent + 480);
            test_audio.heard.insert(test_audio.heard.end(), heard, heard + 480);
        }
    };

    auto local_capture_status = [&]() -> std::string {
        if (!has_out || live.source != "mic") {
            return std::string("TEST SOURCE '") + live.source + "' (no capture device for the live stream)" +
                   (engine && engine->capture_open() ? "; input device open for recording" : "");
        }
        if (!engine || !engine->capture_open()) {
            return "input device CLOSED";
        }
        const auto& d = engine->capture_description();
        const auto st = engine->ingest()->stats();
        return "running: " + d.device_name + ", " + std::to_string(d.sample_rate) + " Hz, " + std::to_string(d.channels) +
               " ch, record-ring overruns " + std::to_string(st.overrun_events) +
               (engine->capture_fault() != audio::DeviceFault::None ? ", DEVICE FAULT" : "");
    };
    auto local_recording_status = [&]() -> std::string {
        const auto s = controller.snapshot();
        std::string r = port_impl->description() + "; session state " + std::string(session::session_state_name(s.session));
        if (s.take.take_id != 0) {
            r += "; take " + std::to_string(s.take.take_id) + " " +
                 (s.take.local_finalised ? std::string(take_status_name(s.take.local_status)) + ", " +
                                               std::to_string(s.take.local_frames) + " frames"
                                         : std::string(s.take.local_started ? "RECORDING" : "not started"));
        }
        return r;
    };
    auto remote_status = [&]() -> std::string {
        const auto s = controller.snapshot();
        char rtt[64];
        std::snprintf(rtt, sizeof rtt, "%.3f", static_cast<double>(s.link_stats.control_rtt_ns) / 1e6);
        return "'" + s.peer_name + "' at " + s.peer_address + ", control link " +
               std::string(session::link_state_name(s.link)) + ", control RTT " + rtt + " ms";
    };
    auto write_report = [&](const std::string& path) {
        if (!endpoint.running()) {
            std::printf("[%s] no live report: live media not running\n", who);
            return;
        }
        media::LiveReportConditions c;
        c.generated_utc = time::format_utc_iso8601_ms(time::utc_now_ms());
        c.role = producer ? "Producer (rr_session_probe)" : "Performer (rr_session_probe)";
        c.app_version = build_info().version;
        c.session_id = controller.snapshot().session_id;
        c.capture_device = (has_out && live.source == "mic") ? engine->capture_description().device_name
                                                             : "TEST SOURCE " + live.source;
        c.capture_rate = (has_out && live.source == "mic") ? engine->capture_description().sample_rate : 48000;
        c.output_device = device_sink ? engine->playback_description().device_name : "TEST PLAYBACK CLOCK";
        c.output_rate = device_sink ? engine->playback_rate() : 48000;
        c.local_capture_status = local_capture_status();
        c.local_recording_status = local_recording_status();
        c.remote_participant_status = remote_status();
        c.test_conditions = live.conditions + (live.sim.active() ? "; TEST impairment on this side's outgoing stream" : "");
        c.headphones = "not applicable (probe)";
        std::ofstream(path) << media::live_report_text(c, endpoint);
        std::printf("[%s] live report written: %s\n", who, path.c_str());
    };

    std::uint32_t media_session = 0;
    probe.on_pump = [&]() {
        if (!live.enabled) {
            return;
        }
        const auto snap = controller.snapshot();
        endpoint.set_control_link_up(live.control_hint && snap.link == LinkState::Connected);
        if (snap.link == LinkState::Connected && media_session == 0 &&
            media::session_id_to_u32(snap.session_id, media_session)) {
            media::LiveEndpointConfig c;
            c.bind_mode = producer;
            c.local_address = bind;
            c.peer_address = producer ? snap.peer_address : host;
            c.media_port = live.media_port;
            c.session_id = media_session;
            c.has_outgoing = has_out;
            c.outgoing.stream_id = producer ? media::kStreamProducerMic : media::kStreamPerformerMic;
            c.outgoing.codec = live.codec;
            c.outgoing.test_impairment = live.sim;
            c.has_incoming = has_in;
            c.incoming.stream_id = producer ? media::kStreamPerformerMic : media::kStreamProducerMic;
            c.incoming.playout = live.playout;
            audio::LiveTap* tap = has_out ? (live.source == "mic" ? &engine->live_tap() : &test_tap) : nullptr;
            std::string error;
            if (!endpoint.start(c, tap, error)) {
                std::printf("[%s] LIVE MEDIA FAILED: %s\n", who, error.c_str());
            } else {
                if (endpoint.outgoing()) {
                    endpoint.outgoing()->set_enabled(send_on);
                    endpoint.outgoing()->set_muted(mute_on);
                }
                if (endpoint.incoming()) {
                    endpoint.incoming()->set_output_enabled(hear_on);
                    if (device_sink) {
                        engine->attach_playback_contributor(endpoint.incoming());
                    }
                }
                if (test_source || test_sink) {
                    clock = std::make_unique<TenMsClock>(clock_tick);
                }
                std::printf("[%s] live media on UDP %s: out %s, in %s%s\n", who, endpoint.stats().local_endpoint.c_str(),
                            has_out ? (producer ? "stream 1" : "stream 2") : "none",
                            has_in ? (producer ? "stream 2" : "stream 1") : "none",
                            live.sim.active() ? "  ** TEST IMPAIRMENT ON (outgoing) **" : "");
            }
        }
        const std::int64_t now = time::monotonic_ns();
        if (now - last_live_print > 2000000000ll) {
            last_live_print = now;
            print_live(who, endpoint);
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
        } else if (cmd == "live" || cmd == "mute" || cmd == "hear" || cmd == "blackhole") {
            std::string v;
            in >> v;
            const bool on = v == "on";
            if (cmd == "live") {
                send_on = on;
                if (endpoint.outgoing()) endpoint.outgoing()->set_enabled(on);
            } else if (cmd == "mute") {
                mute_on = on;
                if (endpoint.outgoing()) endpoint.outgoing()->set_muted(on);
            } else if (cmd == "hear") {
                hear_on = on;
                if (endpoint.incoming()) endpoint.incoming()->set_output_enabled(on);
            } else {
                endpoint.set_test_receive_blackhole(on);
            }
        } else if (cmd == "reopen-input") {
            ok = engine && engine->capture_open() &&
                 engine->open_capture(input_index, audio::CaptureOptions{}, audio::RecorderOptions{}, error);
            if (!engine) error = "needs --audio";
        } else if (cmd == "reopen-output") {
            ok = engine && device_sink && engine->open_playback(output_index, audio::PlaybackOptions{}, error);
            if (!device_sink) error = "needs --live-sink device";
        } else if (cmd == "live-stats") {
            print_live(who, endpoint);
            std::printf("[%s] STATUS local capture: %s\n[%s] STATUS local recording: %s\n[%s] STATUS remote participant: %s\n",
                        who, local_capture_status().c_str(), who, local_recording_status().c_str(), who,
                        remote_status().c_str());
        } else if (cmd == "live-report") {
            std::string path;
            in >> path;
            write_report(path);
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
        std::printf("\n[%s] LIVE SUMMARY (live monitor streams only; the master recordings are separate files)\n", who);
        print_live(who, endpoint);
        if (!live.report_path.empty()) {
            write_report(live.report_path);
        }
    }
    // Live teardown: stop the test clock and detach from the device before the endpoint stops.
    clock.reset();
    if (engine) {
        engine->detach_playback_contributor();
    }
    endpoint.stop();
    {
        std::lock_guard<std::mutex> lock(test_audio.mutex);
        if (!sink_wav.empty()) {
            std::printf("[%s] live sink %s: %s (%zu frames; TEST PLAYBACK CLOCK output, not a recording)\n", who,
                        save_wav(sink_wav, test_audio.heard) ? "saved" : "NOT SAVED", sink_wav.c_str(),
                        test_audio.heard.size());
        }
        if (!live.source_wav.empty()) {
            std::printf("[%s] test source %s: %s (%zu frames, aligned with the sink)\n", who,
                        save_wav(live.source_wav, test_audio.sent) ? "saved" : "NOT SAVED", live.source_wav.c_str(),
                        test_audio.sent.size());
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
