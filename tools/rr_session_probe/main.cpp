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
// Default scripts: producer "wait-ready; record; wait 3; stop; wait-state Ready 10; wait 1; quit",
//                  performer "wait-ready 30; wait-closed".
// Without --audio the TEST RECORDER (no audio, nothing written) is used and labelled as such.
// Exit code 0 = script completed, 1 = a step failed or timed out, 2 = usage error.

#include <chrono>
#include <cstdio>
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
#include "rr/control/session_controller.hpp"
#include "rr/network/socket.hpp"
#include "rr/shared/build_info.hpp"
#include "rr/shared/clock.hpp"
#include "rr/shared/log_sinks.hpp"

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
                 "  test only: --test-protocol-major <n> announces a different protocol major version in HELLO\n");
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

    void pump() {
        c.poll();
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
        else return usage();
    }
    if (!producer && host.empty()) {
        return usage();
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
    if (use_audio) {
        engine = std::make_unique<audio::AudioEngine>();
        std::string error;
        if (!engine->initialise(error)) {
            std::fprintf(stderr, "audio: %s\n", error.c_str());
            return 1;
        }
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
    Probe probe{controller, 0, who};
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
    controller.shutdown();
    if (engine) {
        engine->close_capture();
    }
    logger.stop();
    return rc;
}
