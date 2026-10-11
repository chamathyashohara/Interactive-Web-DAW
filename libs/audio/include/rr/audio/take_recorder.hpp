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

#include "rr/audio/capture_ingest.hpp"
#include "rr/audio/file_io.hpp"
#include "rr/audio/take_metadata.hpp"
#include "rr/audio/wav_writer.hpp"

namespace rr::audio {

enum class StopReason : std::uint8_t { User, Shutdown, SafetyLimit, DeviceLost, DiskError };
const char* stop_reason_name(StopReason reason) noexcept;

enum class RecorderState : std::uint8_t {
    Idle,       // no take
    Starting,   // file created, waiting for the worker to take over
    Recording,
    Finalising,
};
const char* recorder_state_name(RecorderState state) noexcept;

struct TakeRequest {
    std::filesystem::path session_dir;
    std::uint32_t take_number = 0;
    Role role = Role::Producer;
    std::string session_id;
    std::string app_version;
    std::uint32_t max_take_seconds = 1800;
    CaptureDescription capture;
};

struct RecorderOptions {
    FileOpener opener = default_file_opener();
    std::chrono::milliseconds poll_interval{10};
    std::chrono::milliseconds header_refresh_interval{5000};
    std::chrono::milliseconds device_stall_timeout{500};
};

struct RecorderStatus {
    RecorderState state = RecorderState::Idle;
    std::uint32_t take_number = 0;
    std::uint64_t frames_written = 0;
    bool has_gaps = false;
};

// The dedicated recording worker (THREADING_AND_AUDIO_CALLBACKS.md §7). It drains the
// capture ring continuously, writes frames into the current take's WAV file, fills gaps with
// silence and reports them, refreshes the header every few seconds, watches for device faults
// and disk errors, and finalises takes. All file I/O for recordings happens on this thread
// (plus the initial file creation in begin_take, which runs on the caller's thread so that
// errors are reported immediately). Nothing here runs on the audio thread.
class TakeRecorder {
public:
    TakeRecorder(CaptureIngest& ingest, RecorderOptions options = {});
    ~TakeRecorder();  // calls stop()
    TakeRecorder(const TakeRecorder&) = delete;
    TakeRecorder& operator=(const TakeRecorder&) = delete;

    void start();
    // Finalises an active take with StopReason::Shutdown, then joins the worker.
    void stop();

    // Creates "<session_dir>/<stem>.wav.partial" (never overwriting) and hands it to the
    // worker. Returns false with a message if the take cannot start.
    bool begin_take(const TakeRequest& request, std::string& error);
    void end_take(StopReason reason = StopReason::User);

    RecorderStatus status() const noexcept;
    std::vector<TakeMetadata> take_finished();  // results not yet collected, oldest first

    // Test hook (TST-01c): the worker sleeps for `duration` before its next drain, so the
    // capture ring overflows exactly as it would on a stalled disk.
    void inject_stall(std::chrono::milliseconds duration);

private:
    struct Command;
    struct ActiveTake;

    void worker_loop();
    void drain();
    void check_active_take();
    void finish(StopReason reason);

    CaptureIngest& ingest_;
    RecorderOptions options_;

    std::mutex mutex_;
    std::condition_variable wake_;
    std::deque<std::unique_ptr<Command>> commands_;
    bool stop_requested_ = false;
    std::vector<TakeMetadata> finished_;
    std::thread worker_;

    // Worker-thread state.
    std::unique_ptr<ActiveTake> active_;
    std::uint64_t cursor_frame_ = 0;     // capture frame index of the next frame in the ring
    std::deque<GapEvent> pending_gaps_;
    std::vector<float> buffer_;

    std::atomic<RecorderState> state_{RecorderState::Idle};
    std::atomic<std::uint32_t> take_number_{0};
    std::atomic<std::uint64_t> frames_written_{0};
    std::atomic<bool> has_gaps_{false};
};

}  // namespace rr::audio
