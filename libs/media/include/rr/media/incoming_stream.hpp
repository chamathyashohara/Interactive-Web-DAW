#pragma once

// One incoming live stream (Stage 8, ADR-018): validated AUDIO datagrams -> arrival statistics ->
// bounded SPSC packet queue (64) -> jitter buffer -> Opus decode or PLC -> gain -> ADDED to the
// output by the playback callback. Used by LiveEndpoint (media thread) and the audio engine
// (playback callback). It owns no socket and no thread. Nothing here touches a recording:
// concealment only ever affects what is heard.
//
// "Hear the remote" off (receive mute) drains the queue and plays nothing; the stream keeps
// being received and counted, so the sender and the network stay observable.

#include <atomic>
#include <cstdint>
#include <mutex>

#include "rr/audio/live_tap.hpp"
#include "rr/audio/spsc_ring.hpp"
#include "rr/media/arrival_stats.hpp"
#include "rr/media/jitter_buffer.hpp"
#include "rr/media/live_settings.hpp"
#include "rr/media/media_packet.hpp"
#include "rr/media/net_impairment.hpp"
#include "rr/media/opus_codec.hpp"

namespace rr::media {

struct IncomingConfig {
    std::uint16_t stream_id = kStreamProducerMic;
    LivePlayoutSettings playout;
    ImpairmentSettings test_receive_impairment;  // TEST ONLY: drops applied on arrival
};

struct IncomingStats {
    std::uint16_t stream_id = 0;
    // media thread
    ArrivalSnapshot arrival;
    std::uint64_t queue_full_drops = 0;   // playback not consuming (no output device, or stalled)
    std::uint64_t end_of_stream = 0;
    std::uint64_t bad_frames = 0;         // Opus packet with a disallowed frame length (counted as bad_payload too)
    std::uint64_t test_dropped = 0;
    double last_packet_age_ms = -1.0;     // -1 = nothing received yet
    bool remote_muted = false;            // latest AUDIO packet carried the muted flag
    bool remote_streaming = false;        // packets within the last second and no END_OF_STREAM since
    // playback callback
    bool output_enabled = false;
    bool jb_playing = false;
    std::uint32_t jb_held = 0;
    std::uint32_t jb_max_held = 0;
    std::uint32_t jb_target = 0;
    JitterStats jb;
    std::uint64_t concealed = 0;
    std::uint64_t decode_errors = 0;
    std::uint64_t render_callbacks = 0;
    std::uint64_t wrong_rate_callbacks = 0;
    std::uint64_t frames_output = 0;
    std::int64_t max_render_ns = 0;
    double last_render_age_ms = -1.0;     // -1 = never rendered (no output device attached)
    std::uint32_t last_frame_samples = 0;
    float gain_db = 0.0f;
    float output_peak_dbfs = -200.0f;     // peak of this stream's contribution over the last second; -200 = silent
};

class IncomingStream final : public audio::PlaybackContributor {
public:
    IncomingStream() = default;
    IncomingStream(const IncomingStream&) = delete;
    IncomingStream& operator=(const IncomingStream&) = delete;

    // Only while not attached to an engine (no render_add can run).
    bool create(const IncomingConfig& config, std::string& error);

    // ---- media thread (after parse_packet() == Ok and the stream id was checked) ----
    // Returns false if the Opus payload is not one allowed frame (caller counts bad_payload).
    bool on_audio(const MediaHeader& h, const std::uint8_t* payload, std::int64_t now);
    void on_end_of_stream();
    ReceiverReport make_report(bool closing, std::uint32_t invalid_packets) const;

    // ---- control thread ----
    void set_output_enabled(bool on) noexcept { output_enabled_.store(on); }
    bool output_enabled() const noexcept { return output_enabled_.load(); }
    void set_gain_db(float db) noexcept;
    void set_target_frames(std::uint32_t frames) noexcept { target_frames_.store(frames); }
    IncomingStats stats() const;

    // ---- playback callback (real-time) ----
    void render_add(float* out, std::uint32_t frames, std::uint32_t channels, std::uint32_t sample_rate) noexcept override;

private:
    bool next_frame() noexcept;

    IncomingConfig cfg_;
    audio::SpscRing<JbPacket> queue_{64};

    // media-thread state (published under mutex_)
    mutable std::mutex mutex_;
    ArrivalStats arrival_;
    std::uint64_t queue_full_drops_ = 0;
    std::uint64_t eos_ = 0;
    std::uint64_t bad_frames_ = 0;
    std::uint64_t test_dropped_ = 0;
    std::int64_t last_packet_ns_ = 0;
    std::int64_t last_eos_ns_ = 0;
    bool remote_muted_ = false;
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
        cb_underruns_{0}, cb_rebuffers_{0}, cb_drift_{0}, cb_resets_{0}, cb_catchup_{0}, cb_resyncs_{0};
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
