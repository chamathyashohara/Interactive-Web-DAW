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
// a backlog above maxBacklogFrames is trimmed to one frame (counted), so live delay is bounded.

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

#include "rr/audio/LiveTap.h"
#include "rr/media/JitterBuffer.h"
#include "rr/media/LiveSettings.h"
#include "rr/media/MediaPacket.h"
#include "rr/media/NetImpairment.h"
#include "rr/media/OpusCodec.h"

struct OutgoingConfig
{
    uint16_t streamId = kStreamProducerMic;
    uint32_t sessionId = 0;
    LiveCodecSettings codec;
    uint32_t maxBacklogFrames = 6;
    ImpairmentSettings testImpairment;  // TEST ONLY: applied before sending
};

struct OutgoingStats
{
    uint16_t streamId = 0;
    bool enabled = false;
    bool muted = false;
    bool streaming = false;               // encoding and sending now
    uint64_t streamsStarted = 0;
    uint64_t framesEncoded = 0;
    uint64_t mutedFrames = 0;       // frames sent as flagged silence
    uint64_t packetsSent = 0;       // AUDIO datagrams (a test duplicate counts twice); not END_OF_STREAM
    uint64_t bytesSent = 0;         // all datagram bytes incl. END_OF_STREAM (header + payload)
    uint64_t sendErrors = 0;
    uint64_t encodeErrors = 0;
    uint64_t endOfStreamSent = 0;
    uint64_t tapGapFrames = 0;     // capture blocks dropped by the tap (ring full)
    uint64_t backlogTrimFrames = 0;
    uint64_t testDropped = 0;
    uint64_t testDuplicated = 0;
    uint64_t testReordered = 0;
    int64_t maxEncodeNs = 0;
    std::string opus_version;
    std::string application;
    uint32_t frameSamples = 0;
    int bitrateBps = 0;
    int complexity = 0;
    int lookaheadSamples = 0;
    LiveTapStats tap;
};

class OutgoingStream
{
public:
    /** Sends one datagram; returns true if the whole datagram was accepted by the socket. */
    using SendFn = std::function<bool(const uint8_t*, size_t)>;

    OutgoingStream() = default;
    OutgoingStream(const OutgoingStream&) = delete;
    OutgoingStream& operator=(const OutgoingStream&) = delete;

    /** `tap` must outlive the stream. */
    bool create(const OutgoingConfig& config, LiveTap& tap, std::string& error);

    /**
     * ---- media thread ----
     * `allowed`: the peer is reachable (endpoint decides). Encodes and sends what the tap holds.
     */
    void pump(bool allowed, const SendFn& send);
    /** Ends the stream (END_OF_STREAM if it was streaming and `canSend`). Disables the tap. */
    void finish(bool canSend, const SendFn& send);

    /** ---- control thread ---- */
    void setEnabled(bool on) noexcept { enabled.store(on); }
    bool isEnabled() const noexcept { return enabled.load(); }
    void setMuted(bool on) noexcept { muted.store(on); }
    bool isMuted() const noexcept { return muted.load(); }
    OutgoingStats stats() const;
    const OutgoingConfig& config() const noexcept { return cfg; }

private:
    void discardTap(size_t samples);
    void sendCounted(const SendFn& send, const uint8_t* d, size_t n, bool audio);
    void sendEndOfStream(const SendFn& send);

    OutgoingConfig cfg;
    LiveTap* tap = nullptr;
    OpusLiveEncoder encoder;
    Impairment impairment;
    std::atomic<bool> enabled{false};
    std::atomic<bool> muted{false};
    std::atomic<bool> streaming{false};

    /** media-thread state */
    uint32_t seq = 0;
    uint64_t mediaIndex = 0;
    uint64_t tapDropBase = 0;
    std::vector<float> frame;
    std::vector<float> scratch;
    std::vector<uint8_t> heldBack;

    mutable std::mutex mutex;
    OutgoingStats counters;
};

