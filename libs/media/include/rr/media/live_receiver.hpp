#pragma once

// Performer side of the one-way live stream (Stage 7, ADR-017): producer microphone ->
// network -> this PC's output. Separate from both master recordings: nothing here reads or
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
    bool running() const noexcept { return running_.load(); }

    void set_output_enabled(bool on) noexcept { output_enabled_.store(on); }
    bool output_enabled() const noexcept { return output_enabled_.load(); }
    void set_gain_db(float db) noexcept;
    void set_target_frames(std::uint32_t frames) noexcept { target_frames_.store(frames); }

    // Playback callback (real-time).
    void render_add(float* out, std::uint32_t frames, std::uint32_t channels, std::uint32_t sample_rate) noexcept override;

    LiveReceiverStats stats() const;

private:
    void thread_main();
    void handle_datagram(const std::uint8_t* data, long size, const net::Endpoint& from, std::int64_t now);
    void send_report(bool closing);
    bool next_frame() noexcept;  // callback: fills pcm_; false while filling

    log::Logger* log_;
    LiveReceiverConfig cfg_;
    net::UdpSocket socket_;
    net::Endpoint producer_;
    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> stop_requested_{false};

    // receive thread -> callback
    audio::SpscRing<JbPacket> queue_{64};

    // receive-thread state (published under stats_mutex_)
    mutable std::mutex stats_mutex_;
    ArrivalStats arrival_;
    InvalidCounts invalid_;
    std::uint64_t queue_full_drops_ = 0;
    std::uint64_t eos_ = 0;
    std::uint64_t reports_sent_ = 0;
    std::uint64_t report_errors_ = 0;
    std::uint64_t test_dropped_ = 0;
    std::int64_t last_packet_ns_ = 0;
    std::uint32_t report_seq_ = 0;
    Impairment receive_impairment_;
    JbPacket rx_packet_;

    // callback state (touched only inside render_add)
    JitterBuffer jb_;
    OpusLiveDecoder decoder_;
    float pcm_[OpusLiveDecoder::kMaxFrameSamples] = {};
    std::uint32_t pcm_len_ = 0;
    std::uint32_t pcm_pos_ = 0;
    std::uint32_t frame_samples_ = 480;
    JbPacket cb_packet_;
    bool was_enabled_ = false;
    float window_peak_ = 0.0f;
    std::uint64_t window_frames_ = 0;

    // control -> callback
    std::atomic<bool> output_enabled_{false};
    std::atomic<float> gain_linear_{0.25f};
    std::atomic<float> gain_db_{-12.0f};
    std::atomic<std::uint32_t> target_frames_{3};

    // callback -> stats
    std::atomic<bool> cb_jb_playing_{false};
    std::atomic<std::uint32_t> cb_held_{0};
    std::atomic<std::uint32_t> cb_max_held_{0};
    std::atomic<std::uint32_t> cb_target_{0};
    std::atomic<std::uint64_t> cb_accepted_{0}, cb_late_{0}, cb_dups_{0}, cb_too_early_{0}, cb_played_{0}, cb_lost_{0},
        cb_underruns_{0}, cb_rebuffers_{0}, cb_drift_{0}, cb_resets_{0};
    std::atomic<std::uint64_t> cb_concealed_{0};
    std::atomic<std::uint64_t> cb_decode_errors_{0};
    std::atomic<std::uint64_t> cb_callbacks_{0};
    std::atomic<std::uint64_t> cb_wrong_rate_{0};
    std::atomic<std::uint64_t> cb_frames_out_{0};
    std::atomic<std::int64_t> cb_max_render_ns_{0};
    std::atomic<std::int64_t> cb_last_render_ns_{0};
    std::atomic<std::uint32_t> cb_frame_samples_{0};
    std::atomic<float> cb_peak_{0.0f};
};

}  // namespace rr::media
