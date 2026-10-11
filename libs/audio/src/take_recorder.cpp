#include "rr/audio/take_recorder.hpp"

#include <algorithm>
#include <utility>

#include "rr/audio/take_naming.hpp"
#include "rr/shared/clock.hpp"

namespace rr::audio {

const char* stop_reason_name(StopReason reason) noexcept {
    switch (reason) {
    case StopReason::User: return "user";
    case StopReason::Shutdown: return "shutdown";
    case StopReason::SafetyLimit: return "safety_limit";
    case StopReason::DeviceLost: return "device_lost";
    case StopReason::DiskError: return "disk_error";
    }
    return "unknown";
}

const char* recorder_state_name(RecorderState state) noexcept {
    switch (state) {
    case RecorderState::Idle: return "idle";
    case RecorderState::Starting: return "starting";
    case RecorderState::Recording: return "recording";
    case RecorderState::Finalising: return "finalising";
    }
    return "unknown";
}

struct TakeRecorder::Command {
    enum class Kind { Begin, End, Stall } kind = Kind::End;
    std::unique_ptr<WavWriter> writer;
    TakeMetadata meta;
    std::filesystem::path session_dir;
    std::uint32_t max_take_seconds = 0;
    StopReason reason = StopReason::User;
    std::chrono::milliseconds stall{0};
};

struct TakeRecorder::ActiveTake {
    std::unique_ptr<WavWriter> writer;
    TakeMetadata meta;
    std::filesystem::path session_dir;
    std::uint64_t max_frames = 0;
    std::uint64_t gap_events_lost_at_start = 0;
    std::uint64_t anomalies_at_start = 0;
    std::int64_t last_header_refresh_ns = 0;
    bool end_requested = false;
    StopReason end_reason = StopReason::User;
};

TakeRecorder::TakeRecorder(CaptureIngest& ingest, RecorderOptions options)
    : ingest_(ingest), options_(std::move(options)) {
    buffer_.resize(static_cast<std::size_t>(4096) * ingest_.channels());
}

TakeRecorder::~TakeRecorder() {
    stop();
}

void TakeRecorder::start() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (worker_.joinable()) {
        return;
    }
    stop_requested_ = false;
    worker_ = std::thread([this] { worker_loop(); });
}

void TakeRecorder::stop() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!worker_.joinable()) {
            return;
        }
        stop_requested_ = true;
    }
    wake_.notify_one();
    worker_.join();
}

bool TakeRecorder::begin_take(const TakeRequest& request, std::string& error) {
    RecorderState expected = RecorderState::Idle;
    if (!state_.compare_exchange_strong(expected, RecorderState::Starting)) {
        error = std::string("a take is already ") + recorder_state_name(expected);
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!worker_.joinable()) {
            state_.store(RecorderState::Idle);
            error = "recorder is not running (no open input device)";
            return false;
        }
    }

    WavFormat format;
    format.sample_rate = ingest_.sample_rate();
    format.channels = ingest_.channels();
    const std::string stem = take_stem(request.take_number, request.role, request.session_id);
    const std::filesystem::path final_path = request.session_dir / (stem + ".wav");

    auto writer = std::make_unique<WavWriter>(options_.opener);
    if (!writer->open(final_path, format)) {
        error = writer->error();
        state_.store(RecorderState::Idle);
        return false;
    }

    auto cmd = std::make_unique<Command>();
    cmd->kind = Command::Kind::Begin;
    cmd->session_dir = request.session_dir;
    cmd->max_take_seconds = request.max_take_seconds;
    TakeMetadata& m = cmd->meta;
    m.take_number = request.take_number;
    m.role = request.role;
    m.session_id = request.session_id;
    m.app_version = request.app_version;
    m.file_name = path_to_utf8(final_path.filename());
    m.partial_file_name = path_to_utf8(writer->partial_path().filename());
    m.metadata_file_name = stem + ".json";
    m.sample_rate = format.sample_rate;
    m.channels = format.channels;
    m.wav_format_tag = format.format_tag();
    m.capture = request.capture;
    cmd->writer = std::move(writer);

    take_number_.store(request.take_number);
    frames_written_.store(0);
    has_gaps_.store(false);
    {
        std::lock_guard<std::mutex> lock(mutex_);
        commands_.push_back(std::move(cmd));
    }
    wake_.notify_one();
    return true;
}

void TakeRecorder::end_take(StopReason reason) {
    auto cmd = std::make_unique<Command>();
    cmd->kind = Command::Kind::End;
    cmd->reason = reason;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        commands_.push_back(std::move(cmd));
    }
    wake_.notify_one();
}

void TakeRecorder::inject_stall(std::chrono::milliseconds duration) {
    auto cmd = std::make_unique<Command>();
    cmd->kind = Command::Kind::Stall;
    cmd->stall = duration;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        commands_.push_back(std::move(cmd));
    }
    wake_.notify_one();
}

RecorderStatus TakeRecorder::status() const noexcept {
    RecorderStatus s;
    s.state = state_.load();
    s.take_number = take_number_.load();
    s.frames_written = frames_written_.load();
    s.has_gaps = has_gaps_.load();
    return s;
}

std::vector<TakeMetadata> TakeRecorder::take_finished() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<TakeMetadata> out;
    out.swap(finished_);
    return out;
}

void TakeRecorder::worker_loop() {
    for (;;) {
        std::deque<std::unique_ptr<Command>> commands;
        bool stopping = false;
        {
            std::unique_lock<std::mutex> lock(mutex_);
            wake_.wait_for(lock, options_.poll_interval, [this] { return stop_requested_ || !commands_.empty(); });
            commands.swap(commands_);
            stopping = stop_requested_;
        }

        for (auto& cmd : commands) {
            switch (cmd->kind) {
            case Command::Kind::Stall:
                std::this_thread::sleep_for(cmd->stall);
                break;
            case Command::Kind::Begin: {
                drain();  // everything captured before this point is not part of the take
                auto take = std::make_unique<ActiveTake>();
                take->writer = std::move(cmd->writer);
                take->meta = std::move(cmd->meta);
                take->session_dir = cmd->session_dir;
                take->max_frames = static_cast<std::uint64_t>(cmd->max_take_seconds) * ingest_.sample_rate();
                const IngestStats stats = ingest_.stats();
                take->gap_events_lost_at_start = stats.gap_events_lost;
                take->anomalies_at_start = stats.timing_anomalies;
                take->meta.first_capture_frame = cursor_frame_;
                take->meta.start_mono_ns = time::monotonic_ns();
                take->meta.started_utc = time::format_utc_iso8601_ms(time::utc_now_ms());
                take->last_header_refresh_ns = take->meta.start_mono_ns;
                active_ = std::move(take);
                state_.store(RecorderState::Recording);
                break;
            }
            case Command::Kind::End:
                if (active_) {
                    active_->end_requested = true;
                    active_->end_reason = cmd->reason;
                }
                break;
            }
        }

        drain();
        if (active_) {
            check_active_take();
        }
        if (stopping) {
            if (active_) {
                finish(StopReason::Shutdown);
            }
            return;
        }
    }
}

// Moves everything currently in the capture ring to the active take (or discards it when no
// take is active), inserting silence where the callback had to drop blocks.
void TakeRecorder::drain() {
    const std::uint32_t channels = ingest_.channels();
    // Read the sample count first: every gap event that precedes these samples was published
    // by the callback before them, so it is visible once we drain the gap ring below.
    std::uint64_t frames_left = ingest_.samples().read_available() / channels;
    GapEvent gap;
    while (ingest_.gaps().read(&gap, 1) == 1) {
        pending_gaps_.push_back(gap);
    }

    for (;;) {
        // Gaps that start exactly here come first.
        while (!pending_gaps_.empty() && pending_gaps_.front().start_frame <= cursor_frame_) {
            const GapEvent g = pending_gaps_.front();
            pending_gaps_.pop_front();
            if (active_) {
                active_->meta.has_gaps = true;
                has_gaps_.store(true);
                active_->meta.gaps.push_back(TakeGap{active_->writer->frames_written(), g.frames});
                active_->writer->write_silence(g.frames);
                frames_written_.store(active_->writer->frames_written());
            }
            cursor_frame_ += g.frames;
        }
        if (frames_left == 0) {
            break;
        }
        std::uint64_t n = std::min<std::uint64_t>(frames_left, buffer_.size() / channels);
        if (!pending_gaps_.empty()) {
            n = std::min<std::uint64_t>(n, pending_gaps_.front().start_frame - cursor_frame_);
        }
        const std::size_t got = ingest_.samples().read(buffer_.data(), static_cast<std::size_t>(n) * channels);
        const std::uint64_t got_frames = got / channels;
        if (active_ && !active_->writer->failed()) {
            active_->writer->write_frames(buffer_.data(), got_frames);
            frames_written_.store(active_->writer->frames_written());
        }
        cursor_frame_ += got_frames;
        frames_left -= got_frames;
        if (got_frames == 0) {
            break;
        }
    }
}

void TakeRecorder::check_active_take() {
    ActiveTake& take = *active_;
    const IngestStats stats = ingest_.stats();
    if (stats.gap_events_lost > take.gap_events_lost_at_start) {
        // Overruns happened whose positions are unknown: the timeline after them is not exact.
        take.meta.has_gaps = true;
        take.meta.gap_positions_complete = false;
        has_gaps_.store(true);
    }

    if (take.writer->failed()) {
        finish(StopReason::DiskError);
        return;
    }
    const DeviceFault fault = ingest_.device_fault();
    const std::int64_t now = time::monotonic_ns();
    const bool stalled = ingest_.device_running() && stats.last_callback_ns != 0 &&
                         now - stats.last_callback_ns >
                             std::chrono::duration_cast<std::chrono::nanoseconds>(options_.device_stall_timeout).count();
    if (fault != DeviceFault::None || stalled) {
        take.meta.error = fault == DeviceFault::Rerouted ? "audio stream was moved to another device"
                          : fault == DeviceFault::StoppedUnexpectedly
                              ? "input device stopped (unplugged, disabled or failed)"
                              : "input device stopped delivering audio (no callback for " +
                                    std::to_string(options_.device_stall_timeout.count()) + " ms)";
        finish(StopReason::DeviceLost);
        return;
    }
    if (take.max_frames != 0 && take.writer->frames_written() >= take.max_frames) {
        finish(StopReason::SafetyLimit);
        return;
    }
    if (take.end_requested) {
        finish(take.end_reason);
        return;
    }
    if (now - take.last_header_refresh_ns >=
        std::chrono::duration_cast<std::chrono::nanoseconds>(options_.header_refresh_interval).count()) {
        take.writer->refresh_header();  // failure latches in the writer; seen next cycle
        take.last_header_refresh_ns = now;
    }
}

void TakeRecorder::finish(StopReason reason) {
    state_.store(RecorderState::Finalising);
    ActiveTake& take = *active_;
    TakeMetadata& m = take.meta;
    m.stop_reason = stop_reason_name(reason);
    m.stopped_utc = time::format_utc_iso8601_ms(time::utc_now_ms());
    m.timing_anomalies = ingest_.stats().timing_anomalies - take.anomalies_at_start;

    WavWriter& w = *take.writer;
    if (reason == StopReason::DiskError || w.failed()) {
        if (m.error.empty()) {
            m.error = w.error();
        }
        w.abandon();
        m.status = TakeStatus::IncompleteDisk;
        m.finalised = false;
    } else {
        const bool ok = w.finalise();
        m.finalised = ok;
        if (!ok) {
            m.status = TakeStatus::IncompleteDisk;
            m.error = (m.error.empty() ? "" : m.error + "; ") + "finalisation failed: " + w.error();
            w.abandon();
        } else if (reason == StopReason::DeviceLost) {
            m.status = TakeStatus::IncompleteDevice;  // file is valid but the take ended early
        } else if (reason == StopReason::Shutdown) {
            m.status = TakeStatus::CompleteShutdown;
        } else {
            m.status = TakeStatus::Complete;
        }
    }
    m.frames = w.frames_written();
    frames_written_.store(m.frames);

    std::string json_error;
    if (!write_text_file_atomically(take.session_dir / m.metadata_file_name, to_json(m), json_error)) {
        m.error = (m.error.empty() ? "" : m.error + "; ") + "metadata not written: " + json_error;
    }

    {
        std::lock_guard<std::mutex> lock(mutex_);
        finished_.push_back(m);
    }
    active_.reset();
    state_.store(RecorderState::Idle);
}

}  // namespace rr::audio
