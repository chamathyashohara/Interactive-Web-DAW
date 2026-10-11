#include "rr/audio/take_recorder.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
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
    case StopReason::Remote: return "producer_stop";
    }
    return "unknown";
}

const char* recorder_state_name(RecorderState state) noexcept {
    switch (state) {
    case RecorderState::Idle: return "idle";
    case RecorderState::Starting: return "starting";
    case RecorderState::Scheduled: return "scheduled";
    case RecorderState::Recording: return "recording";
    case RecorderState::Finalising: return "finalising";
    }
    return "unknown";
}

namespace {
constexpr std::int64_t kMaxScheduleAheadNs = 30'000'000'000LL;
constexpr std::int64_t kMaxScheduleBehindNs = 1'000'000'000LL;
constexpr std::size_t kMaxStamps = 512;
}  // namespace

struct TakeRecorder::Command {
    enum class Kind { Begin, End, Cancel, Stall } kind = Kind::End;
    std::unique_ptr<WavWriter> writer;
    TakeMetadata meta;
    std::filesystem::path session_dir;
    std::uint32_t max_take_seconds = 0;
    std::int64_t start_at_ns = 0;
    StopReason reason = StopReason::User;
    std::int64_t stop_at_ns = 0;
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

    std::int64_t start_at_ns = 0;
    bool started = false;
    std::uint64_t start_frame = 0;
    std::uint64_t write_pos = 0;

    bool end_requested = false;
    StopReason end_reason = StopReason::User;
    std::int64_t stop_at_ns = 0;
    bool stop_resolved = false;
    std::uint64_t stop_frame = 0;
};

TakeRecorder::TakeRecorder(CaptureIngest& ingest, RecorderOptions options)
    : ingest_(ingest), options_(std::move(options)), channels_(ingest.channels()), rate_(ingest.sample_rate()) {
    read_buffer_.resize(static_cast<std::size_t>(4096) * channels_);
    pend_capacity_ = static_cast<std::uint64_t>(rate_) * 4;  // 4 s holding buffer
    pend_.resize(static_cast<std::size_t>(pend_capacity_) * channels_);
    preroll_frames_ = static_cast<std::uint64_t>(rate_) * 3 / 2;  // 1.5 s kept while a start is pending
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
    if (request.start_at_ns != 0) {
        const std::int64_t now = time::monotonic_ns();
        if (request.start_at_ns > now + kMaxScheduleAheadNs || request.start_at_ns < now - kMaxScheduleBehindNs) {
            error = "scheduled start time is not within the next 30 s";
            return false;
        }
    }
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
    format.sample_rate = rate_;
    format.channels = channels_;
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
    cmd->start_at_ns = request.start_at_ns;
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
    m.scheduled_start_ns = request.start_at_ns;
    cmd->writer = std::move(writer);

    take_number_.store(request.take_number);
    frames_written_.store(0);
    has_gaps_.store(false);
    if (request.start_at_ns != 0) {
        state_.store(RecorderState::Scheduled);
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        commands_.push_back(std::move(cmd));
    }
    wake_.notify_one();
    return true;
}

void TakeRecorder::end_take(StopReason reason, std::int64_t stop_at_ns) {
    auto cmd = std::make_unique<Command>();
    cmd->kind = Command::Kind::End;
    cmd->reason = reason;
    cmd->stop_at_ns = stop_at_ns;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        commands_.push_back(std::move(cmd));
    }
    wake_.notify_one();
}

void TakeRecorder::cancel_take() {
    auto cmd = std::make_unique<Command>();
    cmd->kind = Command::Kind::Cancel;
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

std::vector<TakeStartInfo> TakeRecorder::take_started() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<TakeStartInfo> out;
    out.swap(started_);
    return out;
}

// ---------------------------------------------------------------------------------------------
// Holding buffer (worker thread only). Frame f lives at slot f % capacity; the contents always
// span [pend_first_, pend_end()) with pend_end() == cursor_frame_.

void TakeRecorder::pend_append(const float* samples, std::uint64_t frames) {
    std::uint64_t done = 0;
    while (done < frames) {
        const std::uint64_t slot = (pend_end() % pend_capacity_);
        const std::uint64_t n = std::min(frames - done, pend_capacity_ - slot);
        std::memcpy(&pend_[static_cast<std::size_t>(slot * channels_)], samples + done * channels_,
                    static_cast<std::size_t>(n * channels_) * sizeof(float));
        pend_frames_ += n;
        done += n;
    }
}

void TakeRecorder::pend_append_silence(std::uint64_t frames) {
    std::uint64_t done = 0;
    while (done < frames) {
        const std::uint64_t slot = (pend_end() % pend_capacity_);
        const std::uint64_t n = std::min(frames - done, pend_capacity_ - slot);
        std::fill_n(&pend_[static_cast<std::size_t>(slot * channels_)], static_cast<std::size_t>(n * channels_), 0.0f);
        pend_frames_ += n;
        done += n;
    }
}

void TakeRecorder::pend_drop_before(std::uint64_t frame) {
    if (frame <= pend_first_) {
        return;
    }
    const std::uint64_t drop = std::min(frame - pend_first_, pend_frames_);
    pend_first_ += drop;
    pend_frames_ -= drop;
    while (!pend_gaps_.empty() && pend_gaps_.front().start_frame + pend_gaps_.front().frames <= pend_first_) {
        pend_gaps_.pop_front();
    }
}

void TakeRecorder::trim_pending_to_preroll() {
    if (pend_frames_ > preroll_frames_) {
        pend_drop_before(pend_end() - preroll_frames_);
    }
}

// Finds the capture frame captured at local time t_ns using the first stamp at or after t_ns
// (interpolating back by the nominal rate). Without such a stamp: extrapolate from the newest
// stamp unless require_after is set.
bool TakeRecorder::frame_for_time(std::int64_t t_ns, std::int64_t& frame, std::int64_t& stamp_t,
                                  bool require_after) const {
    for (const CaptureStamp& s : stamps_) {
        if (s.t_ns >= t_ns) {
            const auto back = static_cast<std::int64_t>(std::llround(
                static_cast<double>(s.t_ns - t_ns) * static_cast<double>(rate_) / 1e9));
            frame = static_cast<std::int64_t>(s.frames_end) - back;
            stamp_t = s.t_ns;
            return true;
        }
    }
    if (require_after || stamps_.empty()) {
        return false;
    }
    const CaptureStamp& last = stamps_.back();
    const auto ahead = static_cast<std::int64_t>(
        std::llround(static_cast<double>(t_ns - last.t_ns) * static_cast<double>(rate_) / 1e9));
    frame = static_cast<std::int64_t>(last.frames_end) + ahead;
    stamp_t = last.t_ns;
    return true;
}

namespace {
std::int64_t time_for_frame(const std::deque<CaptureStamp>& stamps, std::uint64_t frame, std::uint32_t rate) {
    if (stamps.empty() || rate == 0) {
        return time::monotonic_ns();
    }
    const CaptureStamp& s = stamps.back();
    const double frames_back = static_cast<double>(s.frames_end) - static_cast<double>(frame);
    return s.t_ns - static_cast<std::int64_t>(std::llround(frames_back * 1e9 / rate));
}
}  // namespace

// ---------------------------------------------------------------------------------------------

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
                drain();
                auto take = std::make_unique<ActiveTake>();
                take->writer = std::move(cmd->writer);
                take->meta = std::move(cmd->meta);
                take->session_dir = cmd->session_dir;
                take->max_frames = static_cast<std::uint64_t>(cmd->max_take_seconds) * rate_;
                const IngestStats stats = ingest_.stats();
                take->gap_events_lost_at_start = stats.gap_events_lost;
                take->anomalies_at_start = stats.timing_anomalies;
                take->start_at_ns = cmd->start_at_ns;
                take->last_header_refresh_ns = time::monotonic_ns();
                active_ = std::move(take);
                if (active_->start_at_ns == 0) {
                    // Immediate start: the take begins with the next captured frame.
                    ActiveTake& a = *active_;
                    a.started = true;
                    a.start_frame = pend_end();
                    a.write_pos = a.start_frame;
                    pend_drop_before(a.start_frame);
                    a.meta.first_capture_frame = a.start_frame;
                    a.meta.first_sample_ns_est = time_for_frame(stamps_, a.start_frame, rate_);
                    a.meta.start_mono_ns = time::monotonic_ns();
                    a.meta.started_utc = time::format_utc_iso8601_ms(time::utc_now_ms());
                    state_.store(RecorderState::Recording);
                    std::lock_guard<std::mutex> lock(mutex_);
                    started_.push_back(TakeStartInfo{a.meta.take_number, a.start_frame, a.meta.first_sample_ns_est, 0, 0});
                } else {
                    state_.store(RecorderState::Scheduled);
                }
                break;
            }
            case Command::Kind::End:
                if (active_) {
                    if (!active_->started) {
                        cancel_pending();
                        break;
                    }
                    drain();
                    ActiveTake& a = *active_;
                    a.end_requested = true;
                    a.end_reason = cmd->reason;
                    a.stop_at_ns = cmd->stop_at_ns;
                    a.meta.scheduled_stop_ns = cmd->stop_at_ns;
                    if (cmd->stop_at_ns == 0) {
                        a.stop_resolved = true;
                        a.stop_frame = std::max(pend_end(), a.write_pos);
                    }
                }
                break;
            case Command::Kind::Cancel:
                if (active_ && !active_->started) {
                    cancel_pending();
                }
                break;
            }
        }

        drain();
        if (active_) {
            check_faults();
        }
        if (active_) {
            process_active();
        } else {
            trim_pending_to_preroll();
        }
        if (stopping) {
            if (active_) {
                if (active_->started) {
                    write_pending_until(pend_end());
                    finish(StopReason::Shutdown);
                } else {
                    cancel_pending();
                }
            }
            return;
        }
    }
}

// Moves everything currently in the capture ring into the holding buffer, inserting silence
// where the callback had to drop blocks.
void TakeRecorder::drain() {
    // Read the sample count first: every gap event that precedes these samples was published by
    // the callback before them, so it is visible once we drain the gap ring below.
    std::uint64_t frames_left = ingest_.samples().read_available() / channels_;
    GapEvent gap;
    while (ingest_.gaps().read(&gap, 1) == 1) {
        pending_gap_events_.push_back(gap);
    }
    CaptureStamp stamp;
    while (ingest_.stamps().read(&stamp, 1) == 1) {
        stamps_.push_back(stamp);
        if (stamps_.size() > kMaxStamps) {
            stamps_.pop_front();
        }
    }

    auto make_room = [this](std::uint64_t frames) {
        if (pend_frames_ + frames <= pend_capacity_) {
            return;
        }
        if (active_ && active_->started) {
            write_pending_until(pend_end());  // never lose take audio to a full holding buffer
        }
        if (pend_frames_ + frames > pend_capacity_) {
            pend_drop_before(pend_end() + frames - pend_capacity_);
        }
    };

    for (;;) {
        while (!pending_gap_events_.empty() && pending_gap_events_.front().start_frame <= cursor_frame_) {
            const GapEvent g = pending_gap_events_.front();
            pending_gap_events_.pop_front();
            make_room(g.frames);
            pend_gaps_.push_back(GapEvent{cursor_frame_, g.frames});
            pend_append_silence(g.frames);
            cursor_frame_ += g.frames;
        }
        if (frames_left == 0) {
            break;
        }
        std::uint64_t n = std::min<std::uint64_t>(frames_left, read_buffer_.size() / channels_);
        if (!pending_gap_events_.empty()) {
            n = std::min<std::uint64_t>(n, pending_gap_events_.front().start_frame - cursor_frame_);
        }
        const std::size_t got = ingest_.samples().read(read_buffer_.data(), static_cast<std::size_t>(n) * channels_);
        const std::uint64_t got_frames = got / channels_;
        if (got_frames == 0) {
            break;
        }
        make_room(got_frames);
        pend_append(read_buffer_.data(), got_frames);
        cursor_frame_ += got_frames;
        frames_left -= got_frames;
    }
}

// Writes held frames [write_pos, end) to the take, recording inserted silence as gaps.
void TakeRecorder::write_pending_until(std::uint64_t end_frame) {
    ActiveTake& a = *active_;
    end_frame = std::min(end_frame, pend_end());
    if (a.write_pos < pend_first_) {
        a.write_pos = pend_first_;  // cannot happen in normal operation; never write stale slots
    }
    if (end_frame <= a.write_pos) {
        return;
    }
    for (const GapEvent& g : pend_gaps_) {
        const std::uint64_t g_end = g.start_frame + g.frames;
        const std::uint64_t lo = std::max<std::uint64_t>(g.start_frame, std::max(a.write_pos, a.start_frame));
        const std::uint64_t hi = std::min<std::uint64_t>(g_end, end_frame);
        if (lo < hi) {
            const std::uint64_t file_frame = lo - a.start_frame;
            if (!a.meta.gaps.empty() && a.meta.gaps.back().file_frame + a.meta.gaps.back().frames == file_frame) {
                a.meta.gaps.back().frames += hi - lo;  // continuation of the same gap
            } else {
                a.meta.gaps.push_back(TakeGap{file_frame, hi - lo});
            }
            a.meta.has_gaps = true;
            has_gaps_.store(true);
        }
    }
    while (a.write_pos < end_frame && !a.writer->failed()) {
        const std::uint64_t slot = a.write_pos % pend_capacity_;
        const std::uint64_t n = std::min(end_frame - a.write_pos, pend_capacity_ - slot);
        a.writer->write_frames(&pend_[static_cast<std::size_t>(slot * channels_)], n);
        a.write_pos += n;
    }
    frames_written_.store(a.writer->frames_written());
    pend_drop_before(a.write_pos);
}

void TakeRecorder::check_faults() {
    ActiveTake& take = *active_;
    const IngestStats stats = ingest_.stats();
    if (stats.gap_events_lost > take.gap_events_lost_at_start) {
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
        if (!take.started) {
            cancel_pending();
            return;
        }
        write_pending_until(pend_end());
        finish(StopReason::DeviceLost);
    }
}

void TakeRecorder::process_active() {
    ActiveTake& a = *active_;
    if (!a.started) {
        std::int64_t wanted = 0;
        std::int64_t stamp_t = 0;
        if (!frame_for_time(a.start_at_ns, wanted, stamp_t, /*require_after=*/true)) {
            trim_pending_to_preroll();  // keep the last 1.5 s so the start frame is still held
            return;
        }
        std::uint64_t late = 0;
        std::uint64_t frame = 0;
        if (wanted < static_cast<std::int64_t>(pend_first_)) {
            // The start time is older than the audio still held (or than the first captured
            // sample): start with the oldest held frame and report by how much the start was missed.
            late = static_cast<std::uint64_t>(static_cast<std::int64_t>(pend_first_) - wanted);
            frame = pend_first_;
        } else {
            frame = static_cast<std::uint64_t>(wanted);
        }
        a.started = true;
        a.start_frame = frame;
        a.write_pos = frame;
        pend_drop_before(std::min(frame, pend_end()));
        a.meta.first_capture_frame = frame;
        a.meta.late_start_frames = late;
        a.meta.first_sample_ns_est = time_for_frame(stamps_, frame, rate_);
        a.meta.start_mono_ns = time::monotonic_ns();
        a.meta.started_utc = time::format_utc_iso8601_ms(time::utc_now_ms());
        state_.store(RecorderState::Recording);
        std::lock_guard<std::mutex> lock(mutex_);
        started_.push_back(TakeStartInfo{a.meta.take_number, frame, a.meta.first_sample_ns_est, a.start_at_ns, late});
    }

    std::uint64_t limit = pend_end();
    if (a.end_requested && !a.stop_resolved) {
        std::int64_t frame = 0;
        std::int64_t stamp_t = 0;
        if (frame_for_time(a.stop_at_ns, frame, stamp_t, /*require_after=*/true)) {
            a.stop_resolved = true;
            a.stop_frame = std::max(static_cast<std::uint64_t>(std::max<std::int64_t>(frame, 0)), a.write_pos);
        } else if (frame_for_time(a.stop_at_ns, frame, stamp_t, /*require_after=*/false)) {
            // Hold back what may lie after the stop until a stamp confirms the exact frame.
            limit = std::min(limit, std::max(static_cast<std::uint64_t>(std::max<std::int64_t>(frame, 0)), a.write_pos));
        }
    }
    if (a.stop_resolved) {
        limit = std::min(limit, a.stop_frame);
    }
    if (a.max_frames != 0) {
        limit = std::min(limit, a.start_frame + a.max_frames);
    }
    write_pending_until(limit);

    if (a.writer->failed()) {
        finish(StopReason::DiskError);
        return;
    }
    if (a.stop_resolved && a.write_pos >= a.stop_frame) {
        finish(a.end_reason);
        return;
    }
    if (a.max_frames != 0 && a.write_pos - a.start_frame >= a.max_frames) {
        finish(StopReason::SafetyLimit);
        return;
    }
    const std::int64_t now = time::monotonic_ns();
    if (now - a.last_header_refresh_ns >=
        std::chrono::duration_cast<std::chrono::nanoseconds>(options_.header_refresh_interval).count()) {
        a.writer->refresh_header();  // failure latches in the writer; seen next cycle
        a.last_header_refresh_ns = now;
    }
}

void TakeRecorder::cancel_pending() {
    ActiveTake& take = *active_;
    TakeMetadata& m = take.meta;
    take.writer->abandon();
    std::error_code ec;
    // The file holds only a header (no audio was ever written): removing it loses nothing.
    std::filesystem::remove(take.session_dir / m.partial_file_name, ec);
    m.status = TakeStatus::Cancelled;
    m.finalised = false;
    m.frames = 0;
    m.stop_reason = "cancelled";
    m.stopped_utc = time::format_utc_iso8601_ms(time::utc_now_ms());
    std::string json_error;
    if (!write_text_file_atomically(take.session_dir / m.metadata_file_name, to_json(m), json_error)) {
        m.error = (m.error.empty() ? "" : m.error + "; ") + "metadata not written: " + json_error;
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        finished_.push_back(m);
    }
    active_.reset();
    frames_written_.store(0);
    state_.store(RecorderState::Idle);
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
