#pragma once

// Thin RAII wrappers around libopus 1.6.1 (ADR-006, ADR-017). opus.h is included only in
// opus_codec.cpp. Mono, 48 kHz.
//
// Real-time note: libopus keeps all codec state in the object allocated at create() and uses
// stack scratch (C99 VLAs or alloca, per its CMake defaults) inside encode/decode calls, never
// the heap. So decode()/conceal() may run on the playback callback after create() (ADR-011).

#include <cstddef>
#include <cstdint>
#include <string>

#include "rr/media/live_settings.hpp"

struct OpusEncoder;
struct OpusDecoder;

namespace rr::media {

std::string opus_version();  // e.g. "libopus 1.6.1"

class OpusLiveEncoder {
public:
    OpusLiveEncoder() = default;
    ~OpusLiveEncoder();
    OpusLiveEncoder(const OpusLiveEncoder&) = delete;
    OpusLiveEncoder& operator=(const OpusLiveEncoder&) = delete;

    bool create(const LiveCodecSettings& settings, std::string& error);
    // Encodes exactly settings.frame_samples mono samples. Returns the packet size (> 0) or a
    // negative libopus error code.
    int encode(const float* pcm, std::uint8_t* out, std::size_t out_capacity) noexcept;
    void reset() noexcept;  // OPUS_RESET_STATE: a new stream
    bool valid() const noexcept { return enc_ != nullptr; }

    // Read back from libopus after create() and logged (not assumed): codec delay in samples.
    int lookahead_samples() const noexcept { return lookahead_; }
    int actual_bitrate() const noexcept { return bitrate_; }
    int actual_complexity() const noexcept { return complexity_; }
    const LiveCodecSettings& settings() const noexcept { return settings_; }

private:
    OpusEncoder* enc_ = nullptr;
    LiveCodecSettings settings_;
    int lookahead_ = 0;
    int bitrate_ = 0;
    int complexity_ = 0;
};

class OpusLiveDecoder {
public:
    static constexpr std::uint32_t kMaxFrameSamples = 960;  // 20 ms: the longest frame the live path accepts

    OpusLiveDecoder() = default;
    ~OpusLiveDecoder();
    OpusLiveDecoder(const OpusLiveDecoder&) = delete;
    OpusLiveDecoder& operator=(const OpusLiveDecoder&) = delete;

    bool create(std::string& error);
    // Returns decoded samples (> 0) or a negative libopus error code. Real-time safe.
    int decode(const std::uint8_t* packet, std::size_t size, float* pcm, std::uint32_t capacity) noexcept;
    // Packet-loss concealment for one missing frame of `frame_samples` (a multiple of 2.5 ms, as
    // libopus requires). Produces an estimate for the LIVE monitor only. Real-time safe.
    int conceal(float* pcm, std::uint32_t frame_samples) noexcept;
    void reset() noexcept;
    bool valid() const noexcept { return dec_ != nullptr; }

    // Samples per channel in an Opus packet at 48 kHz, or a negative error code.
    static int packet_samples(const std::uint8_t* packet, std::size_t size) noexcept;

private:
    OpusDecoder* dec_ = nullptr;
};

}  // namespace rr::media
