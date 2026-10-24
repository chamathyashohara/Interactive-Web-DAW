// Recording pipeline tests. TEST SIGNAL - NOT A MICROPHONE (see TestSupport.h).
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <thread>

#include "rr/audio/TakeRecorder.h"
#include "rr/shared/RealtimeGuard.h"
#include "rr/audio/WavInspect.h"
#include "TestSupport.h"

using namespace std::chrono_literals;

namespace
{

constexpr uint32_t kRate = 48000;
constexpr uint32_t kBlock = 480;  // 10 ms

TakeRequest requestFor(const std::filesystem::path& dir, uint32_t take, uint32_t channels,
                        uint32_t maxSeconds = 1800)
                        {
    TakeRequest r;
    r.sessionDir = dir;
    r.takeNumber = take;
    r.role = Role::Producer;
    r.sessionId = "ab12cd34";
    r.appVersion = "test";
    r.maxTakeSeconds = maxSeconds;
    r.capture.sourceKind = "TEST SIGNAL (not a microphone)";
    r.capture.sampleRate = kRate;
    r.capture.channels = channels;
    return r;
}

bool waitForState(const TakeRecorder& rec, RecorderState state, std::chrono::milliseconds timeout = 2000ms)
{
    const auto end = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < end)
    {
        if (rec.status().state == state)
        {
            return true;
        }
        std::this_thread::sleep_for(2ms);
    }
    return false;
}

std::vector<TakeMetadata> waitForResult(TakeRecorder& rec, std::chrono::milliseconds timeout = 3000ms)
{
    const auto end = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < end)
    {
        auto r = rec.takeFinished();
        if (!r.empty())
        {
            return r;
        }
        std::this_thread::sleep_for(5ms);
    }
    return {};
}

}  // namespace

TEST_CASE("a take contains exactly the frames captured while recording, in order", "[audio][recorder]")
{
    const auto dir = freshTempDir("rec_basic");
    CaptureIngest ingest(2, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();

    uint64_t index = feedCounter(ingest, 0, 20, kBlock);  // before the take: discarded
    std::this_thread::sleep_for(30ms);
    std::string error;
    REQUIRE(rec.beginTake(requestFor(dir, 1, 2), error));
    REQUIRE(waitForState(rec, RecorderState::Recording));
    const uint64_t firstInTake = index;
    index = feedCounter(ingest, index, 100, kBlock);  // 1 s inside the take
    std::this_thread::sleep_for(50ms);
    rec.endTake(StopReason::User);
    const auto results = waitForResult(rec);
    rec.stop();

    REQUIRE(results.size() == 1);
    const TakeMetadata& m = results[0];
    CHECK(m.status == TakeStatus::Complete);
    CHECK(m.finalised);
    CHECK(m.frames == 100 * kBlock);
    CHECK_FALSE(m.hasGaps);
    CHECK(m.firstCaptureFrame == firstInTake);
    CHECK(m.capture.sourceKind == "TEST SIGNAL (not a microphone)");

    const auto wav = dir / m.fileName;
    REQUIRE(inspectWav(wav).isCompleteFloatWav());
    const auto s = readWavSamples(wav);
    REQUIRE(s.size() == 100 * kBlock * 2);
    bool continuous = true;
    for (size_t f = 0; f < 100 * kBlock; ++f)
    {
        continuous = continuous && s[f * 2] == counterSample(firstInTake + f, 0) &&
                     s[f * 2 + 1] == counterSample(firstInTake + f, 1);
    }
    CHECK(continuous);
    CHECK(std::filesystem::exists(dir / m.metadataFileName));
}

TEST_CASE("a stalled writer causes ring overruns that become reported, silence-filled gaps", "[audio][recorder]")
{
    const auto dir = freshTempDir("rec_gaps");
    CaptureIngest ingest(1, kRate, 1);  // small ring: ~1.4 s
    TakeRecorder rec(ingest);
    rec.start();
    std::string error;
    REQUIRE(rec.beginTake(requestFor(dir, 1, 1), error));
    REQUIRE(waitForState(rec, RecorderState::Recording));

    rec.injectStall(600ms);        // TST-01c
    std::this_thread::sleep_for(60ms);
    feedCounter(ingest, 0, 300, kBlock);  // 3 s delivered while the worker sleeps
    const IngestStats stats = ingest.stats();
    REQUIRE(stats.overrunEvents > 0);

    std::this_thread::sleep_for(800ms);
    rec.endTake();
    const auto results = waitForResult(rec);
    rec.stop();
    REQUIRE(results.size() == 1);
    const TakeMetadata& m = results[0];
    CHECK(m.hasGaps);
    CHECK(m.gapPositionsComplete);
    CHECK(m.frames == 300 * kBlock);  // timeline preserved: data + silence
    uint64_t gapFrames = 0;
    for (const auto& g : m.gaps)
    {
        gapFrames += g.frames;
    }
    CHECK(gapFrames == stats.overrunFrames);
    CHECK(m.status == TakeStatus::Complete);  // file is finalised; the gaps are reported separately

    // The silence sits exactly where the metadata says.
    const auto s = readWavSamples(dir / m.fileName);
    REQUIRE(!m.gaps.empty());
    const auto& g0 = m.gaps.front();
    CHECK(s[g0.fileFrame] == 0.0f);
    CHECK(s[g0.fileFrame + g0.frames - 1] == 0.0f);
    CHECK(s[g0.fileFrame - 1] != 0.0f);
}

TEST_CASE("a disk write failure ends the take as incomplete_disk and never as saved", "[audio][recorder]")
{
    const auto dir = freshTempDir("rec_disk");
    CaptureIngest ingest(1, kRate, 10);
    RecorderOptions options;
    options.opener = failingOpener(58 + 4 * kRate / 2);  // room for 0.5 s
    TakeRecorder rec(ingest, options);
    rec.start();
    std::string error;
    REQUIRE(rec.beginTake(requestFor(dir, 1, 1), error));
    REQUIRE(waitForState(rec, RecorderState::Recording));
    feedCounter(ingest, 0, 100, kBlock);
    const auto results = waitForResult(rec);
    rec.stop();
    REQUIRE(results.size() == 1);
    CHECK(results[0].status == TakeStatus::IncompleteDisk);
    CHECK_FALSE(results[0].finalised);
    CHECK(results[0].stopReason == "disk_error");
    CHECK(results[0].error.find("simulated disk full") != std::string::npos);
    CHECK_FALSE(takeStatusIsComplete(results[0].status));
    CHECK_FALSE(std::filesystem::exists(dir / results[0].fileName));
    CHECK(std::filesystem::exists(dir / results[0].metadataFileName));  // the failure is recorded
}

TEST_CASE("a device fault finalises the audio so far as incomplete_device", "[audio][recorder]")
{
    const auto dir = freshTempDir("rec_device");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    ingest.setDeviceRunning(true);
    std::string error;
    REQUIRE(rec.beginTake(requestFor(dir, 1, 1), error));
    REQUIRE(waitForState(rec, RecorderState::Recording));
    feedCounter(ingest, 0, 50, kBlock);
    std::this_thread::sleep_for(50ms);
    ingest.reportDeviceFault(DeviceFault::StoppedUnexpectedly);
    const auto results = waitForResult(rec);
    rec.stop();
    REQUIRE(results.size() == 1);
    CHECK(results[0].status == TakeStatus::IncompleteDevice);
    CHECK(results[0].finalised);  // valid WAV of what was captured
    CHECK(results[0].frames == 50 * kBlock);
    CHECK(results[0].error.find("unplugged") != std::string::npos);
}

TEST_CASE("a device that stops calling back is detected by the watchdog", "[audio][recorder]")
{
    const auto dir = freshTempDir("rec_stall");
    CaptureIngest ingest(1, kRate, 10);
    RecorderOptions options;
    options.deviceStallTimeout = 100ms;
    TakeRecorder rec(ingest, options);
    rec.start();
    ingest.setDeviceRunning(true);
    std::string error;
    REQUIRE(rec.beginTake(requestFor(dir, 1, 1), error));
    REQUIRE(waitForState(rec, RecorderState::Recording));
    feedCounter(ingest, 0, 10, kBlock);  // then silence from the "device"
    const auto results = waitForResult(rec);
    rec.stop();
    REQUIRE(results.size() == 1);
    CHECK(results[0].status == TakeStatus::IncompleteDevice);
    CHECK(results[0].error.find("no callback") != std::string::npos);
}

TEST_CASE("shutdown finalises an active take as complete_shutdown", "[audio][recorder]")
{
    const auto dir = freshTempDir("rec_shutdown");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    std::string error;
    REQUIRE(rec.beginTake(requestFor(dir, 1, 1), error));
    REQUIRE(waitForState(rec, RecorderState::Recording));
    feedCounter(ingest, 0, 20, kBlock);
    std::this_thread::sleep_for(50ms);
    rec.stop();
    const auto results = rec.takeFinished();
    REQUIRE(results.size() == 1);
    CHECK(results[0].status == TakeStatus::CompleteShutdown);
    CHECK(results[0].finalised);
    CHECK(inspectWav(dir / results[0].fileName).isCompleteFloatWav());
}

TEST_CASE("the safety limit stops a take; a second take cannot start while one is active", "[audio][recorder]")
{
    const auto dir = freshTempDir("rec_limit");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    std::string error;
    REQUIRE(rec.beginTake(requestFor(dir, 1, 1, /*maxSeconds=*/1), error));
    std::string secondError;
    CHECK_FALSE(rec.beginTake(requestFor(dir, 2, 1), secondError));
    CHECK_FALSE(secondError.empty());
    REQUIRE(waitForState(rec, RecorderState::Recording));
    feedCounter(ingest, 0, 150, kBlock);  // 1.5 s
    const auto results = waitForResult(rec);
    rec.stop();
    REQUIRE(results.size() == 1);
    CHECK(results[0].stopReason == "safety_limit");
    CHECK(results[0].status == TakeStatus::Complete);
    CHECK(results[0].frames >= kRate);
}

TEST_CASE("the capture callback path refuses to log (real-time guard)", "[audio][recorder][rt]")
{
    // onBlock marks its thread real-time for its duration; after it returns the mark is gone.
    CaptureIngest ingest(1, kRate, 1);
    feedCounter(ingest, 0, 1, kBlock);
    CHECK_FALSE(isRealtimeThread());
    CHECK(ingest.stats().callbacks == 1);
}
