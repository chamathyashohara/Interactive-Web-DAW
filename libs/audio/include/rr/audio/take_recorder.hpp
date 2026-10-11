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

enum class StopReason : std::uint8_t { User, Shutdown, SafetyLimit, DeviceLost, DiskError, Remote };
const char* stop_reason_name(StopReason reason) noexcept;

enum class RecorderState : std::uint8_t {
    Idle,        // no take
    Starting,    // file created, waiting for the worker to take over (immediate start)
    Scheduled,   // file created, waiting for the scheduled start time
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
    // Local monotonic time (rr::time::monotonic_ns) of the first sample; 0 = start now.
    // Must lie within the next 30 s.
    std::int64_t start_at_ns = 0;
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

// Reported once per take when its first sample has been written (or, for a late scheduled start,
// when the start was resolved).
struct TakeStartInfo {
    std::uint32_t take_number = 0;
    std::uint64_t first_frame = 0;        // capture frame index of the first written sample
    std::int64_t first_sample_ns = 0;     // estimated local monotonic time of that sample
    std::int64_t scheduled_start_ns = 0;  // 0 = immediate
    std::uint64_t late_frames = 0;        // > 0: the scheduled start was missed by this much
};

// The dedicated recording worker (THREADING_AND_AUDIO_CALLBACKS.md §7). It drains the capture
// ring continuously into a frame-indexed holding buffer (inserting silence for dropped blocks and
// recording where), keeps ~1.5 s of recent audio while a scheduled start is pending, maps
// scheduled start/stop times to exact capture frames using the callback stamps (ADR-010), writes
// the take, watches for device faults and disk errors, and finalises. All recording file I/O
// happens on this thread except the initial exclusive file creation in begin_take (caller's
// thread, so errors are reported immediately). Nothing here runs on the audio thread.
class TakeRecorder {
public:
    TakeRecorder(CaptureIngest& ingest, RecorderOptions options = {});
    ~TakeRecorder();  // calls stop()
    TakeRecorder(const TakeRecorder&) = delete;
    TakeRecorder& operator=(const TakeRecorder&) = delete;

    void start();
    // Finalises an active take with StopReason::Shutdown (a not-yet-started scheduled take is
    // cancelled), then joins the worker.
    void stop();

    bool begin_take(const TakeRequest& request, std::string& error);
    // Ends the active take. stop_at_ns = 0: at the newest captured frame; otherwise at the frame
    // captured at that local monotonic time (must be within the next 30 s).
    void end_take(StopReason reason = StopReason::User, std::int64_t stop_at_ns = 0);
    // Abandons a take that has not started yet (status `cancelled`, the empty file is removed).
    // Ignored once the take has started.
    void cancel_take();

    RecorderStatus status() const noexcept;
    std::vector<TakeMetadata> take_finished();  // results not yet collected, oldest first
    std::vector<TakeStartInfo> take_started();  // start reports not yet collected

    // Test hook (TST-01c): the worker sleeps for `duration` before its next drain, so the capture
    // ring overflows exactly as it would on a stalled disk.
    void inject_stall(std::chrono::milliseconds duration);

private:
    struct Command;
    struct ActiveTake;

    void worker_loop();
    void drain();
    void process_active();
    void check_faults();
    void finish(StopReason reason);
    void cancel_pending();
    void trim_pending_to_preroll();
    void write_pending_until(std::uint64_t end_frame);
    // Signed: a negative frame means the time lies before the first captured sample.
    bool frame_for_time(std::int64_t t_ns, std::int64_t& frame, std::int64_t& stamp_t, bool require_after) const;

    // Holding buffer of drained frames, indexed by absolute capture frame.
    void pend_append(const float* samples, std::uint64_t frames);
    void pend_append_silence(std::uint64_t frames);
    void pend_drop_before(std::uint64_t frame);
    std::uint64_t pend_end() const noexcept { return pend_first_ + pend_frames_; }

    CaptureIngest& ingest_;
    RecorderOptions options_;
    const std::uint32_t channels_;
    const std::uint32_t rate_;

    std::mutex mutex_;
    std::condition_variable wake_;
    std::deque<std::unique_ptr<Command>> commands_;
    bool stop_requested_ = false;
    std::vector<TakeMetadata> finished_;
    std::vector<TakeStartInfo> started_;
    std::thread worker_;

    // ---- worker-thread state ----
    std::unique_ptr<ActiveTake> active_;
    std::uint64_t cursor_frame_ = 0;            // capture frame index of the next frame in the ring
    std::deque<GapEvent> pending_gap_events_;   // from the callback, not yet reached
    std::vector<float> read_buffer_;
    std::vector<float> pend_;                   // ring of pend_capacity_ frames
    std::uint64_t pend_capacity_ = 0;
    std::uint64_t pend_first_ = 0;
    std::uint64_t pend_frames_ = 0;
    std::uint64_t preroll_frames_ = 0;
    std::deque<GapEvent> pend_gaps_;            // silence inserted into the holding buffer
    std::deque<CaptureStamp> stamps_;           // recent callback stamps

    std::atomic<RecorderState> state_{RecorderState::Idle};
    std::atomic<std::uint32_t> take_number_{0};
    std::atomic<std::uint64_t> frames_written_{0};
    std::atomic<bool> has_gaps_{false};
};

}  // namespace rr::audio
