#pragma once

// What the session controller needs from "the thing that records locally". Two implementations:
//  - AudioRecorderPort: the real capture engine (Stage 4/5), takes written as WAV;
//  - TestRecorderPort:  "TEST RECORDER (no audio)": simulates start/stop timing, writes nothing.
// All calls happen on the controller's thread.

#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "rr/control/Readiness.h"
#include "rr/shared/Config.h"
#include "rr/shared/ErrorCodes.h"
#include "rr/shared/Role.h"

class AudioEngine;

struct LocalReadiness
{
    bool ok = false;
    std::vector<std::string> reasons;      // why not ready (empty when ok)
    std::vector<ReadinessCheck> checks;    // every device-side item, passing ones included (Stage 9)
};

struct PortTakeSpec
{
    uint32_t takeId = 0;
    std::string sessionId;
    Role role = Role::Producer;
    uint32_t maxTakeSeconds = 1800;
    int64_t startAtNs = 0;  // local monotonic time of the first sample
};

enum class PortEventKind { Started, Finalised };

struct PortEvent
{
    PortEventKind kind = PortEventKind::Started;
    uint32_t takeId = 0;
    int64_t eventNs = 0;  // local monotonic time the controller saw the event
    /** Started */
    uint64_t firstFrame = 0;
    uint32_t devicePeriodFrames = 0;  // device timing information available at the start
    uint32_t devicePeriods = 0;
    int64_t firstSampleNs = 0;
    uint64_t lateFrames = 0;
    /** Finalised */
    TakeStatus status = TakeStatus::Complete;
    bool finalised = false;
    uint64_t frames = 0;
    uint32_t sampleRate = 0;
    std::string stopReason;
    std::string error;
    std::string file;  // full path of the WAV (or .partial) for display
};

class RecorderPort
{
public:
    virtual ~RecorderPort() = default;
    virtual LocalReadiness readiness() = 0;
    virtual bool scheduleTake(const PortTakeSpec& spec, std::string& error) = 0;
    /** stopAtNs = 0: stop now. `remote` = the producer asked for it. */
    virtual void scheduleStop(int64_t stopAtNs, bool remote) = 0;
    virtual void cancelTake() = 0;  // only before the take started
    virtual std::vector<PortEvent> poll() = 0;
    virtual std::string description() const = 0;
    /**
     * Folder of the current session's takes on this PC (empty if none yet). Stage 11: the
     * producer keeps verified copies of the performer's takes in "<this>/from_performer".
     */
    virtual std::filesystem::path sessionFolder() const { return {}; }
};

/**
 * Real recording through the audio engine. Takes go to
 * <recordingsRoot>/<YYYYMMDD-HHMMSS>_<session id>/take<NN>_<role>_<session id>.wav, where the
 * session id is the one shared by both PCs (VER-02) and NN is the control take id.
 */
class AudioRecorderPort final : public RecorderPort
{
public:
    AudioRecorderPort(AudioEngine& engine, std::filesystem::path recordingsRoot, AppConfig config);
    LocalReadiness readiness() override;
    bool scheduleTake(const PortTakeSpec& spec, std::string& error) override;
    void scheduleStop(int64_t stopAtNs, bool remote) override;
    void cancelTake() override;
    std::vector<PortEvent> poll() override;
    std::string description() const override;

    void setRecordingsRoot(std::filesystem::path dir) { root = std::move(dir); }
    std::filesystem::path currentSessionDir() const { return sessionDir; }
    std::filesystem::path sessionFolder() const override { return sessionDir; }

private:
    AudioEngine& engine;
    std::filesystem::path root;
    AppConfig config;
    std::string sessionId;
    std::filesystem::path sessionDir;
};

/**
 * No audio: "starts" when its clock reaches the scheduled time, counts frames at a nominal
 * 48 kHz, "finalises" on stop. Clearly labelled; used by the CLI two-instance test and unit tests.
 */
class TestRecorderPort final : public RecorderPort
{
public:
    LocalReadiness readiness() override;
    bool scheduleTake(const PortTakeSpec& spec, std::string& error) override;
    void scheduleStop(int64_t stopAtNs, bool remote) override;
    void cancelTake() override;
    std::vector<PortEvent> poll() override;
    std::string description() const override { return "TEST RECORDER (no audio, nothing is written)"; }

    /** Test hooks. */
    void setReady(bool ready, const std::string& reason = "test: not ready");
    void failNextSchedule(const std::string& error) { failNext = error; }
    void simulateFault() { fault = true; }
    /**
     * TEST ONLY: called when a take finalises; returns the path of a file the test wrote for it
     * (the test recorder itself never writes anything). Used by the Stage 11 transfer tests.
     */
    void testReportFile(std::function<std::filesystem::path(uint32_t take, uint64_t frames)> f)
    {
        reportFile = std::move(f);
    }

private:
    bool ready = true;
    std::string notReadyReason;
    std::string failNext;
    bool fault = false;
    bool active = false;
    bool started = false;
    bool stopping = false;
    bool remoteStop = false;
    PortTakeSpec spec;
    int64_t stopAtNs = 0;
    std::vector<PortEvent> events;
    std::function<std::filesystem::path(uint32_t, uint64_t)> reportFile;
};

