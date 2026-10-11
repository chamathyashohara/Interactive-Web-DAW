#pragma once

// One outgoing live stream (Stage 8, ADR-018): LiveTap (filled by the capture callback) -> Opus ->
// AUDIO datagrams. Used by LiveEndpoint on its media thread; it owns no socket and no thread.
//
// Two separate switches, never tied to local recording:
//  - enabled: the stream exists (off = END_OF_STREAM, nothing sent);
//  - muted:   the stream keeps running but carries encoded SILENCE with the "muted" flag, so the
//             other side sees "remote muted" instead of a network failure. The tap is still
//             drained, so timing and counters stay continuous.
// The capture callback never waits for this stream: a full tap drops whole blocks (counted) and
// a backlog above max_backlog_frames is trimmed to one frame (counted), so live delay is bounded.

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

#include "rr/audio/live_tap.hpp"
#include "rr/media/jitter_buffer.hpp"
#include "rr/media/live_settings.hpp"
#include "rr/media/media_packet.hpp"
#include "rr/media/net_impairment.hpp"
#include "rr/media/opus_codec.hpp"

namespace rr::media {

struct OutgoingConfig {
    std::uint16_t stream_id = kStreamProducerMic;
    std::uint32_t session_id = 0;
    LiveCodecSettings codec;
    std::uint32_t max_backlog_frames = 6;
    ImpairmentSettings test_impairment;  // TEST ONLY: applied before sending
};

struct OutgoingStats {
    std::uint16_t stream_id = 0;
    bool enabled = false;
    bool muted = false;
    bool streaming = false;               // encoding and sending now
    std::uint64_t streams_started = 0;
    std::uint64_t frames_encoded = 0;
    std::uint64_t muted_frames = 0;       // frames sent as flagged silence
    std::uint64_t packets_sent = 0;       // AUDIO datagrams (a test duplicate counts twice); not END_OF_STREAM
    std::uint64_t bytes_sent = 0;         // all datagram bytes incl. END_OF_STREAM (header + payload)
    std::uint64_t send_errors = 0;
    std::uint64_t encode_errors = 0;
    std::uint64_t end_of_stream_sent = 0;
    std::uint64_t tap_gap_frames = 0;     // capture blocks dropped by the tap (ring full)
    std::uint64_t backlog_trim_frames = 0;
    std::uint64_t test_dropped = 0;
    std::uint64_t test_duplicated = 0;
    std::uint64_t test_reordered = 0;
    std::int64_t max_encode_ns = 0;
    std::string opus_version;
    std::string application;
    std::uint32_t frame_samples = 0;
    int bitrate_bps = 0;
    int complexity = 0;
    int lookahead_samples = 0;
    audio::LiveTapStats tap;
};

class OutgoingStream {
public:
    // Sends one datagram; returns true if the whole datagram was accepted by the socket.
    using SendFn = std::function<bool(const std::uint8_t*, std::size_t)>;

    OutgoingStream() = default;
    OutgoingStream(const OutgoingStream&) = delete;
    OutgoingStream& operator=(const OutgoingStream&) = delete;

    // `tap` must outlive the stream.
    bool create(const OutgoingConfig& config, audio::LiveTap& tap, std::string& error);

    // ---- media thread ----
    // `allowed`: the peer is reachable (endpoint decides). Encodes and sends what the tap holds.
    void pump(bool allowed, const SendFn& send);
    // Ends the stream (END_OF_STREAM if it was streaming and `can_send`). Disables the tap.
    void finish(bool can_send, const SendFn& send);

    // ---- control thread ----
    void set_enabled(bool on) noexcept { enabled_.store(on); }
    bool enabled() const noexcept { return enabled_.load(); }
    void set_muted(bool on) noexcept { muted_.store(on); }
    bool muted() const noexcept { return muted_.load(); }
    OutgoingStats stats() const;
    const OutgoingConfig& config() const noexcept { return cfg_; }

private:
    void discard_tap(std::size_t samples);
    void send_counted(const SendFn& send, const std::uint8_t* d, std::size_t n, bool audio);
    void send_end_of_stream(const SendFn& send);

    OutgoingConfig cfg_;
    audio::LiveTap* tap_ = nullptr;
    OpusLiveEncoder encoder_;
    Impairment impairment_;
    std::atomic<bool> enabled_{false};
    std::atomic<bool> muted_{false};
    std::atomic<bool> streaming_{false};

    // media-thread state
    std::uint32_t seq_ = 0;
    std::uint64_t media_index_ = 0;
    std::uint64_t tap_drop_base_ = 0;
    std::vector<float> frame_;
    std::vector<float> scratch_;
    std::vector<std::uint8_t> held_back_;

    mutable std::mutex mutex_;
    OutgoingStats counters_;
};

}  // namespace rr::media
