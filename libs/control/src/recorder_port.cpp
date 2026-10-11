#include "rr/control/recorder_port.hpp"

#include <fstream>
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
    auto add = [&r](ReadyItem item, bool ok, std::string detail) {
        r.checks.push_back(ReadinessCheck{item, ok, true, detail});
        if (!ok) {
            r.reasons.push_back(std::string(ready_item_label(item)) + ": " + detail);
        }
    };
    const bool open = engine_.capture_open();
    add(ReadyItem::InputDevice, open, open ? engine_.capture_description().device_name : "no input device open");

    // Healthy: callbacks arrived within the last 500 ms, no device fault, required rate.
    std::string engine_detail;
    bool engine_ok = false;
    if (!open) {
        engine_detail = "no input device";
    } else {
        const auto& d = engine_.capture_description();
        const audio::IngestStats st = engine_.ingest()->stats();
        const std::int64_t age_ns = st.last_callback_ns == 0 ? -1 : time::monotonic_ns() - st.last_callback_ns;
        if (engine_.capture_fault() != audio::DeviceFault::None) {
            engine_detail = "device fault (stopped or rerouted)";
        } else if (age_ns < 0 || age_ns > 500'000'000) {
            engine_detail = "no capture callbacks in the last 500 ms";
        } else if (d.sample_rate != config_.audio.required_sample_rate_hz) {
            engine_detail = "input at " + std::to_string(d.sample_rate) + " Hz, " +
                            std::to_string(config_.audio.required_sample_rate_hz) + " Hz required";
        } else {
            engine_ok = true;
            engine_detail = std::to_string(d.sample_rate) + " Hz, " + std::to_string(d.channels) + " ch, last callback " +
                            std::to_string(age_ns / 1'000'000) + " ms ago, record-ring overruns " +
                            std::to_string(st.overrun_events);
        }
    }
    add(ReadyItem::EngineHealthy, engine_ok, engine_detail);

    // Writable: create the folder and write + delete a small probe file.
    std::error_code ec;
    std::filesystem::create_directories(root_, ec);
    const std::filesystem::path probe = root_ / ".rr_write_test";
    bool writable = false;
    {
        std::ofstream out(probe, std::ios::binary | std::ios::trunc);
        out << "rr";
        writable = static_cast<bool>(out);
    }
    std::filesystem::remove(probe, ec);
    add(ReadyItem::FolderWritable, writable,
        (writable ? "" : "cannot write in ") + audio::path_to_utf8(root_));

    // Disk policy: the longest allowed take at the device format (48 kHz stereo if no device) + 1 MB.
    const std::uint64_t rate = open ? engine_.capture_description().sample_rate : 48000;
    const std::uint64_t channels = open ? engine_.capture_description().channels : 2;
    const std::uint64_t needed = static_cast<std::uint64_t>(config_.timing.max_take_seconds) * rate * channels * 4ULL +
                                 (1ULL << 20);
    const std::uint64_t free_bytes = audio::available_disk_bytes(root_);
    add(ReadyItem::DiskSpace, free_bytes >= needed,
        std::to_string(free_bytes >> 20) + " MB free, " + std::to_string(needed >> 20) + " MB needed for " +
            std::to_string(config_.timing.max_take_seconds) + " s");

    const bool active = open && engine_.recorder() != nullptr &&
                        engine_.recorder()->status().state != audio::RecorderState::Idle;
    add(ReadyItem::NoActiveRecording, !active, active ? "a local take is still active" : "idle");
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
        e.device_period_frames = engine_.capture_description().device_period_frames;
        e.device_periods = engine_.capture_description().device_periods;
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
    // TEST RECORDER: the device-side items are simulated (labelled in the detail text).
    r.checks.push_back(ReadinessCheck{ReadyItem::InputDevice, ready_, true, ready_ ? "TEST RECORDER" : not_ready_reason_});
    r.checks.push_back(ReadinessCheck{ReadyItem::EngineHealthy, true, true, "TEST RECORDER"});
    r.checks.push_back(ReadinessCheck{ReadyItem::FolderWritable, true, true, "TEST RECORDER (nothing is written)"});
    r.checks.push_back(ReadinessCheck{ReadyItem::DiskSpace, true, true, "TEST RECORDER (nothing is written)"});
    r.checks.push_back(ReadinessCheck{ReadyItem::NoActiveRecording, !active_, true, active_ ? "a local take is still active" : "idle"});
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
