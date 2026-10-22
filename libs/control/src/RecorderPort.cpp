#include "rr/control/RecorderPort.h"

#include <fstream>
#include <system_error>

#include "rr/audio/AudioEngine.h"
#include "rr/audio/FileIo.h"
#include "rr/audio/TakeNaming.h"
#include "rr/shared/BuildInfo.h"
#include "rr/shared/Clock.h"

// ---------------------------------------------------------------------------------------------
AudioRecorderPort::AudioRecorderPort(AudioEngine& engine, std::filesystem::path recordingsRoot,
                                     AppConfig config)
    : engine(engine), root(std::move(recordingsRoot)), config(config) {}

LocalReadiness AudioRecorderPort::readiness()
{
    LocalReadiness r;
    auto add = [&r](ReadyItem item, bool ok, std::string detail)
    {
        r.checks.push_back(ReadinessCheck{item, ok, true, detail});
        if (!ok)
        {
            r.reasons.push_back(std::string(readyItemLabel(item)) + ": " + detail);
        }
    };
    const bool open = engine.captureOpen();
    add(ReadyItem::InputDevice, open, open ? engine.captureDescription().deviceName : "no input device open");

    // Healthy: callbacks arrived within the last 500 ms, no device fault, required rate.
    std::string engineDetail;
    bool engineOk = false;
    if (!open)
    {
        engineDetail = "no input device";
    }
    else
    {
        const auto& d = engine.captureDescription();
        const IngestStats st = engine.ingest()->stats();
        const int64_t ageNs = st.lastCallbackNs == 0 ? -1 : monotonicNs() - st.lastCallbackNs;
        if (engine.captureFault() != DeviceFault::None)
        {
            engineDetail = "device fault (stopped or rerouted)";
        }
        else if (ageNs < 0 || ageNs > 500'000'000)
        {
            engineDetail = "no capture callbacks in the last 500 ms";
        }
        else if (d.sampleRate != config.audio.requiredSampleRateHz)
        {
            engineDetail = "input at " + std::to_string(d.sampleRate) + " Hz, " +
                            std::to_string(config.audio.requiredSampleRateHz) + " Hz required";
        }
        else
        {
            engineOk = true;
            engineDetail = std::to_string(d.sampleRate) + " Hz, " + std::to_string(d.channels) + " ch, last callback " +
                            std::to_string(ageNs / 1'000'000) + " ms ago, record-ring overruns " +
                            std::to_string(st.overrunEvents);
        }
    }
    add(ReadyItem::EngineHealthy, engineOk, engineDetail);

    // Writable: create the folder and write + delete a small probe file.
    std::error_code ec;
    std::filesystem::create_directories(root, ec);
    const std::filesystem::path probe = root / ".rr_write_test";
    bool writable = false;
    {
        std::ofstream out(probe, std::ios::binary | std::ios::trunc);
        out << "rr";
        writable = static_cast<bool>(out);
    }
    std::filesystem::remove(probe, ec);
    add(ReadyItem::FolderWritable, writable,
        (writable ? "" : "cannot write in ") + pathToUtf8(root));

    // Disk policy: the longest allowed take at the device format (48 kHz stereo if no device) + 1 MB.
    const uint64_t rate = open ? engine.captureDescription().sampleRate : 48000;
    const uint64_t channels = open ? engine.captureDescription().channels : 2;
    const uint64_t needed = static_cast<uint64_t>(config.timing.maxTakeSeconds) * rate * channels * 4ULL +
                                 (1ULL << 20);
    const uint64_t freeBytes = availableDiskBytes(root);
    add(ReadyItem::DiskSpace, freeBytes >= needed,
        std::to_string(freeBytes >> 20) + " MB free, " + std::to_string(needed >> 20) + " MB needed for " +
            std::to_string(config.timing.maxTakeSeconds) + " s");

    const bool active = open && engine.recorder() != nullptr &&
                        engine.recorder()->status().state != RecorderState::Idle;
    add(ReadyItem::NoActiveRecording, !active, active ? "a local take is still active" : "idle");
    r.ok = r.reasons.empty();
    return r;
}

bool AudioRecorderPort::scheduleTake(const PortTakeSpec& spec, std::string& error)
{
    TakeRecorder* rec = engine.recorder();
    if (rec == nullptr)
    {
        error = "input device not open";
        return false;
    }
    if (spec.sessionId != sessionId || sessionDir.empty())
    {
        sessionId = spec.sessionId;
        sessionDir = root / sessionFolderName(utcNowMs(), spec.sessionId);
    }
    std::error_code ec;
    std::filesystem::create_directories(sessionDir, ec);
    if (ec)
    {
        error = "cannot create " + pathToUtf8(sessionDir) + ": " + ec.message();
        return false;
    }
    TakeRequest r;
    r.sessionDir = sessionDir;
    r.takeNumber = spec.takeId;
    r.role = spec.role;
    r.sessionId = spec.sessionId;
    r.appVersion = buildInfo().version + " (" + buildInfo().gitCommit + ")";
    r.maxTakeSeconds = spec.maxTakeSeconds;
    r.capture = engine.captureDescription();
    r.startAtNs = spec.startAtNs;
    return rec->beginTake(r, error);
}

void AudioRecorderPort::scheduleStop(int64_t stopAtNs, bool remote)
{
    if (TakeRecorder* rec = engine.recorder())
    {
        rec->endTake(remote ? StopReason::Remote : StopReason::User, stopAtNs);
    }
}

void AudioRecorderPort::cancelTake()
{
    if (TakeRecorder* rec = engine.recorder())
    {
        rec->cancelTake();
    }
}

std::vector<PortEvent> AudioRecorderPort::poll()
{
    std::vector<PortEvent> out;
    TakeRecorder* rec = engine.recorder();
    if (rec == nullptr)
    {
        return out;
    }
    for (const auto& s : rec->takeStarted())
    {
        PortEvent e;
        e.kind = PortEventKind::Started;
        e.takeId = s.takeNumber;
        e.firstFrame = s.firstFrame;
        e.firstSampleNs = s.firstSampleNs;
        e.lateFrames = s.lateFrames;
        e.devicePeriodFrames = engine.captureDescription().devicePeriodFrames;
        e.devicePeriods = engine.captureDescription().devicePeriods;
        out.push_back(e);
    }
    for (const auto& m : rec->takeFinished())
    {
        PortEvent e;
        e.kind = PortEventKind::Finalised;
        e.takeId = m.takeNumber;
        e.status = m.status;
        e.finalised = m.finalised;
        e.frames = m.frames;
        e.sampleRate = m.sampleRate;
        e.stopReason = m.stopReason;
        e.error = m.error;
        e.file = pathToUtf8(sessionDir / (m.finalised ? m.fileName : m.partialFileName));
        out.push_back(e);
    }
    return out;
}

std::string AudioRecorderPort::description() const
{
    return engine.captureOpen() ? "audio input: " + engine.captureDescription().deviceName
                                  : "audio input: (closed)";
}

// ---------------------------------------------------------------------------------------------
void TestRecorderPort::setReady(bool isReady, const std::string& reason)
{
    ready = isReady;
    notReadyReason = reason;
}

LocalReadiness TestRecorderPort::readiness()
{
    LocalReadiness r;
    // TEST RECORDER: the device-side items are simulated (labelled in the detail text).
    r.checks.push_back(ReadinessCheck{ReadyItem::InputDevice, ready, true, ready ? "TEST RECORDER" : notReadyReason});
    r.checks.push_back(ReadinessCheck{ReadyItem::EngineHealthy, true, true, "TEST RECORDER"});
    r.checks.push_back(ReadinessCheck{ReadyItem::FolderWritable, true, true, "TEST RECORDER (nothing is written)"});
    r.checks.push_back(ReadinessCheck{ReadyItem::DiskSpace, true, true, "TEST RECORDER (nothing is written)"});
    r.checks.push_back(ReadinessCheck{ReadyItem::NoActiveRecording, !active, true, active ? "a local take is still active" : "idle"});
    if (!ready)
    {
        r.reasons.push_back(notReadyReason);
    }
    if (active)
    {
        r.reasons.emplace_back("a local take is still active");
    }
    r.ok = r.reasons.empty();
    return r;
}

bool TestRecorderPort::scheduleTake(const PortTakeSpec& takeSpec, std::string& error)
{
    if (!failNext.empty())
    {
        error = failNext;
        failNext.clear();
        return false;
    }
    if (active)
    {
        error = "a take is already active";
        return false;
    }
    spec = takeSpec;
    active = true;
    started = false;
    stopping = false;
    fault = false;
    return true;
}

void TestRecorderPort::scheduleStop(int64_t atNs, bool remote)
{
    if (!active)
    {
        return;
    }
    stopping = true;
    remoteStop = remote;
    stopAtNs = atNs == 0 ? monotonicNs() : atNs;
}

void TestRecorderPort::cancelTake()
{
    if (active && !started)
    {
        active = false;
        PortEvent e;
        e.kind = PortEventKind::Finalised;
        e.takeId = spec.takeId;
        e.status = TakeStatus::Cancelled;
        e.stopReason = "cancelled";
        events.push_back(e);
    }
}

std::vector<PortEvent> TestRecorderPort::poll()
{
    const int64_t now = monotonicNs();
    if (active && !started && now >= spec.startAtNs)
    {
        started = true;
        PortEvent e;
        e.kind = PortEventKind::Started;
        e.takeId = spec.takeId;
        e.firstFrame = 0;
        e.firstSampleNs = spec.startAtNs;
        e.lateFrames = static_cast<uint64_t>((now - spec.startAtNs) > 50'000'000 ? (now - spec.startAtNs) * 48 / 1'000'000 : 0);
        events.push_back(e);
    }
    if (active && started && (fault || (stopping && now >= stopAtNs)))
    {
        const int64_t end = fault ? now : stopAtNs;
        PortEvent e;
        e.kind = PortEventKind::Finalised;
        e.takeId = spec.takeId;
        e.status = fault ? TakeStatus::IncompleteDevice : TakeStatus::Complete;
        e.finalised = true;
        e.frames = static_cast<uint64_t>((end - spec.startAtNs) * 48 / 1'000'000);
        e.sampleRate = 48000;
        e.stopReason = fault ? "device_lost" : (remoteStop ? "producer_stop" : "user");
        e.error = fault ? "test: simulated device fault" : "";
        e.file = "(test recorder: no file)";
        if (reportFile)
        {
            e.file = pathToUtf8(reportFile(e.takeId, e.frames));
        }
        events.push_back(e);
        active = false;
        fault = false;
    }
    std::vector<PortEvent> out;
    out.swap(events);
    return out;
}

