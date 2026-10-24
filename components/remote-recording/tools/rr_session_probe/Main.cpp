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
//   stop-now              Stop without waiting for Recording (before the start = cancel, Stage 9)
//   checks                print this PC's and the other PC's readiness checklist (Stage 9)
//   consent on|off
//   live on|off           send this side's live stream (Stage 7/8)
//   mute on|off           send flagged silence instead of the microphone (stream keeps running)
//   hear on|off           play the incoming live stream (receive mute)
//   blackhole on|off      TEST ONLY: drop every received media datagram (one direction fails)
//   reopen-input          re-open the input device (device-change test; needs --audio)
//   reopen-output         re-open the output device (device-change test; needs --live-sink device)
//   live-stats            print the live counters now
//   live-report <file>    write the one-page live diagnostics report now
//   transfer <take>       producer: request a verified copy of the performer's take (Stage 11)
//   wait-transfer <take> [s] [VERIFIED|FAILED]   until it ends; the step fails on another outcome
//   transfers             print every transfer (state, bytes, chunks, resumes, rejects, SHA-256)
//   cancel-transfer <take>  producer: end a queued/paused transfer as FAILED
//   delivery on|off       performer: allow/withdraw sending copies of its takes (XFER-05)
// Transfer options (Stage 11): --allow-delivery (performer), --auto-transfer (producer),
//   --xfer-chunk-bytes <n> (performer). TEST ONLY: --xfer-drop-after <n> (cuts the transfer
//   connection once, on the side that gives it), --xfer-corrupt-chunk <i>, --xfer-corrupt-whole <i>,
//   --xfer-wrong-session (performer).
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
//   --start-lead-ms <n>       producer: scheduling lead 300..10000 (default 1000; Stage 9)
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
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "rr/audio/AudioEngine.h"
#include "rr/audio/WavWriter.h"
#include "rr/control/SessionController.h"
#include "rr/media/LiveEndpoint.h"
#include "rr/media/LiveReport.h"
#include "rr/network/Socket.h"
#include "rr/shared/BuildInfo.h"
#include "rr/shared/Clock.h"
#include "rr/shared/LogSinks.h"
#include "rr/transfer/TransferTypes.h"

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

namespace
{

int usage()
{
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
                 "  take transfer (Stage 11): --allow-delivery (performer) --auto-transfer (producer) --xfer-chunk-bytes <n>\n"
                 "    script: transfer <take>; wait-transfer <take> [s] [VERIFIED|FAILED]; transfers; cancel-transfer <take>\n"
                 "  test only: --xfer-drop-after <n> --xfer-corrupt-chunk <i> --xfer-corrupt-whole <i> --xfer-wrong-session\n"
                 "  test only: --test-protocol-major <n> announces a different protocol major version in HELLO\n"
                 "  test only: --sim-loss <pct> --sim-dup <pct> --sim-reorder <pct> --sim-burst <every>:<len> --sim-seed <n>\n");
    return 2;
}

std::vector<std::string> split(const std::string& s, char sep)
{
    std::vector<std::string> out;
    std::string cur;
    for (char c : s)
    {
        if (c == sep)
        {
            out.push_back(cur);
            cur.clear();
        }
        else
        {
            cur += c;
        }
    }
    out.push_back(cur);
    return out;
}

std::string trim(std::string s)
{
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t'))
    {
        s.erase(s.begin());
    }
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r' || s.back() == '\n'))
    {
        s.pop_back();
    }
    return s;
}

struct Probe
{
    SessionController& c;
    size_t printed = 0;
    const char* who;
    std::function<void()> onPump;

    void pump()
    {
        c.poll();
        if (onPump)
        {
            onPump();
        }
        const auto lines = c.takeHistory();
        for (size_t i = printed; i < lines.size(); ++i)
        {
            std::printf("[%s] %s\n", who, lines[i].c_str());
        }
        printed = lines.size();
        std::fflush(stdout);
    }

    bool runFor(double seconds)
    {
        const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(static_cast<long long>(seconds * 1000));
        while (std::chrono::steady_clock::now() < end)
        {
            pump();
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        return true;
    }

    template <typename Pred>
    bool until(Pred pred, double seconds)
    {
        const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(static_cast<long long>(seconds * 1000));
        while (std::chrono::steady_clock::now() < end)
        {
            pump();
            if (pred())
            {
                return true;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        pump();
        return pred();
    }
};

void printSummary(const ControllerSnapshot& s, const char* who)
{
    const auto& t = s.take;
    std::printf("\n[%s] SUMMARY\n", who);
    std::printf("  link %s, session %s, session id %s, peer '%s' at %s\n",
                std::string(linkStateName(s.link)).c_str(),
                std::string(sessionStateName(s.session)).c_str(), s.sessionId.c_str(), s.peerName.c_str(),
                s.peerAddress.c_str());
    std::printf("  recorder: %s\n", s.recorderDescription.c_str());
    std::printf("  control RTT %.3f ms, clock offset (peer - local) %.3f ms +/- %.3f ms from %llu samples\n",
                static_cast<double>(s.linkStats.controlRttNs) / 1e6, static_cast<double>(s.linkStats.thetaNs) / 1e6,
                static_cast<double>(s.linkStats.thetaUncertaintyNs) / 1e6,
                static_cast<unsigned long long>(s.linkStats.offsetSamples));
    std::printf("  frames sent %llu received %llu, stale dropped %llu, protocol errors %llu, reconnect attempts %llu\n",
                static_cast<unsigned long long>(s.linkStats.framesSent),
                static_cast<unsigned long long>(s.linkStats.framesReceived),
                static_cast<unsigned long long>(s.linkStats.staleFramesDropped),
                static_cast<unsigned long long>(s.linkStats.protocolErrors),
                static_cast<unsigned long long>(s.linkStats.reconnectAttempts));
    std::printf("  invalid events %llu, refused messages %llu, duplicates %llu\n",
                static_cast<unsigned long long>(s.invalidEvents), static_cast<unsigned long long>(s.refusedMessages),
                static_cast<unsigned long long>(s.duplicateMessages));
    if (t.takeId != 0)
    {
        std::printf("  last take %u: local %s (%s, %llu frames%s)\n", t.takeId, t.localStarted ? "started" : "NOT started",
                    t.localFinalised ? std::string(takeStatusName(t.localStatus)).c_str() : "not finalised",
                    static_cast<unsigned long long>(t.localFrames), t.localFile.empty() ? "" : (", " + t.localFile).c_str());
        if (s.role == Role::Producer)
        {
            std::printf("  performer confirmations: ARM_ACK %s, START_ACK %s, TAKE_STARTED %s, STOP_ACK %s, TAKE_FINALISED %s%s\n",
                        t.peerArmAck ? "yes" : "no", t.peerStartAck ? "yes" : "no", t.peerStarted ? "yes" : "no",
                        t.peerStopAck ? "yes" : "no",
                        t.peerFinalised ? std::string(takeStatusName(t.peerStatus)).c_str() : "no",
                        t.peerReportTimedOut ? " (timed out: UNKNOWN)" : "");
            if (t.hasStartOffset)
            {
                std::printf("  estimated recording-start offset (performer - producer): %.3f ms +/- %.3f ms "
                            "(clock-offset uncertainty only; device input latency not included)\n",
                            t.startOffsetMs, t.startOffsetUncMs);
            }
        }
    }
    if (t.takeId != 0)
    {
        // Stage 9 timing record (this PC's monotonic clock).
        // "n/a" when either stamp is missing (D-76: an earlier build printed -1.000 here).
        auto ms = [](int64_t a, int64_t b) -> std::string
        {
            if (a == 0 || b == 0)
            {
                return "n/a";
            }
            char buf[32];
            std::snprintf(buf, sizeof buf, "%.3f", static_cast<double>(b - a) / 1e6);
            return buf;
        };
        const std::string lead = s.role == Role::Producer ? std::to_string(t.startLeadMs) + " ms" : "n/a (set by the producer)";
        std::printf("  timing take %u: lead %s, scheduled start (local) %lld ns, first sample %s ms after it "
                    "(%llu late frames, first frame %llu), device period %u frames x %u, clock offset %.3f ms +/- %.3f ms "
                    "from %llu samples%s\n",
                    t.takeId, lead.c_str(), static_cast<long long>(t.startAtLocalNs),
                    ms(t.startAtLocalNs, t.localFirstSampleNs).c_str(), static_cast<unsigned long long>(t.localLateFrames),
                    static_cast<unsigned long long>(t.localFirstFrame), t.devicePeriodFrames, t.devicePeriods,
                    static_cast<double>(t.thetaNs) / 1e6, static_cast<double>(t.thetaUncNs) / 1e6,
                    static_cast<unsigned long long>(t.offsetSamples), t.cancelled ? ", CANCELLED" : "");
        if (s.role == Role::Producer)
        {
            std::printf("  timing producer: ARM->ARM_ACK %s ms, SCHEDULE_START->START_ACK %s ms, START_ACK %s ms "
                        "before the start, TAKE_STARTED %s ms after the start, STOP_SCHEDULE->STOP_ACK %s ms, "
                        "stop->performer report %s ms\n",
                        ms(t.armSentNs, t.armAckRxNs).c_str(), ms(t.scheduleSentNs, t.startAckRxNs).c_str(),
                        ms(t.startAckRxNs, t.startAtLocalNs).c_str(), ms(t.startAtLocalNs, t.peerStartedRxNs).c_str(),
                        ms(t.stopCmdNs, t.stopAckRxNs).c_str(), ms(t.stopCmdNs, t.peerFinalisedRxNs).c_str());
        }
        else
        {
            std::printf("  timing performer: SCHEDULE_START received %s ms before the local start, START_ACK sent "
                        "%s ms after receipt\n",
                        ms(t.scheduleRxNs, t.startAtLocalNs).c_str(), ms(t.scheduleRxNs, t.startAckSentNs).c_str());
        }
        std::printf("  first sample time (this PC's monotonic clock): %lld ns\n",
                    static_cast<long long>(t.localFirstSampleNs));
    }
    if (!s.lastError.empty())
    {
        std::printf("  last error: %s\n", s.lastError.c_str());
    }
}

void printChecks(const ControllerSnapshot& s, const char* who)
{
    std::printf("[%s] readiness, this PC:\n", who);
    for (const auto& c : s.localChecks)
    {
        std::printf("[%s]   [%s] %s: %s\n", who, c.ok ? "OK  " : "FAIL", readyItemLabel(c.item), c.detail.c_str());
    }
    std::printf("[%s] readiness, other PC (from its READY_STATUS):\n", who);
    for (const auto& c : s.peerChecks)
    {
        std::printf("[%s]   [%s] %s\n", who, c.ok ? "OK  " : "FAIL", readyItemLabel(c.item));
    }
    if (!s.notReadyReasons.empty())
    {
        std::printf("[%s]   not ready because:", who);
        for (const auto& r : s.notReadyReasons)
        {
            std::printf(" %s;", r.c_str());
        }
        std::printf("\n");
    }
}

constexpr double kPi = 3.14159265358979323846;

// Sleeps until `deadline`. On Windows, MinGW's std::this_thread::sleep_until stays at the 15.6 ms
// system tick even after timeBeginPeriod(1) (measured on the development PC: 10 ms deadlines
// arrived with p95 21 ms), so wait in Sleep(1) steps instead (about 1-2 ms each at 1 ms timer
// resolution).
void sleepUntilPrecise(std::chrono::steady_clock::time_point deadline)
{
#ifdef _WIN32
    while (std::chrono::steady_clock::now() < deadline)
    {
        Sleep(1);
    }
#else
    std::this_thread::sleep_until(deadline);
#endif
}

// Calls `tick` every 10 ms on its own thread, on absolute deadlines (no cumulative drift).
// TEST CLOCK: stands in for the capture and playback callbacks when no device is used.
class TenMsClock
{
public:
    explicit TenMsClock(std::function<void()> tick) : tick(std::move(tick))
    {
        thread = std::thread([this] {
            auto next = std::chrono::steady_clock::now();
            while (!stopRequested.load())
            {
                next += std::chrono::milliseconds(10);
                sleepUntilPrecise(next);
                this->tick();
            }
        });
    }
    ~TenMsClock()
    {
        stopRequested.store(true);
        thread.join();
    }
    TenMsClock(const TenMsClock&) = delete;
    TenMsClock& operator=(const TenMsClock&) = delete;

private:
    std::function<void()> tick;
    std::atomic<bool> stopRequested{false};
    std::thread thread;
};

struct LiveOptions
{
    bool enabled = false;
    bool oneWay = false;
    bool controlHint = true;
    uint16_t mediaPort = 0;
    std::string source = "auto";
    std::string sink = "null";
    std::string sourceWav;
    std::string reportPath;
    std::string conditions = "two processes on one PC (development PC)";
    LiveCodecSettings codec;
    LivePlayoutSettings playout;
    ImpairmentSettings sim;
};

unsigned long long u(uint64_t v)
{
    return static_cast<unsigned long long>(v);
}

// What the TEST CLOCK sends and what it plays, sample-aligned (same tick).
struct TestAudio
{
    std::mutex mutex;
    std::vector<float> sent;
    std::vector<float> heard;
};

bool saveWav(const std::string& path, const std::vector<float>& samples)
{
    WavWriter w;
    WavFormat f;
    f.sampleRate = 48000;
    f.channels = 1;
    return w.open(path, f) && w.writeFrames(samples.data(), samples.size()) && w.finalise();
}

void printLive(const char* who, const LiveEndpoint& ep)
{
    if (!ep.isRunning())
    {
        return;
    }
    const EndpointStats e = ep.stats();
    if (const OutgoingStream* out = ep.getOutgoing())
    {
        const auto o = out->stats();
        std::printf("[%s] OUT stream %u: %s | packets %llu, muted frames %llu, send errors %llu, tap gaps %llu fr, "
                    "backlog trims %llu fr, sim drop/dup/reorder %llu/%llu/%llu\n",
                    who, o.streamId, outgoingStatusText(o, e).c_str(), u(o.packetsSent), u(o.mutedFrames),
                    u(o.sendErrors), u(o.tapGapFrames), u(o.backlogTrimFrames), u(o.testDropped),
                    u(o.testDuplicated), u(o.testReordered));
        if (e.hasRemoteReport)
        {
            const auto& r = e.remoteReport;
            std::printf("[%s]   remote reports on it: received %llu, lost est %llu, late %u, dup %u, reordered %u, "
                        "jitter %.3f ms, buffer %u/%u, underruns %u, concealed %u\n",
                        who, u(r.received), u(r.lostEstimate), r.late, r.duplicates, r.reordered, r.jitterUs / 1000.0,
                        r.jbFill, r.jbTarget, r.underruns, r.concealed);
        }
    }
    if (const IncomingStream* in = ep.getIncoming())
    {
        const auto i = in->stats();
        std::printf("[%s] IN  stream %u: %s | received %llu, lost est %llu, dup %llu, reordered %llu, late %llu, "
                    "jitter %.3f ms, max gap %.1f ms, buffer %u/%u (max %u), underruns %llu, concealed %llu, catch-up %llu, "
                    "queue-full %llu, resyncs %llu\n",
                    who, i.streamId, incomingStatusText(i, e).c_str(), u(i.arrival.received),
                    u(i.arrival.lostEstimate), u(i.arrival.duplicates), u(i.arrival.reordered), u(i.jb.late),
                    i.arrival.jitterMs, i.arrival.maxGapMs, i.jbHeld, i.jbTarget, i.jbMaxHeld, u(i.jb.underruns),
                    u(i.concealed), u(i.jb.catchupFrames), u(i.queueFullDrops), u(i.jb.resyncs));
    }
    if (e.invalid.total() > 0 || e.testBlackholed > 0)
    {
        std::printf("[%s]   invalid %llu (wrong stream %llu), TEST blackholed %llu\n", who, u(e.invalid.total()),
                    u(e.invalid.wrongStream), u(e.testBlackholed));
    }
    std::fflush(stdout);
}

void printTransfers(const ControllerSnapshot& s, const char* who)
{
    if (s.transfers.empty())
    {
        std::printf("[%s] transfers: none\n", who);
    }
    for (const auto& v : s.transfers)
    {
        std::printf("[%s] TRANSFER take %u: %s | %llu/%llu bytes, %u/%u chunks of %u, connections %u, resumes %u "
                    "(last from chunk %u), chunk rejects %u, hash failures %u%s\n",
                    who, v.takeId, transferStateName(v.state), static_cast<unsigned long long>(v.bytesDone),
                    static_cast<unsigned long long>(v.bytesTotal), v.chunksDone, v.chunksTotal, v.chunkBytes,
                    v.connections, v.resumes, v.resumedFromChunk, v.chunkRejects, v.hashFailures,
                    v.alreadyVerified ? ", already verified (nothing rewritten)" : "");
        std::printf("[%s]   SHA-256 %s\n[%s]   file %s\n", who, v.sha256Hex.c_str(), who, v.file.c_str());
        if (s.role == Role::Producer && v.state == TransferState::Verified)
        {
            std::printf("[%s]   checked copy: %u Hz, %u ch, %u-bit float, %llu frames = %.3f s; frames vs TAKE_FINALISED: %s\n",
                        who, v.sampleRate, v.channels, v.bits, static_cast<unsigned long long>(v.frames), v.durationS,
                        v.framesVsReport.c_str());
        }
        if (s.role == Role::Performer && !v.sourceShaAfterHex.empty())
        {
            std::printf("[%s]   original after sending: SHA-256 %s -> %s\n", who, v.sourceShaAfterHex.c_str(),
                        v.sourceUnchanged ? "UNCHANGED" : "CHANGED");
        }
        std::printf("[%s]   %s\n", who, v.detail.c_str());
    }
    std::fflush(stdout);
}

}  // namespace

int main(int argc, char* argv[])
{
    if (argc < 2)
    {
        return usage();
    }
    std::string mode = argv[1];
    if (mode == "--interfaces")
    {
        std::string error;
        initSockets(error);
        for (const auto& i : listIpv4Interfaces())
        {
            std::printf("%-16s %-40s %s%s\n", i.address.c_str(), i.name.c_str(), i.loopback ? "loopback" : "",
                        i.privateLan ? "private LAN" : "");
        }
        return 0;
    }
    if (mode != "--producer" && mode != "--performer")
    {
        return usage();
    }
    const bool producer = mode == "--producer";
    std::string bind = "127.0.0.1";
    std::string host;
    uint16_t port = 52000;
    std::string code;
    std::string codeFile;
    bool useAudio = false;
    long device = -1;
    std::filesystem::path out = "rr_session_takes";
    std::string logPath;
    uint16_t testMajor = 0;
    uint32_t startLeadMs = 0;
    bool allowDelivery = false;     // performer: allow take copies to be sent (XFER-05)
    bool autoTransfer = false;      // producer: request each finalised performer take
    uint32_t xferChunk = 0;    // performer: transfer chunk size (0 = default 32768)
    uint32_t xferDrop = 0;     // TEST: cut the transfer connection after N chunks (once)
    int xferCorrupt = -1;           // TEST performer: damage chunk N after hashing (once)
    int xferCorruptWhole = -1;     // TEST performer: alter chunk N before hashing (once)
    bool xferWrongSession = false; // TEST performer: HELLO with another session id
    LiveOptions live;
    std::string script = producer ? "wait-ready; record; wait 3; stop; wait-state Ready 10; wait 1; quit"
                                  : "wait-ready 30; wait-closed";
    for (int i = 2; i < argc; ++i)
    {
        const std::string a = argv[i];
        auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : std::string(); };
        if (a == "--bind") bind = next();
        else if (a == "--host") host = next();
        else if (a == "--port") port = static_cast<uint16_t>(std::atoi(next().c_str()));
        else if (a == "--code") code = next();
        else if (a == "--code-file") codeFile = next();
        else if (a == "--audio") useAudio = true;
        else if (a == "--device") device = std::atol(next().c_str());
        else if (a == "--out") out = next();
        else if (a == "--log") logPath = next();
        else if (a == "--script") script = next();
        else if (a == "--test-protocol-major") testMajor = static_cast<uint16_t>(std::atoi(next().c_str()));
        else if (a == "--start-lead-ms") startLeadMs = static_cast<uint32_t>(std::atoi(next().c_str()));
        else if (a == "--allow-delivery") allowDelivery = true;
        else if (a == "--auto-transfer") autoTransfer = true;
        else if (a == "--xfer-chunk-bytes") xferChunk = static_cast<uint32_t>(std::atoi(next().c_str()));
        else if (a == "--xfer-drop-after") xferDrop = static_cast<uint32_t>(std::atoi(next().c_str()));
        else if (a == "--xfer-corrupt-chunk") xferCorrupt = std::atoi(next().c_str());
        else if (a == "--xfer-corrupt-whole") xferCorruptWhole = std::atoi(next().c_str());
        else if (a == "--xfer-wrong-session") xferWrongSession = true;
        else if (a == "--live") live.enabled = true;
        else if (a == "--one-way") live.oneWay = true;
        else if (a == "--no-control-hint") live.controlHint = false;
        else if (a == "--media-port") live.mediaPort = static_cast<uint16_t>(std::atoi(next().c_str()));
        else if (a == "--live-source") live.source = next();
        else if (a == "--live-sink") live.sink = next();
        else if (a == "--source-wav") live.sourceWav = next();
        else if (a == "--report") live.reportPath = next();
        else if (a == "--conditions") live.conditions = next();
        else if (a == "--live-gain-db") live.playout.gainDb = static_cast<float>(std::atof(next().c_str()));
        else if (a == "--jitter-frames") live.playout.targetFrames = static_cast<uint32_t>(std::atoi(next().c_str()));
        else if (a == "--frame-ms") live.codec.frameSamples = static_cast<uint32_t>(std::lround(std::atof(next().c_str()) * 48.0));
        else if (a == "--bitrate") live.codec.bitrateBps = static_cast<uint32_t>(std::atoi(next().c_str()));
        else if (a == "--application") live.codec.application = next() == "audio" ? OpusApplication::Audio
                                                                                   : OpusApplication::RestrictedLowDelay;
        else if (a == "--sim-loss") live.sim.lossPercent = std::atof(next().c_str());
        else if (a == "--sim-dup") live.sim.duplicatePercent = std::atof(next().c_str());
        else if (a == "--sim-reorder") live.sim.reorderPercent = std::atof(next().c_str());
        else if (a == "--sim-seed") live.sim.seed = static_cast<uint32_t>(std::atoi(next().c_str()));
        else if (a == "--sim-burst")
        {
            const auto parts = split(next(), ':');
            if (parts.size() != 2) return usage();
            live.sim.burstEvery = static_cast<uint32_t>(std::atoi(parts[0].c_str()));
            live.sim.burstLength = static_cast<uint32_t>(std::atoi(parts[1].c_str()));
        }
        else return usage();
    }
    if (!producer && host.empty())
    {
        return usage();
    }
    if (live.mediaPort == 0)
    {
        live.mediaPort = static_cast<uint16_t>(port + 1);
    }
    // Which streams this side has.
    const bool hasOut = live.enabled && (producer || !live.oneWay);
    const bool hasIn = live.enabled && (!producer || !live.oneWay);
    if (live.enabled)
    {
        std::string bad = validate(live.codec);
        if (bad.empty())
        {
            bad = validate(live.playout);
        }
        if (!bad.empty())
        {
            std::fprintf(stderr, "live settings: %s\n", bad.c_str());
            return 2;
        }
        if (live.source == "auto")
        {
            live.source = useAudio ? "mic" : "tone";
        }
        if (live.source == "mic" && !useAudio)
        {
            std::fprintf(stderr, "--live-source mic needs --audio (an open input device)\n");
            return 2;
        }
        if (live.source != "mic" && live.source != "tone" && live.source != "bursts" && live.source != "silence" &&
            live.source != "echo")
            {
            return usage();
        }
    }

    Logger logger;
    std::shared_ptr<JsonLinesFileSink> fileSink;
    if (!logPath.empty())
    {
        fileSink = std::make_shared<JsonLinesFileSink>(logPath);
        logger.addSink(fileSink);
    }
    logger.start();

    AppConfig app = AppConfig::defaultsFor(producer ? Role::Producer : Role::Performer);
    ControllerConfig cfg;
    cfg.role = app.role;
    cfg.timing = app.timing;
    cfg.appVersion = buildInfo().version + " (rr_session_probe)";
    cfg.displayName = producer ? "Probe producer" : "Probe performer";
    cfg.testProtocolMajor = testMajor;
    cfg.autoTransfer = autoTransfer;
    if (xferChunk != 0)
    {
        cfg.transferSender.chunkBytes = xferChunk;
    }
    const char* who = producer ? "producer" : "performer";

    std::unique_ptr<AudioEngine> engine;
    std::unique_ptr<RecorderPort> portImpl;
    const bool deviceSink = hasIn && live.sink == "device";
    size_t inputIndex = 0;
    size_t outputIndex = 0;
    if (useAudio || deviceSink)
    {
        engine = std::make_unique<AudioEngine>();
        std::string error;
        if (!engine->initialise(error))
        {
            std::fprintf(stderr, "audio: %s\n", error.c_str());
            return 1;
        }
    }
    if (deviceSink)
    {
        std::string error;
        const auto outputs = engine->playbackDevices(error);
        for (const auto& d : outputs)
        {
            if (d.isDefault)
            {
                outputIndex = d.index;
            }
        }
        if (outputs.empty() || !engine->openPlayback(outputIndex, PlaybackOptions{}, error))
        {
            std::fprintf(stderr, "audio output: %s\n", outputs.empty() ? "no output device" : error.c_str());
            return 1;
        }
        std::printf("[%s] live output: %s at %u Hz, gain %.1f dB. Use HEADPHONES (no echo cancellation).\n", who,
                    engine->playbackDescription().deviceName.c_str(), static_cast<unsigned>(engine->playbackRate()),
                    static_cast<double>(live.playout.gainDb));
    }
    if (useAudio)
    {
        std::string error;
        const auto devices = engine->captureDevices(error);
        for (const auto& d : devices)
        {
            if (d.isDefault)
            {
                inputIndex = d.index;
            }
        }
        if (device >= 0)
        {
            inputIndex = static_cast<size_t>(device);
        }
        if (!engine->openCapture(inputIndex, CaptureOptions{}, RecorderOptions{}, error))
        {
            std::fprintf(stderr, "audio: %s\n", error.c_str());
            return 1;
        }
        portImpl = std::make_unique<AudioRecorderPort>(*engine, out, app);
    }
    else
    {
        portImpl = std::make_unique<TestRecorderPort>();
    }

    SessionController controller(cfg, *portImpl, logger);
    if (startLeadMs != 0)
    {
        controller.setStartLeadMs(startLeadMs);
    }
    Probe probe{controller, 0, who, nullptr};

    // ---- live audio: started once the session is connected ----
    LiveEndpoint endpoint(&logger);
    LiveTap testTap;   // fed by the TEST CLOCK when the source is not the microphone
    TestAudio testAudio;
    std::unique_ptr<TenMsClock> clock;
    std::string sinkWav;
    bool sendOn = true;
    bool hearOn = true;
    bool muteOn = false;
    int64_t lastLivePrint = 0;
    const bool testSource = hasOut && live.source != "mic";
    const bool testSink = hasIn && !deviceSink;
    if (live.enabled)
    {
#ifdef _WIN32
        timeBeginPeriod(1);  // 1 ms sleep granularity for the 10 ms test clock
#endif
        if (live.sink.rfind("wav:", 0) == 0)
        {
            sinkWav = live.sink.substr(4);
        }
        const double hz = producer ? 440.0 : 660.0;
        if (hasOut)
        {
            if (live.source == "mic")
            {
                std::printf("[%s] live source: input device '%s'\n", who, engine->captureDescription().deviceName.c_str());
            }
            else
            {
                std::printf("[%s] live source: TEST %s%s (not a microphone)\n", who,
                            live.source == "echo"     ? "ECHO: sends back what this side hears (simulated speaker->mic)"
                            : live.source == "silence" ? "SILENCE"
                                                       : (live.source == "bursts" ? "BURSTS 50 ms / 500 ms of " : "TONE "),
                            (live.source == "tone" || live.source == "bursts")
                                ? (std::to_string(static_cast<int>(hz)) + " Hz at -20 dBFS").c_str()
                                : "");
            }
        }
        if (testSink)
        {
            std::printf("[%s] live sink: TEST PLAYBACK CLOCK (10 ms), %s\n", who,
                        sinkWav.empty() ? "output discarded" : ("output saved to " + sinkWav).c_str());
        }
        testTap.setSourceRate(48000);
        testAudio.sent.reserve(static_cast<size_t>(48000) * 120);   // at most 120 s are kept
        testAudio.heard.reserve(static_cast<size_t>(48000) * 120);
    }
    // One TEST CLOCK renders the incoming stream and then pushes the test source, so `sent` and
    // `heard` are sample-aligned (same tick = same time).
    auto clockTick = [&, phase = uint64_t{0}, hz = producer ? 440.0 : 660.0]() mutable {
        float heard[480] = {};
        if (testSink && endpoint.getIncoming() != nullptr)
        {
            endpoint.getIncoming()->renderAdd(heard, 480, 1, 48000);
        }
        float sent[480] = {};
        if (testSource)
        {
            for (size_t i = 0; i < 480; ++i)
            {
                const uint64_t n = phase + i;
                const bool on = live.source == "tone" || (live.source == "bursts" && (n % 24000) < 2400);
                sent[i] = on ? 0.1f * static_cast<float>(std::sin(2.0 * kPi * hz * static_cast<double>(n) / 48000.0)) : 0.0f;
                if (live.source == "echo")
                {
                    sent[i] = heard[i];
                }
            }
            testTap.pushCapture(sent, 480, 1);
        }
        phase += 480;
        std::lock_guard<std::mutex> lock(testAudio.mutex);
        if (testAudio.sent.size() + 480 <= testAudio.sent.capacity())
        {
            testAudio.sent.insert(testAudio.sent.end(), sent, sent + 480);
            testAudio.heard.insert(testAudio.heard.end(), heard, heard + 480);
        }
    };

    auto localCaptureStatus = [&]() -> std::string
    {
        if (!hasOut || live.source != "mic")
        {
            return std::string("TEST SOURCE '") + live.source + "' (no capture device for the live stream)" +
                   (engine && engine->captureOpen() ? "; input device open for recording" : "");
        }
        if (!engine || !engine->captureOpen())
        {
            return "input device CLOSED";
        }
        const auto& d = engine->captureDescription();
        const auto st = engine->ingest()->stats();
        return "running: " + d.deviceName + ", " + std::to_string(d.sampleRate) + " Hz, " + std::to_string(d.channels) +
               " ch, record-ring overruns " + std::to_string(st.overrunEvents) +
               (engine->captureFault() != DeviceFault::None ? ", DEVICE FAULT" : "");
    };
    auto localRecordingStatus = [&]() -> std::string
    {
        const auto s = controller.snapshot();
        std::string r = portImpl->description() + "; session state " + std::string(sessionStateName(s.session));
        if (s.take.takeId != 0)
        {
            r += "; take " + std::to_string(s.take.takeId) + " " +
                 (s.take.localFinalised ? std::string(takeStatusName(s.take.localStatus)) + ", " +
                                               std::to_string(s.take.localFrames) + " frames"
                                         : std::string(s.take.localStarted ? "RECORDING" : "not started"));
        }
        return r;
    };
    auto remoteStatus = [&]() -> std::string
    {
        const auto s = controller.snapshot();
        char rtt[64];
        std::snprintf(rtt, sizeof rtt, "%.3f", static_cast<double>(s.linkStats.controlRttNs) / 1e6);
        return "'" + s.peerName + "' at " + s.peerAddress + ", control link " +
               std::string(linkStateName(s.link)) + ", control RTT " + rtt + " ms";
    };
    auto writeReport = [&](const std::string& path)
    {
        if (!endpoint.isRunning())
        {
            std::printf("[%s] no live report: live media not running\n", who);
            return;
        }
        LiveReportConditions c;
        c.generatedUtc = formatUtcIso8601Ms(utcNowMs());
        c.role = producer ? "Producer (rr_session_probe)" : "Performer (rr_session_probe)";
        c.appVersion = buildInfo().version;
        c.sessionId = controller.snapshot().sessionId;
        c.captureDevice = (hasOut && live.source == "mic") ? engine->captureDescription().deviceName
                                                             : "TEST SOURCE " + live.source;
        c.captureRate = (hasOut && live.source == "mic") ? engine->captureDescription().sampleRate : 48000;
        c.outputDevice = deviceSink ? engine->playbackDescription().deviceName : "TEST PLAYBACK CLOCK";
        c.outputRate = deviceSink ? engine->playbackRate() : 48000;
        c.localCaptureStatus = localCaptureStatus();
        c.localRecordingStatus = localRecordingStatus();
        c.remoteParticipantStatus = remoteStatus();
        c.testConditions = live.conditions + (live.sim.active() ? "; TEST impairment on this side's outgoing stream" : "");
        c.headphones = "not applicable (probe)";
        std::ofstream(path) << liveReportText(c, endpoint);
        std::printf("[%s] live report written: %s\n", who, path.c_str());
    };

    uint32_t mediaSession = 0;
    uint32_t countdownShownFor = 0;
    probe.onPump = [&]()
    {
        // Stage 9: a visible countdown and the scheduled time once a start is agreed.
        const auto st = controller.snapshot();
        if (st.session == SessionState::Scheduled && st.take.startAtLocalNs != 0 &&
            countdownShownFor != st.take.takeId)
            {
            countdownShownFor = st.take.takeId;
            const int64_t left = st.take.startAtLocalNs - monotonicNs();
            std::printf("[%s] SCHEDULED take %u: recording starts in %lld ms, at about %s (this PC's clock); "
                        "controlled by '%s'\n",
                        who, st.take.takeId, static_cast<long long>(left / 1000000),
                        formatUtcIso8601Ms(utcNowMs() + left / 1000000).c_str(),
                        producer ? "this PC (producer)" : st.peerName.c_str());
        }
        if (!live.enabled)
        {
            return;
        }
        const auto snap = controller.snapshot();
        endpoint.setControlLinkUp(live.controlHint && snap.link == LinkState::Connected);
        if (snap.link == LinkState::Connected && mediaSession == 0 &&
            sessionIdToU32(snap.sessionId, mediaSession))
            {
            LiveEndpointConfig c;
            c.bindMode = producer;
            c.localAddress = bind;
            c.peerAddress = producer ? snap.peerAddress : host;
            c.mediaPort = live.mediaPort;
            c.sessionId = mediaSession;
            c.hasOutgoing = hasOut;
            c.outgoing.streamId = producer ? kStreamProducerMic : kStreamPerformerMic;
            c.outgoing.codec = live.codec;
            c.outgoing.testImpairment = live.sim;
            c.hasIncoming = hasIn;
            c.incoming.streamId = producer ? kStreamPerformerMic : kStreamProducerMic;
            c.incoming.playout = live.playout;
            LiveTap* tap = hasOut ? (live.source == "mic" ? &engine->liveTap() : &testTap) : nullptr;
            std::string error;
            if (!endpoint.start(c, tap, error))
            {
                std::printf("[%s] LIVE MEDIA FAILED: %s\n", who, error.c_str());
            }
            else
            {
                if (endpoint.getOutgoing())
                {
                    endpoint.getOutgoing()->setEnabled(sendOn);
                    endpoint.getOutgoing()->setMuted(muteOn);
                }
                if (endpoint.getIncoming())
                {
                    endpoint.getIncoming()->setOutputEnabled(hearOn);
                    if (deviceSink)
                    {
                        engine->attachPlaybackContributor(endpoint.getIncoming());
                    }
                }
                if (testSource || testSink)
                {
                    clock = std::make_unique<TenMsClock>(clockTick);
                }
                std::printf("[%s] live media on UDP %s: out %s, in %s%s\n", who, endpoint.stats().localEndpoint.c_str(),
                            hasOut ? (producer ? "stream 1" : "stream 2") : "none",
                            hasIn ? (producer ? "stream 2" : "stream 1") : "none",
                            live.sim.active() ? "  ** TEST IMPAIRMENT ON (outgoing) **" : "");
            }
        }
        const int64_t now = monotonicNs();
        if (now - lastLivePrint > 2000000000ll)
        {
            lastLivePrint = now;
            printLive(who, endpoint);
        }
    };
    std::printf("[%s] recorder: %s\n", who, portImpl->description().c_str());
    std::string error;
    if (producer)
    {
        if (!controller.createSession(bind, port, error))
        {
            std::fprintf(stderr, "[producer] %s\n", error.c_str());
            return 1;
        }
        const std::string pairing = controller.snapshot().pairingCode;
        std::printf("[producer] session %s on %s:%u  PAIRING CODE %s (shown to the user only; never logged)\n",
                    controller.snapshot().sessionId.c_str(), bind.c_str(), static_cast<unsigned>(port), pairing.c_str());
        if (!codeFile.empty())
        {
            std::ofstream(codeFile) << pairing;
        }
    }
    else
    {
        if (code.empty() && !codeFile.empty())
        {
            // Wait up to 10 s for the producer to write the file (two-process tests).
            for (int i = 0; i < 1000 && code.empty(); ++i)
            {
                std::ifstream in(codeFile);
                std::getline(in, code);
                code = trim(code);
                if (code.size() != 6)
                {
                    code.clear();
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                }
            }
        }
        if (!controller.join(host, port, code, error))
        {
            std::fprintf(stderr, "[performer] %s\n", error.c_str());
            return 1;
        }
        controller.setDeliveryConsent(allowDelivery);
        if (TakeSender* tx = controller.transferSender())
        {
            if (xferDrop != 0) tx->testDropAfterChunks(xferDrop);
            if (xferCorrupt >= 0) tx->testCorruptChunk(static_cast<uint32_t>(xferCorrupt));
            if (xferCorruptWhole >= 0) tx->testCorruptConsistent(static_cast<uint32_t>(xferCorruptWhole), false);
            if (xferWrongSession) tx->testOverrideHello("deadbeef", "");
        }
    }
    controller.setConsent(true);

    int rc = 0;
    for (std::string step : split(script, ';'))
    {
        step = trim(step);
        if (step.empty())
        {
            continue;
        }
        std::printf("[%s] > %s\n", who, step.c_str());
        std::istringstream in(step);
        std::string cmd;
        in >> cmd;
        bool ok = true;
        if (cmd == "wait")
        {
            double s = 1;
            in >> s;
            probe.runFor(s);
        }
        else if (cmd == "wait-ready")
        {
            double s = 20;
            in >> s;
            ok = probe.until([&] { return controller.snapshot().session == SessionState::Ready; }, s);
        }
        else if (cmd == "wait-state" || cmd == "wait-link")
        {
            std::string name;
            double s = 20;
            in >> name >> s;
            ok = probe.until(
                [&] {
                    const auto snap = controller.snapshot();
                    return cmd == "wait-state" ? std::string(sessionStateName(snap.session)) == name
                                               : std::string(linkStateName(snap.link)) == name;
                },
                s);
        }
        else if (cmd == "wait-closed")
        {
            ok = probe.until(
                [&] {
                    const auto snap = controller.snapshot();
                    return snap.link == LinkState::Disconnected;
                },
                600);
        }
        else if (cmd == "record")
        {
            ok = controller.startTake(error);
        }
        else if (cmd == "stop")
        {
            ok = probe.until([&] { return controller.snapshot().session == SessionState::Recording; }, 5) &&
                 controller.stopTake(error);
        }
        else if (cmd == "stop-now")
        {
            ok = controller.stopTake(error);
        }
        else if (cmd == "checks")
        {
            printChecks(controller.snapshot(), who);
        }
        else if (cmd == "stop-and-save")
        {
            ok = controller.stopAndSave(error);
        }
        else if (cmd == "drop-link")
        {
            if (controller.getLink())
            {
                controller.getLink()->testDropConnection();
            }
        }
        else if (cmd == "consent")
        {
            std::string v;
            in >> v;
            controller.setConsent(v == "on");
        }
        else if (cmd == "live" || cmd == "mute" || cmd == "hear" || cmd == "blackhole")
        {
            std::string v;
            in >> v;
            const bool on = v == "on";
            if (cmd == "live")
            {
                sendOn = on;
                if (endpoint.getOutgoing()) endpoint.getOutgoing()->setEnabled(on);
            }
            else if (cmd == "mute")
            {
                muteOn = on;
                if (endpoint.getOutgoing()) endpoint.getOutgoing()->setMuted(on);
            }
            else if (cmd == "hear")
            {
                hearOn = on;
                if (endpoint.getIncoming()) endpoint.getIncoming()->setOutputEnabled(on);
            }
            else
            {
                endpoint.setTestReceiveBlackhole(on);
            }
        }
        else if (cmd == "reopen-input")
        {
            ok = engine && engine->captureOpen() &&
                 engine->openCapture(inputIndex, CaptureOptions{}, RecorderOptions{}, error);
            if (!engine) error = "needs --audio";
        }
        else if (cmd == "reopen-output")
        {
            ok = engine && deviceSink && engine->openPlayback(outputIndex, PlaybackOptions{}, error);
            if (!deviceSink) error = "needs --live-sink device";
        }
        else if (cmd == "live-stats")
        {
            printLive(who, endpoint);
            std::printf("[%s] STATUS local capture: %s\n[%s] STATUS local recording: %s\n[%s] STATUS remote participant: %s\n",
                        who, localCaptureStatus().c_str(), who, localRecordingStatus().c_str(), who,
                        remoteStatus().c_str());
        }
        else if (cmd == "live-report")
        {
            std::string path;
            in >> path;
            writeReport(path);
        }
        else if (cmd == "transfer")
        {
            unsigned take = 0;
            in >> take;
            ok = controller.requestTransfer(take, error);
            if (ok && xferDrop != 0 && controller.transferReceiver())
            {
                controller.transferReceiver()->testDropAfterChunks(xferDrop);  // TEST (producer side)
                xferDrop = 0;
            }
        }
        else if (cmd == "cancel-transfer")
        {
            unsigned take = 0;
            in >> take;
            controller.cancelTransfer(take);
        }
        else if (cmd == "wait-transfer")
        {
            // wait-transfer <take> <seconds> [VERIFIED|FAILED]: fails unless it ends in the expected state.
            unsigned take = 0;
            double s = 60;
            std::string expect = "VERIFIED";
            in >> take >> s >> expect;
            auto findView = [&]() -> std::optional<TransferView>
            {
                for (const auto& v : controller.snapshot().transfers)
                {
                    if (v.takeId == take) return v;
                }
                return std::nullopt;
            };
            ok = probe.until([&] {
                const auto v = findView();
                return v && transferStateFinal(v->state);
            }, s);
            const auto v = findView();
            if (ok && v && std::string(transferStateName(v->state)) != expect)
            {
                ok = false;
                error = std::string("ended ") + transferStateName(v->state) + ", expected " + expect;
            }
            printTransfers(controller.snapshot(), who);
        }
        else if (cmd == "transfers")
        {
            printTransfers(controller.snapshot(), who);
        }
        else if (cmd == "delivery")
        {
            std::string v;
            in >> v;
            controller.setDeliveryConsent(v == "on");
        }
        else if (cmd == "leave")
        {
            controller.leave();
        }
        else if (cmd == "quit")
        {
            break;
        }
        else
        {
            std::printf("[%s] unknown command '%s'\n", who, cmd.c_str());
            ok = false;
        }
        if (!ok)
        {
            std::printf("[%s] STEP FAILED: %s %s\n", who, step.c_str(), error.c_str());
            rc = 1;
            break;
        }
    }
    probe.pump();
    printSummary(controller.snapshot(), who);
    if (!controller.snapshot().transfers.empty())
    {
        printTransfers(controller.snapshot(), who);  // Stage 11
    }
    if (live.enabled)
    {
        std::printf("\n[%s] LIVE SUMMARY (live monitor streams only; the master recordings are separate files)\n", who);
        printLive(who, endpoint);
        if (!live.reportPath.empty())
        {
            writeReport(live.reportPath);
        }
    }
    // Live teardown: stop the test clock and detach from the device before the endpoint stops.
    clock.reset();
    if (engine)
    {
        engine->detachPlaybackContributor();
    }
    endpoint.stop();
    {
        std::lock_guard<std::mutex> lock(testAudio.mutex);
        if (!sinkWav.empty())
        {
            std::printf("[%s] live sink %s: %s (%zu frames; TEST PLAYBACK CLOCK output, not a recording)\n", who,
                        saveWav(sinkWav, testAudio.heard) ? "saved" : "NOT SAVED", sinkWav.c_str(),
                        testAudio.heard.size());
        }
        if (!live.sourceWav.empty())
        {
            std::printf("[%s] test source %s: %s (%zu frames, aligned with the sink)\n", who,
                        saveWav(live.sourceWav, testAudio.sent) ? "saved" : "NOT SAVED", live.sourceWav.c_str(),
                        testAudio.sent.size());
        }
    }
#ifdef _WIN32
    if (live.enabled)
    {
        timeEndPeriod(1);
    }
#endif
    controller.shutdown();
    if (engine)
    {
        engine->closeCapture();
    }
    logger.stop();
    return rc;
}
