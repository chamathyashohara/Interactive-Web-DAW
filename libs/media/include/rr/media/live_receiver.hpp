#pragma once

// Performer side of the one-way live stream (Stage 7, ADR-017): producer microphone ->
// network -> this PC's output. Since Stage 8 this is a thin wrapper over LiveEndpoint (one
// incoming stream 1, no outgoing stream); the Stage 7 API and statistics are unchanged. Separate from both master recordings: nothing here reads or
// writes a take file, and concealment only ever affects what is heard.
//
// Threads:
//   media-receive thread: UDP recv -> validate (PROTOCOL_OVERVIEW §2.1) -> arrival statistics
//                         -> bounded SPSC packet queue (64); every 500 ms a receiver report
//                         to the producer (which also tells it where to send).
//   playback callback:    render_add(): queue -> jitter buffer -> Opus decode or PLC -> gain
//                         -> added to the output. Preallocated state only; no locks, no I/O.

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "rr/audio/live_tap.hpp"
#include "rr/audio/spsc_ring.hpp"
#include "rr/media/arrival_stats.hpp"
#include "rr/media/jitter_buffer.hpp"
#include "rr/media/live_endpoint.hpp"
#include "rr/media/live_settings.hpp"
#include "rr/media/media_packet.hpp"
#include "rr/media/net_impairment.hpp"
#include "rr/media/opus_codec.hpp"
#include "rr/network/socket.hpp"
#include "rr/shared/log.hpp"

namespace rr::media {

struct LiveReceiverConfig {
    std::string producer_host;        // the producer's address (the control connection's host)
    std::uint16_t media_port = 0;     // the producer's media port (control port + 1 by default)
    std::uint32_t session_id = 0;
    LivePlayoutSettings playout;
    std::uint32_t report_interval_ms = 500;
    ImpairmentSettings test_receive_impairment;  // TEST ONLY: drops/dups applied on arrival
};

struct LiveReceiverStats {
    bool running = false;
    std::string producer_endpoint;
    std::string local_endpoint;
    // receive thread
    ArrivalSnapshot arrival;
    InvalidCounts invalid;
    std::uint64_t queue_full_drops = 0;   // playback not consuming (no output device, or stalled)
    std::uint64_t end_of_stream = 0;
    std::uint64_t reports_sent = 0;
    std::uint64_t report_send_errors = 0;
    std::uint64_t test_dropped = 0;       // TEST impairment only
    double last_packet_age_ms = -1.0;     // -1 = nothing received yet
    // playback callback
    bool output_enabled = false;
    bool jb_playing = false;
    std::uint32_t jb_held = 0;
    std::uint32_t jb_max_held = 0;
    std::uint32_t jb_target = 0;
    JitterStats jb;
    std::uint64_t concealed = 0;          // frames produced by Opus PLC (lost + underrun)
    std::uint64_t decode_errors = 0;
    std::uint64_t render_callbacks = 0;
    std::uint64_t wrong_rate_callbacks = 0;  // output not at 48 kHz: live audio not played
    std::uint64_t frames_output = 0;
    std::int64_t max_render_ns = 0;
    double last_render_age_ms = -1.0;     // -1 = never rendered (no output device attached)
    std::uint32_t last_frame_samples = 0;
    float gain_db = 0.0f;
    // peak of the live contribution over the last second, dBFS; -200 = silent
    float output_peak_dbfs = -200.0f;
};

class LiveReceiver final : public audio::PlaybackContributor {
public:
    explicit LiveReceiver(log::Logger* logger = nullptr);
    ~LiveReceiver() override;
    LiveReceiver(const LiveReceiver&) = delete;
    LiveReceiver& operator=(const LiveReceiver&) = delete;

    // Opens the UDP socket (connected to the producer's media endpoint) and starts the thread.
    bool start(const LiveReceiverConfig& config, std::string& error);
    // Sends a closing report and stops the thread. Detach from the audio engine BEFORE this.
    void stop();
    bool running() const noexcept { return endpoint_.running(); }

    void set_output_enabled(bool on) noexcept;
    bool output_enabled() const noexcept;
    void set_gain_db(float db) noexcept;
    void set_target_frames(std::uint32_t frames) noexcept;

    // Playback callback (real-time).
    void render_add(float* out, std::uint32_t frames, std::uint32_t channels, std::uint32_t sample_rate) noexcept override;

    LiveReceiverStats stats() const;

private:
    LiveEndpoint endpoint_;
};

}  // namespace rr::media
