#pragma once

// Producer side of the one-way live stream (Stage 7, ADR-017): microphone -> LiveTap (filled by
// the capture callback) -> this media-send thread -> Opus encode -> UDP -> performer.
// Since Stage 8 this is a thin wrapper over LiveEndpoint (one outgoing stream 1, no incoming
// stream); the Stage 7 API and statistics are unchanged, and the Stage 7 tests run against it.
//
// The thread owns the UDP socket, bound to the producer's selected interface and media port.
// It sends audio only to an endpoint it has LEARNED from a valid receiver report whose source
// address is the performer's control-connection address, and stops sending when the performer
// says it is closing or its reports stop for peer_timeout_ms. So the producer never sends to an
// address it was merely told about, and stops on its own when the performer goes away.
//
// The capture callback never waits for this thread: if the thread falls behind, the tap ring
// fills, the callback drops whole blocks (counted), and this thread also trims a backlog
// above 6 frames down to 1 frame (counted) so live latency stays bounded.
// The master recording is unaffected by anything here (separate ring, separate thread).

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rr/audio/live_tap.hpp"
#include "rr/media/jitter_buffer.hpp"
#include "rr/media/live_endpoint.hpp"
#include "rr/media/live_settings.hpp"
#include "rr/media/media_packet.hpp"
#include "rr/media/net_impairment.hpp"
#include "rr/media/opus_codec.hpp"
#include "rr/network/socket.hpp"
#include "rr/shared/log.hpp"

namespace rr::media {

struct LiveSenderConfig {
    std::string bind_address;          // the producer's selected interface (as for control)
    std::uint16_t media_port = 0;      // control port + 1 by default
    std::uint32_t session_id = 0;
    std::string expected_peer_address; // the performer's control-connection address
    LiveCodecSettings codec;
    std::uint32_t peer_timeout_ms = 3000;
    std::uint32_t max_backlog_frames = 6;
    ImpairmentSettings test_impairment;  // TEST ONLY (probe --sim-*): never set by the apps
};

struct LiveSenderStats {
    bool running = false;
    bool sending_enabled = false;      // the producer's "send my microphone live" switch
    bool streaming = false;            // actually encoding and sending now
    std::string local_endpoint;
    bool peer_known = false;
    std::string peer_endpoint;
    std::uint64_t streams_started = 0;
    std::uint64_t frames_encoded = 0;
    std::uint64_t packets_sent = 0;    // AUDIO datagrams (a test duplicate counts twice); not END_OF_STREAM
    std::uint64_t bytes_sent = 0;      // all datagram bytes (header + payload), not counting IP/UDP
    std::uint64_t send_errors = 0;
    std::uint64_t encode_errors = 0;
    std::uint64_t end_of_stream_sent = 0;
    std::uint64_t tap_gap_frames = 0;      // capture blocks dropped by the tap (ring full)
    std::uint64_t backlog_trim_frames = 0; // samples discarded to keep latency bounded
    std::uint64_t test_dropped = 0;        // TEST impairment only
    std::uint64_t test_duplicated = 0;
    std::uint64_t test_reordered = 0;
    std::uint64_t reports_received = 0;
    std::uint64_t peer_timeouts = 0;
    InvalidCounts invalid;
    std::int64_t max_encode_ns = 0;
    double last_report_age_ms = -1.0;  // -1 = no report yet
    bool has_report = false;
    ReceiverReport last_report;        // the performer's receive counters, as reported
    // codec facts read back from libopus
    std::string opus_version;
    std::string application;
    std::uint32_t frame_samples = 0;
    int bitrate_bps = 0;
    int complexity = 0;
    int lookahead_samples = 0;
    audio::LiveTapStats tap;
};

class LiveSender {
public:
    explicit LiveSender(log::Logger* logger = nullptr);
    ~LiveSender();
    LiveSender(const LiveSender&) = delete;
    LiveSender& operator=(const LiveSender&) = delete;

    // `tap` must outlive the sender (the engine's tap, or a test source's).
    bool start(const LiveSenderConfig& config, audio::LiveTap& tap, std::string& error);
    void stop();  // sends END_OF_STREAM if streaming
    bool running() const noexcept { return endpoint_.running(); }

    void set_sending(bool on) noexcept;
    bool sending() const noexcept { return sending_.load(); }

    LiveSenderStats stats() const;

private:
    LiveEndpoint endpoint_;
    std::atomic<bool> sending_{false};
};

}  // namespace rr::media
