#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rr/audio/CaptureIngest.h"
#include "rr/audio/FileIo.h"
#include "rr/audio/TakeMetadata.h"
#include "rr/audio/WavWriter.h"

enum class StopReason : uint8_t { User, Shutdown, SafetyLimit, DeviceLost, DiskError, Remote };
const char* stopReasonName(StopReason reason) noexcept;

enum class RecorderState : uint8_t
{
    Idle,        // no take
    Starting,    // file created, waiting for the worker to take over (immediate start)
    Scheduled,   // file created, waiting for the scheduled start time
    Recording,
    Finalising,
};
const char* recorderStateName(RecorderState state) noexcept;

struct TakeRequest
{
    std::filesystem::path sessionDir;
    uint32_t takeNumber = 0;
    Role role = Role::Producer;
    std::string sessionId;
    std::string appVersion;
    uint32_t maxTakeSeconds = 1800;
    CaptureDescription capture;
    /**
     * Local monotonic time (monotonicNs) of the first sample; 0 = start now.
     * Must lie within the next 30 s.
     */
    int64_t startAtNs = 0;
};

struct RecorderOptions
{
    FileOpener opener = defaultFileOpener();
    std::chrono::milliseconds pollInterval{10};
    std::chrono::milliseconds headerRefreshInterval{5000};
    std::chrono::milliseconds deviceStallTimeout{500};
};

struct RecorderStatus
{
    RecorderState state = RecorderState::Idle;
    uint32_t takeNumber = 0;
    uint64_t framesWritten = 0;
    bool hasGaps = false;
};

/**
 * Reported once per take when its first sample has been written (or, for a late scheduled start,
 * when the start was resolved).
 */
struct TakeStartInfo
{
    uint32_t takeNumber = 0;
    uint64_t firstFrame = 0;        // capture frame index of the first written sample
    int64_t firstSampleNs = 0;     // estimated local monotonic time of that sample
    int64_t scheduledStartNs = 0;  // 0 = immediate
    uint64_t lateFrames = 0;        // > 0: the scheduled start was missed by this much
};

/**
 * The dedicated recording worker (THREADING_AND_AUDIO_CALLBACKS.md §7). It drains the capture
 * ring continuously into a frame-indexed holding buffer (inserting silence for dropped blocks and
 * recording where), keeps ~1.5 s of recent audio while a scheduled start is pending, maps
 * scheduled start/stop times to exact capture frames using the callback stamps (ADR-010), writes
 * the take, watches for device faults and disk errors, and finalises. All recording file I/O
 * happens on this thread except the initial exclusive file creation in beginTake (caller's
 * thread, so errors are reported immediately). Nothing here runs on the audio thread.
 */
class TakeRecorder
{
public:
    TakeRecorder(CaptureIngest& ingest, RecorderOptions options = {});
    ~TakeRecorder();  // calls stop()
    TakeRecorder(const TakeRecorder&) = delete;
    TakeRecorder& operator=(const TakeRecorder&) = delete;

    void start();
    /**
     * Finalises an active take with StopReason::Shutdown (a not-yet-started scheduled take is
     * cancelled), then joins the worker.
     */
    void stop();

    bool beginTake(const TakeRequest& request, std::string& error);
    /**
     * Ends the active take. stopAtNs = 0: at the newest captured frame; otherwise at the frame
     * captured at that local monotonic time (must be within the next 30 s).
     */
    void endTake(StopReason reason = StopReason::User, int64_t stopAtNs = 0);
    /**
     * Abandons a take that has not started yet (status `cancelled`, the empty file is removed).
     * Ignored once the take has started.
     */
    void cancelTake();

    RecorderStatus status() const noexcept;
    std::vector<TakeMetadata> takeFinished();  // results not yet collected, oldest first
    std::vector<TakeStartInfo> takeStarted();  // start reports not yet collected

    /**
     * Test hook (TST-01c): the worker sleeps for `duration` before its next drain, so the capture
     * ring overflows exactly as it would on a stalled disk.
     */
    void injectStall(std::chrono::milliseconds duration);

private:
    struct Command;
    struct ActiveTake;

    void workerLoop();
    void drain();
    void processActive();
    void checkFaults();
    void finish(StopReason reason);
    void cancelPending();
    void trimPendingToPreroll();
    void writePendingUntil(uint64_t endFrame);
    /** Signed: a negative frame means the time lies before the first captured sample. */
    bool frameForTime(int64_t tNs, int64_t& frame, int64_t& stampTime, bool requireAfter) const;

    /** Holding buffer of drained frames, indexed by absolute capture frame. */
    void pendAppend(const float* samples, uint64_t frames);
    void pendAppendSilence(uint64_t frames);
    void pendDropBefore(uint64_t frame);
    uint64_t pendEnd() const noexcept { return pendFirst + pendFrames; }

    CaptureIngest& ingest;
    RecorderOptions options;
    const uint32_t channels;
    const uint32_t rate;

    std::mutex mutex;
    std::condition_variable wake;
    std::deque<std::unique_ptr<Command>> commands;
    bool stopRequested = false;
    std::vector<TakeMetadata> finished;
    std::vector<TakeStartInfo> started;
    std::thread worker;

    /** ---- worker-thread state ---- */
    std::unique_ptr<ActiveTake> active;
    uint64_t cursorFrame = 0;            // capture frame index of the next frame in the ring
    std::deque<GapEvent> pendingGapEvents;   // from the callback, not yet reached
    std::vector<float> readBuffer;
    std::vector<float> pend;                   // ring of pendCapacity frames
    uint64_t pendCapacity = 0;
    uint64_t pendFirst = 0;
    uint64_t pendFrames = 0;
    uint64_t prerollFrames = 0;
    std::deque<GapEvent> pendGaps;            // silence inserted into the holding buffer
    std::deque<CaptureStamp> stamps;           // recent callback stamps

    std::atomic<RecorderState> state{RecorderState::Idle};
    std::atomic<uint32_t> takeNumber{0};
    std::atomic<uint64_t> framesWritten{0};
    std::atomic<bool> hasGaps{false};
};

