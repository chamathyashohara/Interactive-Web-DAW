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

#include "rr/audio/LiveTap.h"
#include "rr/audio/SpscRing.h"
#include "rr/media/ArrivalStats.h"
#include "rr/media/JitterBuffer.h"
#include "rr/media/LiveSettings.h"
#include "rr/media/MediaPacket.h"
#include "rr/media/NetImpairment.h"
#include "rr/media/OpusCodec.h"

struct IncomingConfig
{
    uint16_t streamId = kStreamProducerMic;
    LivePlayoutSettings playout;
    ImpairmentSettings testReceiveImpairment;  // TEST ONLY: drops applied on arrival
};

struct IncomingStats
{
    uint16_t streamId = 0;
    /** media thread */
    ArrivalSnapshot arrival;
    uint64_t queueFullDrops = 0;   // playback not consuming (no output device, or stalled)
    uint64_t endOfStream = 0;
    uint64_t badFrames = 0;         // Opus packet with a disallowed frame length (counted as bad_payload too)
    uint64_t testDropped = 0;
    double lastPacketAgeMs = -1.0;     // -1 = nothing received yet
    bool remoteMuted = false;            // latest AUDIO packet carried the muted flag
    bool remoteStreaming = false;        // packets within the last second and no END_OF_STREAM since
    /** playback callback */
    bool outputEnabled = false;
    bool jbPlaying = false;
    uint32_t jbHeld = 0;
    uint32_t jbMaxHeld = 0;
    uint32_t jbTarget = 0;
    JitterStats jb;
    uint64_t concealed = 0;
    uint64_t decodeErrors = 0;
    uint64_t renderCallbacks = 0;
    uint64_t wrongRateCallbacks = 0;
    uint64_t framesOutput = 0;
    int64_t maxRenderNs = 0;
    double lastRenderAgeMs = -1.0;     // -1 = never rendered (no output device attached)
    uint32_t lastFrameSamples = 0;
    float gainDb = 0.0f;
    float outputPeakDbfs = -200.0f;     // peak of this stream's contribution over the last second; -200 = silent
};

class IncomingStream final : public PlaybackContributor
{
public:
    IncomingStream() = default;
    IncomingStream(const IncomingStream&) = delete;
    IncomingStream& operator=(const IncomingStream&) = delete;

    /** Only while not attached to an engine (no renderAdd can run). */
    bool create(const IncomingConfig& config, std::string& error);

    /**
     * ---- media thread (after parsePacket() == Ok and the stream id was checked) ----
     * Returns false if the Opus payload is not one allowed frame (caller counts bad_payload).
     */
    bool onAudio(const MediaHeader& h, const uint8_t* payload, int64_t now);
    void onEndOfStream();
    ReceiverReport makeReport(bool closing, uint32_t invalidPackets) const;

    /** ---- control thread ---- */
    void setOutputEnabled(bool on) noexcept { outputEnabled.store(on); }
    bool isOutputEnabled() const noexcept { return outputEnabled.load(); }
    void setGainDb(float db) noexcept;
    void setTargetFrames(uint32_t frames) noexcept { targetFrames.store(frames); }
    IncomingStats stats() const;

    /** ---- playback callback (real-time) ---- */
    void renderAdd(float* out, uint32_t frames, uint32_t channels, uint32_t sampleRate) noexcept override;

private:
    bool nextFrame() noexcept;

    IncomingConfig cfg;
    SpscRing<JbPacket> queue{64};

    /** media-thread state (published under mutex) */
    mutable std::mutex mutex;
    ArrivalStats arrival;
    uint64_t queueFullDrops = 0;
    uint64_t eos = 0;
    uint64_t badFrames = 0;
    uint64_t testDropped = 0;
    int64_t lastPacketNs = 0;
    int64_t lastEosNs = 0;
    bool remoteMuted = false;
    Impairment receiveImpairment;
    JbPacket rxPacket;

    /** callback state (touched only inside renderAdd) */
    JitterBuffer jb;
    OpusLiveDecoder decoder;
    float pcm[OpusLiveDecoder::kMaxFrameSamples] = {};
    uint32_t pcmLen = 0;
    uint32_t pcmPos = 0;
    uint32_t frameSamples = 480;
    JbPacket cbPacket;
    bool wasEnabled = false;
    float windowPeak = 0.0f;
    uint64_t windowFrames = 0;

    /** control -> callback */
    std::atomic<bool> outputEnabled{false};
    std::atomic<float> gainLinear{0.25f};
    std::atomic<float> gainDb{-12.0f};
    std::atomic<uint32_t> targetFrames{3};

    /** callback -> stats */
    std::atomic<bool> cbJbPlaying{false};
    std::atomic<uint32_t> cbHeld{0};
    std::atomic<uint32_t> cbMaxHeld{0};
    std::atomic<uint32_t> cbTarget{0};
    std::atomic<uint64_t> cbAccepted{0}, cbLate{0}, cbDups{0}, cbTooEarly{0}, cbPlayed{0}, cbLost{0},
        cbUnderruns{0}, cbRebuffers{0}, cbDrift{0}, cbResets{0}, cbCatchup{0}, cbResyncs{0};
    std::atomic<uint64_t> cbConcealed{0};
    std::atomic<uint64_t> cbDecodeErrors{0};
    std::atomic<uint64_t> cbCallbacks{0};
    std::atomic<uint64_t> cbWrongRate{0};
    std::atomic<uint64_t> cbFramesOut{0};
    std::atomic<int64_t> cbMaxRenderNs{0};
    std::atomic<int64_t> cbLastRenderNs{0};
    std::atomic<uint32_t> cbFrameSamples{0};
    std::atomic<float> cbPeak{0.0f};
};

