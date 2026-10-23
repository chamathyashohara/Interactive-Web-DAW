// Scheduled start/stop mapping (ADR-010). TEST SIGNAL - NOT A MICROPHONE. Blocks are fed with
// synthetic callback timestamps (10 ms apart) so the expected frames can be computed exactly.
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <thread>

#include "rr/audio/TakeRecorder.h"
#include "rr/audio/WavInspect.h"
#include "TestSupport.h"

using namespace std::chrono_literals;

namespace
{

constexpr uint32_t kRate = 48000;
constexpr uint32_t kBlock = 480;
constexpr int64_t kBlockNs = 10'000'000;

// Feeds blocks [firstBlock, firstBlock + count) of the counter signal; block k carries the
// stamp t0 + k * 10 ms and covers frames [k*480, (k+1)*480).
void feedBlocks(CaptureIngest& ingest, int64_t t0, uint32_t firstBlock, uint32_t count)
{
    std::vector<float> block(kBlock);
    for (uint32_t k = firstBlock; k < firstBlock + count; ++k)
    {
        for (uint32_t f = 0; f < kBlock; ++f)
        {
            block[f] = counterSample(static_cast<uint64_t>(k) * kBlock + f, 0);
        }
        ingest.onBlock(block.data(), kBlock, t0 + static_cast<int64_t>(k) * kBlockNs);
    }
}

TakeRequest request(const std::filesystem::path& dir, int64_t startAt)
{
    TakeRequest r;
    r.sessionDir = dir;
    r.takeNumber = 1;
    r.role = Role::Performer;
    r.sessionId = "ab12cd34";
    r.capture.sourceKind = "TEST SIGNAL (not a microphone)";
    r.startAtNs = startAt;
    return r;
}

template <typename Pred>
bool wait_for(Pred pred, std::chrono::milliseconds timeout = 3000ms)
{
    const auto end = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < end)
    {
        if (pred())
        {
            return true;
        }
        std::this_thread::sleep_for(2ms);
    }
    return pred();
}

}  // namespace

TEST_CASE("a scheduled start begins at the frame captured at that time", "[audio][schedule]")
{
    const auto dir = freshTempDir("sched_start");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    const int64_t t0 = monotonicNs() + 1'000'000'000;  // stamps in the near future
    const int64_t startAt = t0 + 105'000'000;                     // between blocks 10 and 11
    std::string error;
    REQUIRE(rec.beginTake(request(dir, startAt), error));
    CHECK(rec.status().state == RecorderState::Scheduled);
    feedBlocks(ingest, t0, 0, 15);  // 150 ms of audio, stamps up to t0 + 140 ms
    REQUIRE(wait_for([&] { return rec.status().state == RecorderState::Recording; }));
    std::vector<TakeStartInfo> started;
    REQUIRE(wait_for([&] {
        auto s = rec.takeStarted();
        started.insert(started.end(), s.begin(), s.end());
        return !started.empty();
    }));
    // A stamp marks the END of its block. First stamp at/after startAt: block 11 (t0+110 ms,
    // framesEnd 12*480 = 5760) -> 5 ms back = 240 frames -> 5520.
    CHECK(started[0].firstFrame == 5520);
    CHECK(started[0].lateFrames == 0);
    CHECK(started[0].scheduledStartNs == startAt);
    CHECK(std::llabs(started[0].firstSampleNs - startAt) < 1'000'000);

    // Scheduled stop announced before that time is captured (as a real STOP_SCHEDULE is):
    // block 21 (t0+210 ms, framesEnd 10560) - 240 frames -> 10320.
    rec.endTake(StopReason::User, t0 + 205'000'000);
    std::this_thread::sleep_for(30ms);
    feedBlocks(ingest, t0, 15, 20);
    std::vector<TakeMetadata> done;
    REQUIRE(wait_for([&] {
        done = rec.takeFinished();
        return !done.empty();
    }));
    rec.stop();
    const TakeMetadata& m = done[0];
    CHECK(m.status == TakeStatus::Complete);
    CHECK(m.firstCaptureFrame == 5520);
    CHECK(m.frames == 10320 - 5520);
    CHECK(m.scheduledStartNs == startAt);
    const auto s = readWavSamples(dir / m.fileName);
    REQUIRE(s.size() == 4800);
    CHECK(s.front() == counterSample(5520, 0));
    CHECK(s.back() == counterSample(10319, 0));
}

TEST_CASE("a start time older than the held audio is reported as late, not hidden", "[audio][schedule]")
{
    const auto dir = freshTempDir("sched_late");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    const int64_t now = monotonicNs();
    // 2.5 s of audio stamped in the past, then a start 0.8 s ago: only the last 1.5 s are held.
    const int64_t t0 = now - 2'500'000'000LL;
    feedBlocks(ingest, t0, 0, 250);
    std::this_thread::sleep_for(50ms);  // let the worker drain (no take: keeps 1.5 s)
    const int64_t startAt = now - 900'000'000;  // still within the allowed 1 s in the past
    std::string error;
    REQUIRE(rec.beginTake(request(dir, startAt), error));
    feedBlocks(ingest, t0, 250, 10);  // stamps continue past startAt
    std::vector<TakeStartInfo> started;
    REQUIRE(wait_for([&] {
        auto s = rec.takeStarted();
        started.insert(started.end(), s.begin(), s.end());
        return !started.empty();
    }));
    // startAt = t0 + 1.6 s = stamp of block 160 exactly -> framesEnd 161*480 = 77280; the held
    // audio begins at 120000 - 72000 = 48000, so the start is on time.
    CHECK(started[0].firstFrame == 77280);
    CHECK(started[0].lateFrames == 0);
    rec.cancelTake();  // ignored: already started
    rec.endTake();
    REQUIRE(wait_for([&] { return !rec.takeFinished().empty(); }));
    rec.stop();

    // Now a start 0.99 s in the past while only ~0 s are held (immediately after the device "starts").
    const auto dir2 = freshTempDir("sched_late2");
    CaptureIngest ingest2(1, kRate, 10);
    TakeRecorder rec2(ingest2);
    rec2.start();
    const int64_t now2 = monotonicNs();
    const int64_t t02 = now2 - 500'000'000;  // first audio ever captured 0.5 s ago
    REQUIRE(rec2.beginTake(request(dir2, now2 - 990'000'000), error));
    feedBlocks(ingest2, t02, 0, 60);
    std::vector<TakeStartInfo> started2;
    REQUIRE(wait_for([&] {
        auto s = rec2.takeStarted();
        started2.insert(started2.end(), s.begin(), s.end());
        return !started2.empty();
    }));
    CHECK(started2[0].firstFrame == 0);
    CHECK(started2[0].lateFrames > 0);  // 0.49 s before the first available frame
    rec2.endTake();
    std::vector<TakeMetadata> done;
    REQUIRE(wait_for([&] {
        done = rec2.takeFinished();
        return !done.empty();
    }));
    rec2.stop();
    CHECK(done[0].lateStartFrames == started2[0].lateFrames);
}

TEST_CASE("cancelling a scheduled take leaves no audio file and reports cancelled", "[audio][schedule]")
{
    const auto dir = freshTempDir("sched_cancel");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    std::string error;
    REQUIRE(rec.beginTake(request(dir, monotonicNs() + 5'000'000'000LL), error));
    CHECK(std::filesystem::exists(dir / "take01_performer_ab12cd34.wav.partial"));
    rec.cancelTake();
    std::vector<TakeMetadata> done;
    REQUIRE(wait_for([&] {
        done = rec.takeFinished();
        return !done.empty();
    }));
    rec.stop();
    CHECK(done[0].status == TakeStatus::Cancelled);
    CHECK_FALSE(done[0].finalised);
    CHECK_FALSE(std::filesystem::exists(dir / "take01_performer_ab12cd34.wav.partial"));
    CHECK_FALSE(std::filesystem::exists(dir / "take01_performer_ab12cd34.wav"));
    CHECK(std::filesystem::exists(dir / "take01_performer_ab12cd34.json"));
    CHECK(rec.status().state == RecorderState::Idle);
}

TEST_CASE("start times outside the allowed window are refused", "[audio][schedule]")
{
    const auto dir = freshTempDir("sched_window");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    std::string error;
    CHECK_FALSE(rec.beginTake(request(dir, monotonicNs() + 60'000'000'000LL), error));
    CHECK(error.find("30 s") != std::string::npos);
    CHECK_FALSE(rec.beginTake(request(dir, monotonicNs() - 5'000'000'000LL), error));
    CHECK(rec.status().state == RecorderState::Idle);
    rec.stop();
}
