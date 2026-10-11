#include "rr/control/recorder_port.hpp"

#include <system_error>

#include "rr/audio/audio_engine.hpp"
#include "rr/audio/file_io.hpp"
#include "rr/audio/take_naming.hpp"
#include "rr/shared/build_info.hpp"
#include "rr/shared/clock.hpp"

namespace rr::control {

// ---------------------------------------------------------------------------------------------
AudioRecorderPort::AudioRecorderPort(audio::AudioEngine& engine, std::filesystem::path recordings_root,
                                     AppConfig config)
    : engine_(engine), root_(std::move(recordings_root)), config_(config) {}

LocalReadiness AudioRecorderPort::readiness() {
    LocalReadiness r;
    if (!engine_.capture_open()) {
        r.reasons.emplace_back("input device not open");
    } else {
        if (engine_.capture_fault() != audio::DeviceFault::None) {
            r.reasons.emplace_back("input device fault");
        }
        const auto& d = engine_.capture_description();
        const std::uint64_t needed = static_cast<std::uint64_t>(config_.timing.max_take_seconds) * d.sample_rate *
                                         d.channels * 4ULL + (1ULL << 20);
        std::error_code ec;
        std::filesystem::create_directories(root_, ec);
        const std::uint64_t free_bytes = audio::available_disk_bytes(root_);
        if (free_bytes < needed) {
            r.reasons.emplace_back("not enough disk space (" + std::to_string(free_bytes >> 20) + " MB free, " +
                                   std::to_string(needed >> 20) + " MB needed)");
        }
        if (auto* rec = engine_.recorder(); rec != nullptr && rec->status().state != audio::RecorderState::Idle) {
            r.reasons.emplace_back("a local take is still active");
        }
    }
    r.ok = r.reasons.empty();
    return r;
}

bool AudioRecorderPort::schedule_take(const PortTakeSpec& spec, std::string& error) {
    audio::TakeRecorder* rec = engine_.recorder();
    if (rec == nullptr) {
        error = "input device not open";
        return false;
    }
    if (spec.session_id != session_id_ || session_dir_.empty()) {
        session_id_ = spec.session_id;
        session_dir_ = root_ / audio::session_folder_name(time::utc_now_ms(), spec.session_id);
    }
    std::error_code ec;
    std::filesystem::create_directories(session_dir_, ec);
    if (ec) {
        error = "cannot create " + audio::path_to_utf8(session_dir_) + ": " + ec.message();
        return false;
    }
    audio::TakeRequest r;
    r.session_dir = session_dir_;
    r.take_number = spec.take_id;
    r.role = spec.role;
    r.session_id = spec.session_id;
    r.app_version = build_info().version + " (" + build_info().git_commit + ")";
    r.max_take_seconds = spec.max_take_seconds;
    r.capture = engine_.capture_description();
    r.start_at_ns = spec.start_at_ns;
    return rec->begin_take(r, error);
}

void AudioRecorderPort::schedule_stop(std::int64_t stop_at_ns, bool remote) {
    if (audio::TakeRecorder* rec = engine_.recorder()) {
        rec->end_take(remote ? audio::StopReason::Remote : audio::StopReason::User, stop_at_ns);
    }
}

void AudioRecorderPort::cancel_take() {
    if (audio::TakeRecorder* rec = engine_.recorder()) {
        rec->cancel_take();
    }
}

std::vector<PortEvent> AudioRecorderPort::poll() {
    std::vector<PortEvent> out;
    audio::TakeRecorder* rec = engine_.recorder();
    if (rec == nullptr) {
        return out;
    }
    for (const auto& s : rec->take_started()) {
        PortEvent e;
        e.kind = PortEventKind::Started;
        e.take_id = s.take_number;
        e.first_frame = s.first_frame;
        e.first_sample_ns = s.first_sample_ns;
        e.late_frames = s.late_frames;
        out.push_back(e);
    }
    for (const auto& m : rec->take_finished()) {
        PortEvent e;
        e.kind = PortEventKind::Finalised;
        e.take_id = m.take_number;
        e.status = m.status;
        e.finalised = m.finalised;
        e.frames = m.frames;
        e.sample_rate = m.sample_rate;
        e.stop_reason = m.stop_reason;
        e.error = m.error;
        e.file = audio::path_to_utf8(session_dir_ / (m.finalised ? m.file_name : m.partial_file_name));
        out.push_back(e);
    }
    return out;
}

std::string AudioRecorderPort::description() const {
    return engine_.capture_open() ? "audio input: " + engine_.capture_description().device_name
                                  : "audio input: (closed)";
}

// ---------------------------------------------------------------------------------------------
void TestRecorderPort::set_ready(bool ready, const std::string& reason) {
    ready_ = ready;
    not_ready_reason_ = reason;
}

LocalReadiness TestRecorderPort::readiness() {
    LocalReadiness r;
    if (!ready_) {
        r.reasons.push_back(not_ready_reason_);
    }
    if (active_) {
        r.reasons.emplace_back("a local take is still active");
    }
    r.ok = r.reasons.empty();
    return r;
}

bool TestRecorderPort::schedule_take(const PortTakeSpec& spec, std::string& error) {
    if (!fail_next_.empty()) {
        error = fail_next_;
        fail_next_.clear();
        return false;
    }
    if (active_) {
        error = "a take is already active";
        return false;
    }
    spec_ = spec;
    active_ = true;
    started_ = false;
    stopping_ = false;
    fault_ = false;
    return true;
}

void TestRecorderPort::schedule_stop(std::int64_t stop_at_ns, bool remote) {
    if (!active_) {
        return;
    }
    stopping_ = true;
    remote_stop_ = remote;
    stop_at_ns_ = stop_at_ns == 0 ? time::monotonic_ns() : stop_at_ns;
}

void TestRecorderPort::cancel_take() {
    if (active_ && !started_) {
        active_ = false;
        PortEvent e;
        e.kind = PortEventKind::Finalised;
        e.take_id = spec_.take_id;
        e.status = TakeStatus::Cancelled;
        e.stop_reason = "cancelled";
        events_.push_back(e);
    }
}

std::vector<PortEvent> TestRecorderPort::poll() {
    const std::int64_t now = time::monotonic_ns();
    if (active_ && !started_ && now >= spec_.start_at_ns) {
        started_ = true;
        PortEvent e;
        e.kind = PortEventKind::Started;
        e.take_id = spec_.take_id;
        e.first_frame = 0;
        e.first_sample_ns = spec_.start_at_ns;
        e.late_frames = static_cast<std::uint64_t>((now - spec_.start_at_ns) > 50'000'000 ? (now - spec_.start_at_ns) * 48 / 1'000'000 : 0);
        events_.push_back(e);
    }
    if (active_ && started_ && (fault_ || (stopping_ && now >= stop_at_ns_))) {
        const std::int64_t end = fault_ ? now : stop_at_ns_;
        PortEvent e;
        e.kind = PortEventKind::Finalised;
        e.take_id = spec_.take_id;
        e.status = fault_ ? TakeStatus::IncompleteDevice : TakeStatus::Complete;
        e.finalised = true;
        e.frames = static_cast<std::uint64_t>((end - spec_.start_at_ns) * 48 / 1'000'000);
        e.sample_rate = 48000;
        e.stop_reason = fault_ ? "device_lost" : (remote_stop_ ? "producer_stop" : "user");
        e.error = fault_ ? "test: simulated device fault" : "";
        e.file = "(test recorder: no file)";
        events_.push_back(e);
        active_ = false;
        fault_ = false;
    }
    std::vector<PortEvent> out;
    out.swap(events_);
    return out;
}

}  // namespace rr::control
