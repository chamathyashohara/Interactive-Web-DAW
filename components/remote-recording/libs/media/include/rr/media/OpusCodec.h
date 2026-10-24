#pragma once

// Thin RAII wrappers around libopus 1.6.1 (ADR-006, ADR-017). opus.h is included only in
// OpusCodec.cpp. Mono, 48 kHz.
//
// Real-time note: libopus keeps all codec state in the object allocated at create() and uses
// stack scratch (C99 VLAs or alloca, per its CMake defaults) inside encode/decode calls, never
// the heap. So decode()/conceal() may run on the playback callback after create() (ADR-011).

#include <cstddef>
#include <cstdint>
#include <string>

#include "rr/media/LiveSettings.h"

struct OpusEncoder;
struct OpusDecoder;

std::string opus_version();  // e.g. "libopus 1.6.1"

class OpusLiveEncoder
{
public:
    OpusLiveEncoder() = default;
    ~OpusLiveEncoder();
    OpusLiveEncoder(const OpusLiveEncoder&) = delete;
    OpusLiveEncoder& operator=(const OpusLiveEncoder&) = delete;

    bool create(const LiveCodecSettings& settings, std::string& error);
    /**
     * Encodes exactly settings.frame_samples mono samples. Returns the packet size (> 0) or a
     * negative libopus error code.
     */
    int encode(const float* pcm, uint8_t* out, size_t outCapacity) noexcept;
    void reset() noexcept;  // OPUS_RESET_STATE: a new stream
    bool valid() const noexcept { return enc != nullptr; }

    /** Read back from libopus after create() and logged (not assumed): codec delay in samples. */
    int lookaheadSamples() const noexcept { return lookahead; }
    int actualBitrate() const noexcept { return bitrate; }
    int actualComplexity() const noexcept { return complexity; }
    const LiveCodecSettings& getSettings() const noexcept { return settings; }

private:
    OpusEncoder* enc = nullptr;
    LiveCodecSettings settings;
    int lookahead = 0;
    int bitrate = 0;
    int complexity = 0;
};

class OpusLiveDecoder
{
public:
    static constexpr uint32_t kMaxFrameSamples = 960;  // 20 ms: the longest frame the live path accepts

    OpusLiveDecoder() = default;
    ~OpusLiveDecoder();
    OpusLiveDecoder(const OpusLiveDecoder&) = delete;
    OpusLiveDecoder& operator=(const OpusLiveDecoder&) = delete;

    bool create(std::string& error);
    /** Returns decoded samples (> 0) or a negative libopus error code. Real-time safe. */
    int decode(const uint8_t* packet, size_t size, float* pcm, uint32_t capacity) noexcept;
    /**
     * Packet-loss concealment for one missing frame of `frame_samples` (a multiple of 2.5 ms, as
     * libopus requires). Produces an estimate for the LIVE monitor only. Real-time safe.
     */
    int conceal(float* pcm, uint32_t frameSamples) noexcept;
    void reset() noexcept;
    bool valid() const noexcept { return dec != nullptr; }

    /** Samples per channel in an Opus packet at 48 kHz, or a negative error code. */
    static int packetSamples(const uint8_t* packet, size_t size) noexcept;

private:
    OpusDecoder* dec = nullptr;
};

