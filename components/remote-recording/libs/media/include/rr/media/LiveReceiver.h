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
//   playback callback:    renderAdd(): queue -> jitter buffer -> Opus decode or PLC -> gain
//                         -> added to the output. Preallocated state only; no locks, no I/O.

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "rr/audio/LiveTap.h"
#include "rr/audio/SpscRing.h"
#include "rr/media/ArrivalStats.h"
#include "rr/media/JitterBuffer.h"
#include "rr/media/LiveEndpoint.h"
#include "rr/media/LiveSettings.h"
#include "rr/media/MediaPacket.h"
#include "rr/media/NetImpairment.h"
#include "rr/media/OpusCodec.h"
#include "rr/network/Socket.h"
#include "rr/shared/Log.h"

struct LiveReceiverConfig
{
    std::string producerHost;        // the producer's address (the control connection's host)
    uint16_t mediaPort = 0;     // the producer's media port (control port + 1 by default)
    uint32_t sessionId = 0;
    LivePlayoutSettings playout;
    uint32_t reportIntervalMs = 500;
    ImpairmentSettings testReceiveImpairment;  // TEST ONLY: drops/dups applied on arrival
};

struct LiveReceiverStats
{
    bool running = false;
    std::string producerEndpoint;
    std::string localEndpoint;
    /** receive thread */
    ArrivalSnapshot arrival;
    InvalidCounts invalid;
    uint64_t queueFullDrops = 0;   // playback not consuming (no output device, or stalled)
    uint64_t endOfStream = 0;
    uint64_t reportsSent = 0;
    uint64_t reportSendErrors = 0;
    uint64_t testDropped = 0;       // TEST impairment only
    double lastPacketAgeMs = -1.0;     // -1 = nothing received yet
    /** playback callback */
    bool outputEnabled = false;
    bool jbPlaying = false;
    uint32_t jbHeld = 0;
    uint32_t jbMaxHeld = 0;
    uint32_t jbTarget = 0;
    JitterStats jb;
    uint64_t concealed = 0;          // frames produced by Opus PLC (lost + underrun)
    uint64_t decodeErrors = 0;
    uint64_t renderCallbacks = 0;
    uint64_t wrongRateCallbacks = 0;  // output not at 48 kHz: live audio not played
    uint64_t framesOutput = 0;
    int64_t maxRenderNs = 0;
    double lastRenderAgeMs = -1.0;     // -1 = never rendered (no output device attached)
    uint32_t lastFrameSamples = 0;
    float gainDb = 0.0f;
    /** peak of the live contribution over the last second, dBFS; -200 = silent */
    float outputPeakDbfs = -200.0f;
};

class LiveReceiver final : public PlaybackContributor
{
public:
    explicit LiveReceiver(Logger* logger = nullptr);
    ~LiveReceiver() override;
    LiveReceiver(const LiveReceiver&) = delete;
    LiveReceiver& operator=(const LiveReceiver&) = delete;

    /** Opens the UDP socket (connected to the producer's media endpoint) and starts the thread. */
    bool start(const LiveReceiverConfig& config, std::string& error);
    /** Sends a closing report and stops the thread. Detach from the audio engine BEFORE this. */
    void stop();
    bool running() const noexcept { return endpoint.isRunning(); }

    void setOutputEnabled(bool on) noexcept;
    bool outputEnabled() const noexcept;
    void setGainDb(float db) noexcept;
    void setTargetFrames(uint32_t frames) noexcept;

    /** Playback callback (real-time). */
    void renderAdd(float* out, uint32_t frames, uint32_t channels, uint32_t sampleRate) noexcept override;

    LiveReceiverStats stats() const;

private:
    LiveEndpoint endpoint;
};

