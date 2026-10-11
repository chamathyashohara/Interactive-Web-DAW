// Scheduled start/stop mapping (ADR-010). TEST SIGNAL - NOT A MICROPHONE. Blocks are fed with
// synthetic callback timestamps (10 ms apart) so the expected frames can be computed exactly.
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <thread>

#include "rr/audio/take_recorder.hpp"
#include "rr/audio/wav_inspect.hpp"
#include "test_support.hpp"

using namespace rr::audio;
using namespace std::chrono_literals;

namespace {

constexpr std::uint32_t kRate = 48000;
constexpr std::uint32_t kBlock = 480;
constexpr std::int64_t kBlockNs = 10'000'000;

// Feeds blocks [first_block, first_block + count) of the counter signal; block k carries the
// stamp t0 + k * 10 ms and covers frames [k*480, (k+1)*480).
void feed_blocks(CaptureIngest& ingest, std::int64_t t0, std::uint32_t first_block, std::uint32_t count) {
    std::vector<float> block(kBlock);
    for (std::uint32_t k = first_block; k < first_block + count; ++k) {
        for (std::uint32_t f = 0; f < kBlock; ++f) {
            block[f] = rr::test::counter_sample(static_cast<std::uint64_t>(k) * kBlock + f, 0);
        }
        ingest.on_block(block.data(), kBlock, t0 + static_cast<std::int64_t>(k) * kBlockNs);
    }
}

TakeRequest request(const std::filesystem::path& dir, std::int64_t start_at) {
    TakeRequest r;
    r.session_dir = dir;
    r.take_number = 1;
    r.role = rr::Role::Performer;
    r.session_id = "ab12cd34";
    r.capture.source_kind = "TEST SIGNAL (not a microphone)";
    r.start_at_ns = start_at;
    return r;
}

template <typename Pred>
bool wait_for(Pred pred, std::chrono::milliseconds timeout = 3000ms) {
    const auto end = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < end) {
        if (pred()) {
            return true;
        }
        std::this_thread::sleep_for(2ms);
    }
    return pred();
}

}  // namespace

TEST_CASE("a scheduled start begins at the frame captured at that time", "[audio][schedule]") {
    const auto dir = rr::test::fresh_temp_dir("sched_start");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    const std::int64_t t0 = rr::time::monotonic_ns() + 1'000'000'000;  // stamps in the near future
    const std::int64_t start_at = t0 + 105'000'000;                     // between blocks 10 and 11
    std::string error;
    REQUIRE(rec.begin_take(request(dir, start_at), error));
    CHECK(rec.status().state == RecorderState::Scheduled);
    feed_blocks(ingest, t0, 0, 15);  // 150 ms of audio, stamps up to t0 + 140 ms
    REQUIRE(wait_for([&] { return rec.status().state == RecorderState::Recording; }));
    std::vector<TakeStartInfo> started;
    REQUIRE(wait_for([&] {
        auto s = rec.take_started();
        started.insert(started.end(), s.begin(), s.end());
        return !started.empty();
    }));
    // A stamp marks the END of its block. First stamp at/after start_at: block 11 (t0+110 ms,
    // frames_end 12*480 = 5760) -> 5 ms back = 240 frames -> 5520.
    CHECK(started[0].first_frame == 5520);
    CHECK(started[0].late_frames == 0);
    CHECK(started[0].scheduled_start_ns == start_at);
    CHECK(std::llabs(started[0].first_sample_ns - start_at) < 1'000'000);

    // Scheduled stop announced before that time is captured (as a real STOP_SCHEDULE is):
    // block 21 (t0+210 ms, frames_end 10560) - 240 frames -> 10320.
    rec.end_take(StopReason::User, t0 + 205'000'000);
    std::this_thread::sleep_for(30ms);
    feed_blocks(ingest, t0, 15, 20);
    std::vector<TakeMetadata> done;
    REQUIRE(wait_for([&] {
        done = rec.take_finished();
        return !done.empty();
    }));
    rec.stop();
    const TakeMetadata& m = done[0];
    CHECK(m.status == rr::TakeStatus::Complete);
    CHECK(m.first_capture_frame == 5520);
    CHECK(m.frames == 10320 - 5520);
    CHECK(m.scheduled_start_ns == start_at);
    const auto s = rr::test::read_wav_samples(dir / m.file_name);
    REQUIRE(s.size() == 4800);
    CHECK(s.front() == rr::test::counter_sample(5520, 0));
    CHECK(s.back() == rr::test::counter_sample(10319, 0));
}

TEST_CASE("a start time older than the held audio is reported as late, not hidden", "[audio][schedule]") {
    const auto dir = rr::test::fresh_temp_dir("sched_late");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    const std::int64_t now = rr::time::monotonic_ns();
    // 2.5 s of audio stamped in the past, then a start 0.8 s ago: only the last 1.5 s are held.
    const std::int64_t t0 = now - 2'500'000'000LL;
    feed_blocks(ingest, t0, 0, 250);
    std::this_thread::sleep_for(50ms);  // let the worker drain (no take: keeps 1.5 s)
    const std::int64_t start_at = now - 900'000'000;  // still within the allowed 1 s in the past
    std::string error;
    REQUIRE(rec.begin_take(request(dir, start_at), error));
    feed_blocks(ingest, t0, 250, 10);  // stamps continue past start_at
    std::vector<TakeStartInfo> started;
    REQUIRE(wait_for([&] {
        auto s = rec.take_started();
        started.insert(started.end(), s.begin(), s.end());
        return !started.empty();
    }));
    // start_at = t0 + 1.6 s = stamp of block 160 exactly -> frames_end 161*480 = 77280; the held
    // audio begins at 120000 - 72000 = 48000, so the start is on time.
    CHECK(started[0].first_frame == 77280);
    CHECK(started[0].late_frames == 0);
    rec.cancel_take();  // ignored: already started
    rec.end_take();
    REQUIRE(wait_for([&] { return !rec.take_finished().empty(); }));
    rec.stop();

    // Now a start 0.99 s in the past while only ~0 s are held (immediately after the device "starts").
    const auto dir2 = rr::test::fresh_temp_dir("sched_late2");
    CaptureIngest ingest2(1, kRate, 10);
    TakeRecorder rec2(ingest2);
    rec2.start();
    const std::int64_t now2 = rr::time::monotonic_ns();
    const std::int64_t t02 = now2 - 500'000'000;  // first audio ever captured 0.5 s ago
    REQUIRE(rec2.begin_take(request(dir2, now2 - 990'000'000), error));
    feed_blocks(ingest2, t02, 0, 60);
    std::vector<TakeStartInfo> started2;
    REQUIRE(wait_for([&] {
        auto s = rec2.take_started();
        started2.insert(started2.end(), s.begin(), s.end());
        return !started2.empty();
    }));
    CHECK(started2[0].first_frame == 0);
    CHECK(started2[0].late_frames > 0);  // 0.49 s before the first available frame
    rec2.end_take();
    std::vector<TakeMetadata> done;
    REQUIRE(wait_for([&] {
        done = rec2.take_finished();
        return !done.empty();
    }));
    rec2.stop();
    CHECK(done[0].late_start_frames == started2[0].late_frames);
}

TEST_CASE("cancelling a scheduled take leaves no audio file and reports cancelled", "[audio][schedule]") {
    const auto dir = rr::test::fresh_temp_dir("sched_cancel");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    std::string error;
    REQUIRE(rec.begin_take(request(dir, rr::time::monotonic_ns() + 5'000'000'000LL), error));
    CHECK(std::filesystem::exists(dir / "take01_performer_ab12cd34.wav.partial"));
    rec.cancel_take();
    std::vector<TakeMetadata> done;
    REQUIRE(wait_for([&] {
        done = rec.take_finished();
        return !done.empty();
    }));
    rec.stop();
    CHECK(done[0].status == rr::TakeStatus::Cancelled);
    CHECK_FALSE(done[0].finalised);
    CHECK_FALSE(std::filesystem::exists(dir / "take01_performer_ab12cd34.wav.partial"));
    CHECK_FALSE(std::filesystem::exists(dir / "take01_performer_ab12cd34.wav"));
    CHECK(std::filesystem::exists(dir / "take01_performer_ab12cd34.json"));
    CHECK(rec.status().state == RecorderState::Idle);
}

TEST_CASE("start times outside the allowed window are refused", "[audio][schedule]") {
    const auto dir = rr::test::fresh_temp_dir("sched_window");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    std::string error;
    CHECK_FALSE(rec.begin_take(request(dir, rr::time::monotonic_ns() + 60'000'000'000LL), error));
    CHECK(error.find("30 s") != std::string::npos);
    CHECK_FALSE(rec.begin_take(request(dir, rr::time::monotonic_ns() - 5'000'000'000LL), error));
    CHECK(rec.status().state == RecorderState::Idle);
    rec.stop();
}
