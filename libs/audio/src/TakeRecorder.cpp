#include "rr/audio/TakeRecorder.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <utility>

#include "rr/audio/TakeNaming.h"
#include "rr/shared/Clock.h"

const char* stopReasonName(StopReason reason) noexcept
{
    switch (reason)
    {
    case StopReason::User: return "user";
    case StopReason::Shutdown: return "shutdown";
    case StopReason::SafetyLimit: return "safety_limit";
    case StopReason::DeviceLost: return "device_lost";
    case StopReason::DiskError: return "disk_error";
    case StopReason::Remote: return "producer_stop";
    }
    return "unknown";
}

const char* recorderStateName(RecorderState state) noexcept
{
    switch (state)
    {
    case RecorderState::Idle: return "idle";
    case RecorderState::Starting: return "starting";
    case RecorderState::Scheduled: return "scheduled";
    case RecorderState::Recording: return "recording";
    case RecorderState::Finalising: return "finalising";
    }
    return "unknown";
}

namespace
{
constexpr int64_t kMaxScheduleAheadNs = 30'000'000'000LL;
constexpr int64_t kMaxScheduleBehindNs = 1'000'000'000LL;
constexpr size_t kMaxStamps = 512;
}  // namespace

struct TakeRecorder::Command
{
    enum class Kind { Begin, End, Cancel, Stall } kind = Kind::End;
    std::unique_ptr<WavWriter> writer;
    TakeMetadata meta;
    std::filesystem::path sessionDir;
    uint32_t maxTakeSeconds = 0;
    int64_t startAtNs = 0;
    StopReason reason = StopReason::User;
    int64_t stopAtNs = 0;
    std::chrono::milliseconds stall{0};
};

struct TakeRecorder::ActiveTake
{
    std::unique_ptr<WavWriter> writer;
    TakeMetadata meta;
    std::filesystem::path sessionDir;
    uint64_t maxFrames = 0;
    uint64_t gapEventsLostAtStart = 0;
    uint64_t anomaliesAtStart = 0;
    int64_t lastHeaderRefreshNs = 0;

    int64_t startAtNs = 0;
    bool started = false;
    uint64_t startFrame = 0;
    uint64_t writePos = 0;

    bool endRequested = false;
    StopReason endReason = StopReason::User;
    int64_t stopAtNs = 0;
    bool stopResolved = false;
    uint64_t stopFrame = 0;
};

TakeRecorder::TakeRecorder(CaptureIngest& ingest, RecorderOptions options)
    : ingest(ingest), options(std::move(options)), channels(ingest.getChannels()), rate(ingest.getSampleRate()) {
    readBuffer.resize(static_cast<size_t>(4096) * this->channels);
    pendCapacity = static_cast<uint64_t>(rate) * 4;  // 4 s holding buffer
    pend.resize(static_cast<size_t>(pendCapacity) * this->channels);
    prerollFrames = static_cast<uint64_t>(rate) * 3 / 2;  // 1.5 s kept while a start is pending
}

TakeRecorder::~TakeRecorder()
{
    stop();
}

void TakeRecorder::start()
{
    std::lock_guard<std::mutex> lock(mutex);
    if (worker.joinable())
    {
        return;
    }
    stopRequested = false;
    worker = std::thread([this] { workerLoop(); });
}

void TakeRecorder::stop()
{
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (!worker.joinable())
        {
            return;
        }
        stopRequested = true;
    }
    wake.notify_one();
    worker.join();
}

bool TakeRecorder::beginTake(const TakeRequest& request, std::string& error)
{
    if (request.startAtNs != 0)
    {
        const int64_t now = monotonicNs();
        if (request.startAtNs > now + kMaxScheduleAheadNs || request.startAtNs < now - kMaxScheduleBehindNs)
        {
            error = "scheduled start time is not within the next 30 s";
            return false;
        }
    }
    RecorderState expected = RecorderState::Idle;
    if (!state.compare_exchange_strong(expected, RecorderState::Starting))
    {
        error = std::string("a take is already ") + recorderStateName(expected);
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (!worker.joinable())
        {
            state.store(RecorderState::Idle);
            error = "recorder is not running (no open input device)";
            return false;
        }
    }

    WavFormat format;
    format.sampleRate = rate;
    format.channels = channels;
    const std::string stem = takeStem(request.takeNumber, request.role, request.sessionId);
    const std::filesystem::path finalPath = request.sessionDir / (stem + ".wav");

    auto writer = std::make_unique<WavWriter>(options.opener);
    if (!writer->open(finalPath, format))
    {
        error = writer->getError();
        state.store(RecorderState::Idle);
        return false;
    }

    auto cmd = std::make_unique<Command>();
    cmd->kind = Command::Kind::Begin;
    cmd->sessionDir = request.sessionDir;
    cmd->maxTakeSeconds = request.maxTakeSeconds;
    cmd->startAtNs = request.startAtNs;
    TakeMetadata& m = cmd->meta;
    m.takeNumber = request.takeNumber;
    m.role = request.role;
    m.sessionId = request.sessionId;
    m.appVersion = request.appVersion;
    m.fileName = pathToUtf8(finalPath.filename());
    m.partialFileName = pathToUtf8(writer->getPartialPath().filename());
    m.metadataFileName = stem + ".json";
    m.sampleRate = format.sampleRate;
    m.channels = format.channels;
    m.wavFormatTag = format.formatTag();
    m.capture = request.capture;
    m.scheduledStartNs = request.startAtNs;
    cmd->writer = std::move(writer);

    takeNumber.store(request.takeNumber);
    framesWritten.store(0);
    hasGaps.store(false);
    if (request.startAtNs != 0)
    {
        state.store(RecorderState::Scheduled);
    }
    {
        std::lock_guard<std::mutex> lock(mutex);
        commands.push_back(std::move(cmd));
    }
    wake.notify_one();
    return true;
}

void TakeRecorder::endTake(StopReason reason, int64_t stopAtNs)
{
    auto cmd = std::make_unique<Command>();
    cmd->kind = Command::Kind::End;
    cmd->reason = reason;
    cmd->stopAtNs = stopAtNs;
    {
        std::lock_guard<std::mutex> lock(mutex);
        commands.push_back(std::move(cmd));
    }
    wake.notify_one();
}

void TakeRecorder::cancelTake()
{
    auto cmd = std::make_unique<Command>();
    cmd->kind = Command::Kind::Cancel;
    {
        std::lock_guard<std::mutex> lock(mutex);
        commands.push_back(std::move(cmd));
    }
    wake.notify_one();
}

void TakeRecorder::injectStall(std::chrono::milliseconds duration)
{
    auto cmd = std::make_unique<Command>();
    cmd->kind = Command::Kind::Stall;
    cmd->stall = duration;
    {
        std::lock_guard<std::mutex> lock(mutex);
        commands.push_back(std::move(cmd));
    }
    wake.notify_one();
}

RecorderStatus TakeRecorder::status() const noexcept
{
    RecorderStatus s;
    s.state = state.load();
    s.takeNumber = takeNumber.load();
    s.framesWritten = framesWritten.load();
    s.hasGaps = hasGaps.load();
    return s;
}

std::vector<TakeMetadata> TakeRecorder::takeFinished()
{
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<TakeMetadata> out;
    out.swap(finished);
    return out;
}

std::vector<TakeStartInfo> TakeRecorder::takeStarted()
{
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<TakeStartInfo> out;
    out.swap(started);
    return out;
}

// ---------------------------------------------------------------------------------------------
// Holding buffer (worker thread only). Frame f lives at slot f % capacity; the contents always
// span [pendFirst, pendEnd()) with pendEnd() == cursorFrame.

void TakeRecorder::pendAppend(const float* samples, uint64_t frames)
{
    uint64_t done = 0;
    while (done < frames)
    {
        const uint64_t slot = (pendEnd() % pendCapacity);
        const uint64_t n = std::min(frames - done, pendCapacity - slot);
        std::memcpy(&pend[static_cast<size_t>(slot * channels)], samples + done * channels,
                    static_cast<size_t>(n * channels) * sizeof(float));
        pendFrames += n;
        done += n;
    }
}

void TakeRecorder::pendAppendSilence(uint64_t frames)
{
    uint64_t done = 0;
    while (done < frames)
    {
        const uint64_t slot = (pendEnd() % pendCapacity);
        const uint64_t n = std::min(frames - done, pendCapacity - slot);
        std::fill_n(&pend[static_cast<size_t>(slot * channels)], static_cast<size_t>(n * channels), 0.0f);
        pendFrames += n;
        done += n;
    }
}

void TakeRecorder::pendDropBefore(uint64_t frame)
{
    if (frame <= pendFirst)
    {
        return;
    }
    const uint64_t drop = std::min(frame - pendFirst, pendFrames);
    pendFirst += drop;
    pendFrames -= drop;
    while (!pendGaps.empty() && pendGaps.front().startFrame + pendGaps.front().frames <= pendFirst)
    {
        pendGaps.pop_front();
    }
}

void TakeRecorder::trimPendingToPreroll()
{
    if (pendFrames > prerollFrames)
    {
        pendDropBefore(pendEnd() - prerollFrames);
    }
}

// Finds the capture frame captured at local time tNs using the first stamp at or after tNs
// (interpolating back by the nominal rate). Without such a stamp: extrapolate from the newest
// stamp unless requireAfter is set.
bool TakeRecorder::frameForTime(int64_t tNs, int64_t& frame, int64_t& stampTime,
                                  bool requireAfter) const
                                  {
    for (const CaptureStamp& s : stamps)
    {
        if (s.tNs >= tNs)
        {
            const auto back = static_cast<int64_t>(std::llround(
                static_cast<double>(s.tNs - tNs) * static_cast<double>(rate) / 1e9));
            frame = static_cast<int64_t>(s.framesEnd) - back;
            stampTime = s.tNs;
            return true;
        }
    }
    if (requireAfter || stamps.empty())
    {
        return false;
    }
    const CaptureStamp& last = stamps.back();
    const auto ahead = static_cast<int64_t>(
        std::llround(static_cast<double>(tNs - last.tNs) * static_cast<double>(rate) / 1e9));
    frame = static_cast<int64_t>(last.framesEnd) + ahead;
    stampTime = last.tNs;
    return true;
}

namespace
{
int64_t timeForFrame(const std::deque<CaptureStamp>& stamps, uint64_t frame, uint32_t rate)
{
    if (stamps.empty() || rate == 0)
    {
        return monotonicNs();
    }
    const CaptureStamp& s = stamps.back();
    const double framesBack = static_cast<double>(s.framesEnd) - static_cast<double>(frame);
    return s.tNs - static_cast<int64_t>(std::llround(framesBack * 1e9 / rate));
}
}  // namespace

// ---------------------------------------------------------------------------------------------

void TakeRecorder::workerLoop()
{
    for (;;)
    {
        std::deque<std::unique_ptr<Command>> batch;
        bool stopping = false;
        {
            std::unique_lock<std::mutex> lock(mutex);
            wake.wait_for(lock, options.pollInterval, [this] { return stopRequested || !commands.empty(); });
            batch.swap(commands);
            stopping = stopRequested;
        }

        for (auto& cmd : batch)
        {
            switch (cmd->kind)
            {
            case Command::Kind::Stall:
                std::this_thread::sleep_for(cmd->stall);
                break;
            case Command::Kind::Begin: {
                drain();
                auto take = std::make_unique<ActiveTake>();
                take->writer = std::move(cmd->writer);
                take->meta = std::move(cmd->meta);
                take->sessionDir = cmd->sessionDir;
                take->maxFrames = static_cast<uint64_t>(cmd->maxTakeSeconds) * rate;
                const IngestStats stats = ingest.stats();
                take->gapEventsLostAtStart = stats.gapEventsLost;
                take->anomaliesAtStart = stats.timingAnomalies;
                take->startAtNs = cmd->startAtNs;
                take->lastHeaderRefreshNs = monotonicNs();
                active = std::move(take);
                if (active->startAtNs == 0)
                {
                    // Immediate start: the take begins with the next captured frame.
                    ActiveTake& a = *active;
                    a.started = true;
                    a.startFrame = pendEnd();
                    a.writePos = a.startFrame;
                    pendDropBefore(a.startFrame);
                    a.meta.firstCaptureFrame = a.startFrame;
                    a.meta.firstSampleNsEst = timeForFrame(stamps, a.startFrame, rate);
                    a.meta.startMonoNs = monotonicNs();
                    a.meta.startedUtc = formatUtcIso8601Ms(utcNowMs());
                    state.store(RecorderState::Recording);
                    std::lock_guard<std::mutex> lock(mutex);
                    started.push_back(TakeStartInfo{a.meta.takeNumber, a.startFrame, a.meta.firstSampleNsEst, 0, 0});
                }
                else
                {
                    state.store(RecorderState::Scheduled);
                }
                break;
            }
            case Command::Kind::End:
                if (active)
                {
                    if (!active->started)
                    {
                        cancelPending();
                        break;
                    }
                    drain();
                    ActiveTake& a = *active;
                    a.endRequested = true;
                    a.endReason = cmd->reason;
                    a.stopAtNs = cmd->stopAtNs;
                    a.meta.scheduledStopNs = cmd->stopAtNs;
                    if (cmd->stopAtNs == 0)
                    {
                        a.stopResolved = true;
                        a.stopFrame = std::max(pendEnd(), a.writePos);
                    }
                }
                break;
            case Command::Kind::Cancel:
                if (active && !active->started)
                {
                    cancelPending();
                }
                break;
            }
        }

        drain();
        if (active)
        {
            checkFaults();
        }
        if (active)
        {
            processActive();
        }
        else
        {
            trimPendingToPreroll();
        }
        if (stopping)
        {
            if (active)
            {
                if (active->started)
                {
                    writePendingUntil(pendEnd());
                    finish(StopReason::Shutdown);
                }
                else
                {
                    cancelPending();
                }
            }
            return;
        }
    }
}

// Moves everything currently in the capture ring into the holding buffer, inserting silence
// where the callback had to drop blocks.
void TakeRecorder::drain()
{
    // Read the sample count first: every gap event that precedes these samples was published by
    // the callback before them, so it is visible once we drain the gap ring below.
    uint64_t framesLeft = ingest.getSamples().readAvailable() / channels;
    GapEvent gap;
    while (ingest.getGaps().read(&gap, 1) == 1)
    {
        pendingGapEvents.push_back(gap);
    }
    CaptureStamp stamp;
    while (ingest.getStamps().read(&stamp, 1) == 1)
    {
        stamps.push_back(stamp);
        if (stamps.size() > kMaxStamps)
        {
            stamps.pop_front();
        }
    }

    auto makeRoom = [this](uint64_t frames)
    {
        if (pendFrames + frames <= pendCapacity)
        {
            return;
        }
        if (active && active->started)
        {
            writePendingUntil(pendEnd());  // never lose take audio to a full holding buffer
        }
        if (pendFrames + frames > pendCapacity)
        {
            pendDropBefore(pendEnd() + frames - pendCapacity);
        }
    };

    for (;;)
    {
        while (!pendingGapEvents.empty() && pendingGapEvents.front().startFrame <= cursorFrame)
        {
            const GapEvent g = pendingGapEvents.front();
            pendingGapEvents.pop_front();
            makeRoom(g.frames);
            pendGaps.push_back(GapEvent{cursorFrame, g.frames});
            pendAppendSilence(g.frames);
            cursorFrame += g.frames;
        }
        if (framesLeft == 0)
        {
            break;
        }
        uint64_t n = std::min<uint64_t>(framesLeft, readBuffer.size() / channels);
        if (!pendingGapEvents.empty())
        {
            n = std::min<uint64_t>(n, pendingGapEvents.front().startFrame - cursorFrame);
        }
        const size_t got = ingest.getSamples().read(readBuffer.data(), static_cast<size_t>(n) * channels);
        const uint64_t gotFrames = got / channels;
        if (gotFrames == 0)
        {
            break;
        }
        makeRoom(gotFrames);
        pendAppend(readBuffer.data(), gotFrames);
        cursorFrame += gotFrames;
        framesLeft -= gotFrames;
    }
}

// Writes held frames [writePos, end) to the take, recording inserted silence as gaps.
void TakeRecorder::writePendingUntil(uint64_t endFrame)
{
    ActiveTake& a = *active;
    endFrame = std::min(endFrame, pendEnd());
    if (a.writePos < pendFirst)
    {
        a.writePos = pendFirst;  // cannot happen in normal operation; never write stale slots
    }
    if (endFrame <= a.writePos)
    {
        return;
    }
    for (const GapEvent& g : pendGaps)
    {
        const uint64_t gEnd = g.startFrame + g.frames;
        const uint64_t lo = std::max<uint64_t>(g.startFrame, std::max(a.writePos, a.startFrame));
        const uint64_t hi = std::min<uint64_t>(gEnd, endFrame);
        if (lo < hi)
        {
            const uint64_t fileFrame = lo - a.startFrame;
            if (!a.meta.gaps.empty() && a.meta.gaps.back().fileFrame + a.meta.gaps.back().frames == fileFrame)
            {
                a.meta.gaps.back().frames += hi - lo;  // continuation of the same gap
            }
            else
            {
                a.meta.gaps.push_back(TakeGap{fileFrame, hi - lo});
            }
            a.meta.hasGaps = true;
            hasGaps.store(true);
        }
    }
    while (a.writePos < endFrame && !a.writer->hasFailed())
    {
        const uint64_t slot = a.writePos % pendCapacity;
        const uint64_t n = std::min(endFrame - a.writePos, pendCapacity - slot);
        a.writer->writeFrames(&pend[static_cast<size_t>(slot * channels)], n);
        a.writePos += n;
    }
    framesWritten.store(a.writer->framesWritten());
    pendDropBefore(a.writePos);
}

void TakeRecorder::checkFaults()
{
    ActiveTake& take = *active;
    const IngestStats stats = ingest.stats();
    if (stats.gapEventsLost > take.gapEventsLostAtStart)
    {
        take.meta.hasGaps = true;
        take.meta.gapPositionsComplete = false;
        hasGaps.store(true);
    }
    if (take.writer->hasFailed())
    {
        finish(StopReason::DiskError);
        return;
    }
    const DeviceFault fault = ingest.getDeviceFault();
    const int64_t now = monotonicNs();
    const bool stalled = ingest.isDeviceRunning() && stats.lastCallbackNs != 0 &&
                         now - stats.lastCallbackNs >
                             std::chrono::duration_cast<std::chrono::nanoseconds>(options.deviceStallTimeout).count();
    if (fault != DeviceFault::None || stalled)
    {
        take.meta.error = fault == DeviceFault::Rerouted ? "audio stream was moved to another device"
                          : fault == DeviceFault::StoppedUnexpectedly
                              ? "input device stopped (unplugged, disabled or failed)"
                              : "input device stopped delivering audio (no callback for " +
                                    std::to_string(options.deviceStallTimeout.count()) + " ms)";
        if (!take.started)
        {
            cancelPending();
            return;
        }
        writePendingUntil(pendEnd());
        finish(StopReason::DeviceLost);
    }
}

void TakeRecorder::processActive()
{
    ActiveTake& a = *active;
    if (!a.started)
    {
        int64_t wanted = 0;
        int64_t stampTime = 0;
        if (!frameForTime(a.startAtNs, wanted, stampTime, /*requireAfter=*/true))
        {
            trimPendingToPreroll();  // keep the last 1.5 s so the start frame is still held
            return;
        }
        uint64_t late = 0;
        uint64_t frame = 0;
        if (wanted < static_cast<int64_t>(pendFirst))
        {
            // The start time is older than the audio still held (or than the first captured
            // sample): start with the oldest held frame and report by how much the start was missed.
            late = static_cast<uint64_t>(static_cast<int64_t>(pendFirst) - wanted);
            frame = pendFirst;
        }
        else
        {
            frame = static_cast<uint64_t>(wanted);
        }
        a.started = true;
        a.startFrame = frame;
        a.writePos = frame;
        pendDropBefore(std::min(frame, pendEnd()));
        a.meta.firstCaptureFrame = frame;
        a.meta.lateStartFrames = late;
        a.meta.firstSampleNsEst = timeForFrame(stamps, frame, rate);
        a.meta.startMonoNs = monotonicNs();
        a.meta.startedUtc = formatUtcIso8601Ms(utcNowMs());
        state.store(RecorderState::Recording);
        std::lock_guard<std::mutex> lock(mutex);
        this->started.push_back(TakeStartInfo{a.meta.takeNumber, frame, a.meta.firstSampleNsEst, a.startAtNs, late});
    }

    uint64_t limit = pendEnd();
    if (a.endRequested && !a.stopResolved)
    {
        int64_t frame = 0;
        int64_t stampTime = 0;
        if (frameForTime(a.stopAtNs, frame, stampTime, /*requireAfter=*/true))
        {
            a.stopResolved = true;
            a.stopFrame = std::max(static_cast<uint64_t>(std::max<int64_t>(frame, 0)), a.writePos);
        }
        else if (frameForTime(a.stopAtNs, frame, stampTime, /*requireAfter=*/false))
        {
            // Hold back what may lie after the stop until a stamp confirms the exact frame.
            limit = std::min(limit, std::max(static_cast<uint64_t>(std::max<int64_t>(frame, 0)), a.writePos));
        }
    }
    if (a.stopResolved)
    {
        limit = std::min(limit, a.stopFrame);
    }
    if (a.maxFrames != 0)
    {
        limit = std::min(limit, a.startFrame + a.maxFrames);
    }
    writePendingUntil(limit);

    if (a.writer->hasFailed())
    {
        finish(StopReason::DiskError);
        return;
    }
    if (a.stopResolved && a.writePos >= a.stopFrame)
    {
        finish(a.endReason);
        return;
    }
    if (a.maxFrames != 0 && a.writePos - a.startFrame >= a.maxFrames)
    {
        finish(StopReason::SafetyLimit);
        return;
    }
    const int64_t now = monotonicNs();
    if (now - a.lastHeaderRefreshNs >=
        std::chrono::duration_cast<std::chrono::nanoseconds>(options.headerRefreshInterval).count())
        {
        a.writer->refreshHeader();  // failure latches in the writer; seen next cycle
        a.lastHeaderRefreshNs = now;
    }
}

void TakeRecorder::cancelPending()
{
    ActiveTake& take = *active;
    TakeMetadata& m = take.meta;
    take.writer->abandon();
    std::error_code ec;
    // The file holds only a header (no audio was ever written): removing it loses nothing.
    std::filesystem::remove(take.sessionDir / m.partialFileName, ec);
    m.status = TakeStatus::Cancelled;
    m.finalised = false;
    m.frames = 0;
    m.stopReason = "cancelled";
    m.stoppedUtc = formatUtcIso8601Ms(utcNowMs());
    std::string jsonError;
    if (!writeTextFileAtomically(take.sessionDir / m.metadataFileName, toJson(m), jsonError))
    {
        m.error = (m.error.empty() ? "" : m.error + "; ") + "metadata not written: " + jsonError;
    }
    {
        std::lock_guard<std::mutex> lock(mutex);
        finished.push_back(m);
    }
    active.reset();
    framesWritten.store(0);
    state.store(RecorderState::Idle);
}

void TakeRecorder::finish(StopReason reason)
{
    state.store(RecorderState::Finalising);
    ActiveTake& take = *active;
    TakeMetadata& m = take.meta;
    m.stopReason = stopReasonName(reason);
    m.stoppedUtc = formatUtcIso8601Ms(utcNowMs());
    m.timingAnomalies = ingest.stats().timingAnomalies - take.anomaliesAtStart;

    WavWriter& w = *take.writer;
    if (reason == StopReason::DiskError || w.hasFailed())
    {
        if (m.error.empty())
        {
            m.error = w.getError();
        }
        w.abandon();
        m.status = TakeStatus::IncompleteDisk;
        m.finalised = false;
    }
    else
    {
        const bool ok = w.finalise();
        m.finalised = ok;
        if (!ok)
        {
            m.status = TakeStatus::IncompleteDisk;
            m.error = (m.error.empty() ? "" : m.error + "; ") + "finalisation failed: " + w.getError();
            w.abandon();
        }
        else if (reason == StopReason::DeviceLost)
        {
            m.status = TakeStatus::IncompleteDevice;  // file is valid but the take ended early
        }
        else if (reason == StopReason::Shutdown)
        {
            m.status = TakeStatus::CompleteShutdown;
        }
        else
        {
            m.status = TakeStatus::Complete;
        }
    }
    m.frames = w.framesWritten();
    framesWritten.store(m.frames);

    std::string jsonError;
    if (!writeTextFileAtomically(take.sessionDir / m.metadataFileName, toJson(m), jsonError))
    {
        m.error = (m.error.empty() ? "" : m.error + "; ") + "metadata not written: " + jsonError;
    }

    {
        std::lock_guard<std::mutex> lock(mutex);
        finished.push_back(m);
    }
    active.reset();
    state.store(RecorderState::Idle);
}

