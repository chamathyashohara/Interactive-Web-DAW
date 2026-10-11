// Recording pipeline tests. TEST SIGNAL - NOT A MICROPHONE (see test_support.hpp).
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <thread>

#include "rr/audio/take_recorder.hpp"
#include "rr/shared/realtime_guard.hpp"
#include "rr/audio/wav_inspect.hpp"
#include "test_support.hpp"

using namespace rr::audio;
using namespace std::chrono_literals;

namespace {

constexpr std::uint32_t kRate = 48000;
constexpr std::uint32_t kBlock = 480;  // 10 ms

TakeRequest request_for(const std::filesystem::path& dir, std::uint32_t take, std::uint32_t channels,
                        std::uint32_t max_seconds = 1800) {
    TakeRequest r;
    r.session_dir = dir;
    r.take_number = take;
    r.role = rr::Role::Producer;
    r.session_id = "ab12cd34";
    r.app_version = "test";
    r.max_take_seconds = max_seconds;
    r.capture.source_kind = "TEST SIGNAL (not a microphone)";
    r.capture.sample_rate = kRate;
    r.capture.channels = channels;
    return r;
}

bool wait_for_state(const TakeRecorder& rec, RecorderState state, std::chrono::milliseconds timeout = 2000ms) {
    const auto end = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < end) {
        if (rec.status().state == state) {
            return true;
        }
        std::this_thread::sleep_for(2ms);
    }
    return false;
}

std::vector<TakeMetadata> wait_for_result(TakeRecorder& rec, std::chrono::milliseconds timeout = 3000ms) {
    const auto end = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < end) {
        auto r = rec.take_finished();
        if (!r.empty()) {
            return r;
        }
        std::this_thread::sleep_for(5ms);
    }
    return {};
}

}  // namespace

TEST_CASE("a take contains exactly the frames captured while recording, in order", "[audio][recorder]") {
    const auto dir = rr::test::fresh_temp_dir("rec_basic");
    CaptureIngest ingest(2, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();

    std::uint64_t index = rr::test::feed_counter(ingest, 0, 20, kBlock);  // before the take: discarded
    std::this_thread::sleep_for(30ms);
    std::string error;
    REQUIRE(rec.begin_take(request_for(dir, 1, 2), error));
    REQUIRE(wait_for_state(rec, RecorderState::Recording));
    const std::uint64_t first_in_take = index;
    index = rr::test::feed_counter(ingest, index, 100, kBlock);  // 1 s inside the take
    std::this_thread::sleep_for(50ms);
    rec.end_take(StopReason::User);
    const auto results = wait_for_result(rec);
    rec.stop();

    REQUIRE(results.size() == 1);
    const TakeMetadata& m = results[0];
    CHECK(m.status == rr::TakeStatus::Complete);
    CHECK(m.finalised);
    CHECK(m.frames == 100 * kBlock);
    CHECK_FALSE(m.has_gaps);
    CHECK(m.first_capture_frame == first_in_take);
    CHECK(m.capture.source_kind == "TEST SIGNAL (not a microphone)");

    const auto wav = dir / m.file_name;
    REQUIRE(inspect_wav(wav).is_complete_float_wav());
    const auto s = rr::test::read_wav_samples(wav);
    REQUIRE(s.size() == 100 * kBlock * 2);
    bool continuous = true;
    for (std::size_t f = 0; f < 100 * kBlock; ++f) {
        continuous = continuous && s[f * 2] == rr::test::counter_sample(first_in_take + f, 0) &&
                     s[f * 2 + 1] == rr::test::counter_sample(first_in_take + f, 1);
    }
    CHECK(continuous);
    CHECK(std::filesystem::exists(dir / m.metadata_file_name));
}

TEST_CASE("a stalled writer causes ring overruns that become reported, silence-filled gaps", "[audio][recorder]") {
    const auto dir = rr::test::fresh_temp_dir("rec_gaps");
    CaptureIngest ingest(1, kRate, 1);  // small ring: ~1.4 s
    TakeRecorder rec(ingest);
    rec.start();
    std::string error;
    REQUIRE(rec.begin_take(request_for(dir, 1, 1), error));
    REQUIRE(wait_for_state(rec, RecorderState::Recording));

    rec.inject_stall(600ms);        // TST-01c
    std::this_thread::sleep_for(60ms);
    rr::test::feed_counter(ingest, 0, 300, kBlock);  // 3 s delivered while the worker sleeps
    const IngestStats stats = ingest.stats();
    REQUIRE(stats.overrun_events > 0);

    std::this_thread::sleep_for(800ms);
    rec.end_take();
    const auto results = wait_for_result(rec);
    rec.stop();
    REQUIRE(results.size() == 1);
    const TakeMetadata& m = results[0];
    CHECK(m.has_gaps);
    CHECK(m.gap_positions_complete);
    CHECK(m.frames == 300 * kBlock);  // timeline preserved: data + silence
    std::uint64_t gap_frames = 0;
    for (const auto& g : m.gaps) {
        gap_frames += g.frames;
    }
    CHECK(gap_frames == stats.overrun_frames);
    CHECK(m.status == rr::TakeStatus::Complete);  // file is finalised; the gaps are reported separately

    // The silence sits exactly where the metadata says.
    const auto s = rr::test::read_wav_samples(dir / m.file_name);
    REQUIRE(!m.gaps.empty());
    const auto& g0 = m.gaps.front();
    CHECK(s[g0.file_frame] == 0.0f);
    CHECK(s[g0.file_frame + g0.frames - 1] == 0.0f);
    CHECK(s[g0.file_frame - 1] != 0.0f);
}

TEST_CASE("a disk write failure ends the take as incomplete_disk and never as saved", "[audio][recorder]") {
    const auto dir = rr::test::fresh_temp_dir("rec_disk");
    CaptureIngest ingest(1, kRate, 10);
    RecorderOptions options;
    options.opener = rr::test::failing_opener(58 + 4 * kRate / 2);  // room for 0.5 s
    TakeRecorder rec(ingest, options);
    rec.start();
    std::string error;
    REQUIRE(rec.begin_take(request_for(dir, 1, 1), error));
    REQUIRE(wait_for_state(rec, RecorderState::Recording));
    rr::test::feed_counter(ingest, 0, 100, kBlock);
    const auto results = wait_for_result(rec);
    rec.stop();
    REQUIRE(results.size() == 1);
    CHECK(results[0].status == rr::TakeStatus::IncompleteDisk);
    CHECK_FALSE(results[0].finalised);
    CHECK(results[0].stop_reason == "disk_error");
    CHECK(results[0].error.find("simulated disk full") != std::string::npos);
    CHECK_FALSE(rr::take_status_is_complete(results[0].status));
    CHECK_FALSE(std::filesystem::exists(dir / results[0].file_name));
    CHECK(std::filesystem::exists(dir / results[0].metadata_file_name));  // the failure is recorded
}

TEST_CASE("a device fault finalises the audio so far as incomplete_device", "[audio][recorder]") {
    const auto dir = rr::test::fresh_temp_dir("rec_device");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    ingest.set_device_running(true);
    std::string error;
    REQUIRE(rec.begin_take(request_for(dir, 1, 1), error));
    REQUIRE(wait_for_state(rec, RecorderState::Recording));
    rr::test::feed_counter(ingest, 0, 50, kBlock);
    std::this_thread::sleep_for(50ms);
    ingest.report_device_fault(DeviceFault::StoppedUnexpectedly);
    const auto results = wait_for_result(rec);
    rec.stop();
    REQUIRE(results.size() == 1);
    CHECK(results[0].status == rr::TakeStatus::IncompleteDevice);
    CHECK(results[0].finalised);  // valid WAV of what was captured
    CHECK(results[0].frames == 50 * kBlock);
    CHECK(results[0].error.find("unplugged") != std::string::npos);
}

TEST_CASE("a device that stops calling back is detected by the watchdog", "[audio][recorder]") {
    const auto dir = rr::test::fresh_temp_dir("rec_stall");
    CaptureIngest ingest(1, kRate, 10);
    RecorderOptions options;
    options.device_stall_timeout = 100ms;
    TakeRecorder rec(ingest, options);
    rec.start();
    ingest.set_device_running(true);
    std::string error;
    REQUIRE(rec.begin_take(request_for(dir, 1, 1), error));
    REQUIRE(wait_for_state(rec, RecorderState::Recording));
    rr::test::feed_counter(ingest, 0, 10, kBlock);  // then silence from the "device"
    const auto results = wait_for_result(rec);
    rec.stop();
    REQUIRE(results.size() == 1);
    CHECK(results[0].status == rr::TakeStatus::IncompleteDevice);
    CHECK(results[0].error.find("no callback") != std::string::npos);
}

TEST_CASE("shutdown finalises an active take as complete_shutdown", "[audio][recorder]") {
    const auto dir = rr::test::fresh_temp_dir("rec_shutdown");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    std::string error;
    REQUIRE(rec.begin_take(request_for(dir, 1, 1), error));
    REQUIRE(wait_for_state(rec, RecorderState::Recording));
    rr::test::feed_counter(ingest, 0, 20, kBlock);
    std::this_thread::sleep_for(50ms);
    rec.stop();
    const auto results = rec.take_finished();
    REQUIRE(results.size() == 1);
    CHECK(results[0].status == rr::TakeStatus::CompleteShutdown);
    CHECK(results[0].finalised);
    CHECK(inspect_wav(dir / results[0].file_name).is_complete_float_wav());
}

TEST_CASE("the safety limit stops a take; a second take cannot start while one is active", "[audio][recorder]") {
    const auto dir = rr::test::fresh_temp_dir("rec_limit");
    CaptureIngest ingest(1, kRate, 10);
    TakeRecorder rec(ingest);
    rec.start();
    std::string error;
    REQUIRE(rec.begin_take(request_for(dir, 1, 1, /*max_seconds=*/1), error));
    std::string second_error;
    CHECK_FALSE(rec.begin_take(request_for(dir, 2, 1), second_error));
    CHECK_FALSE(second_error.empty());
    REQUIRE(wait_for_state(rec, RecorderState::Recording));
    rr::test::feed_counter(ingest, 0, 150, kBlock);  // 1.5 s
    const auto results = wait_for_result(rec);
    rec.stop();
    REQUIRE(results.size() == 1);
    CHECK(results[0].stop_reason == "safety_limit");
    CHECK(results[0].status == rr::TakeStatus::Complete);
    CHECK(results[0].frames >= kRate);
}

TEST_CASE("the capture callback path refuses to log (real-time guard)", "[audio][recorder][rt]") {
    // on_block marks its thread real-time for its duration; after it returns the mark is gone.
    CaptureIngest ingest(1, kRate, 1);
    rr::test::feed_counter(ingest, 0, 1, kBlock);
    CHECK_FALSE(rr::rt::is_realtime_thread());
    CHECK(ingest.stats().callbacks == 1);
}
