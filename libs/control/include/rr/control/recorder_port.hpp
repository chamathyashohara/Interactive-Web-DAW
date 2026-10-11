#pragma once

// What the session controller needs from "the thing that records locally". Two implementations:
//  - AudioRecorderPort: the real capture engine (Stage 4/5), takes written as WAV;
//  - TestRecorderPort:  "TEST RECORDER (no audio)": simulates start/stop timing, writes nothing.
// All calls happen on the controller's thread.

#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "rr/shared/config.hpp"
#include "rr/shared/error_codes.hpp"
#include "rr/shared/role.hpp"

namespace rr::audio {
class AudioEngine;
}

namespace rr::control {

struct LocalReadiness {
    bool ok = false;
    std::vector<std::string> reasons;  // why not ready (empty when ok)
};

struct PortTakeSpec {
    std::uint32_t take_id = 0;
    std::string session_id;
    Role role = Role::Producer;
    std::uint32_t max_take_seconds = 1800;
    std::int64_t start_at_ns = 0;  // local monotonic time of the first sample
};

enum class PortEventKind { Started, Finalised };

struct PortEvent {
    PortEventKind kind = PortEventKind::Started;
    std::uint32_t take_id = 0;
    // Started
    std::uint64_t first_frame = 0;
    std::int64_t first_sample_ns = 0;
    std::uint64_t late_frames = 0;
    // Finalised
    TakeStatus status = TakeStatus::Complete;
    bool finalised = false;
    std::uint64_t frames = 0;
    std::uint32_t sample_rate = 0;
    std::string stop_reason;
    std::string error;
    std::string file;  // full path of the WAV (or .partial) for display
};

class RecorderPort {
public:
    virtual ~RecorderPort() = default;
    virtual LocalReadiness readiness() = 0;
    virtual bool schedule_take(const PortTakeSpec& spec, std::string& error) = 0;
    // stop_at_ns = 0: stop now. `remote` = the producer asked for it.
    virtual void schedule_stop(std::int64_t stop_at_ns, bool remote) = 0;
    virtual void cancel_take() = 0;  // only before the take started
    virtual std::vector<PortEvent> poll() = 0;
    virtual std::string description() const = 0;
};

// Real recording through the audio engine. Takes go to
// <recordings_root>/<YYYYMMDD-HHMMSS>_<session id>/take<NN>_<role>_<session id>.wav, where the
// session id is the one shared by both PCs (VER-02) and NN is the control take id.
class AudioRecorderPort final : public RecorderPort {
public:
    AudioRecorderPort(audio::AudioEngine& engine, std::filesystem::path recordings_root, AppConfig config);
    LocalReadiness readiness() override;
    bool schedule_take(const PortTakeSpec& spec, std::string& error) override;
    void schedule_stop(std::int64_t stop_at_ns, bool remote) override;
    void cancel_take() override;
    std::vector<PortEvent> poll() override;
    std::string description() const override;

    void set_recordings_root(std::filesystem::path root) { root_ = std::move(root); }
    std::filesystem::path current_session_dir() const { return session_dir_; }

private:
    audio::AudioEngine& engine_;
    std::filesystem::path root_;
    AppConfig config_;
    std::string session_id_;
    std::filesystem::path session_dir_;
};

// No audio: "starts" when its clock reaches the scheduled time, counts frames at a nominal
// 48 kHz, "finalises" on stop. Clearly labelled; used by the CLI two-instance test and unit tests.
class TestRecorderPort final : public RecorderPort {
public:
    LocalReadiness readiness() override;
    bool schedule_take(const PortTakeSpec& spec, std::string& error) override;
    void schedule_stop(std::int64_t stop_at_ns, bool remote) override;
    void cancel_take() override;
    std::vector<PortEvent> poll() override;
    std::string description() const override { return "TEST RECORDER (no audio, nothing is written)"; }

    // Test hooks.
    void set_ready(bool ready, const std::string& reason = "test: not ready");
    void fail_next_schedule(const std::string& error) { fail_next_ = error; }
    void simulate_fault() { fault_ = true; }

private:
    bool ready_ = true;
    std::string not_ready_reason_;
    std::string fail_next_;
    bool fault_ = false;
    bool active_ = false;
    bool started_ = false;
    bool stopping_ = false;
    bool remote_stop_ = false;
    PortTakeSpec spec_;
    std::int64_t stop_at_ns_ = 0;
    std::vector<PortEvent> events_;
};

}  // namespace rr::control
