#pragma once

// Live audio settings (Stage 7, ADR-017). Every value is bounded; the defaults are provisional
// starting points (prov.), not tuned or measured optima.

#include <cstdint>
#include <string>

constexpr uint32_t kLiveSampleRate = 48000;  // Opus input/output rate used on the live path
constexpr uint32_t kLiveChannels = 1;        // mono (multi-channel input is averaged)

enum class OpusApplication : uint8_t
{
    RestrictedLowDelay = 0,  // OPUS_APPLICATION_RESTRICTED_LOWDELAY: CELT only, lowest codec delay
    Audio = 1,               // OPUS_APPLICATION_AUDIO: music/mixed content, may use SILK/hybrid
};
const char* opus_application_name(OpusApplication a) noexcept;

/**
 * Encoder settings. Legal values per the libopus 1.6.1 API documentation (opus.h, opus_defines.h):
 * - frame: exactly one of 2.5/5/10/20/40/60 ms per opus_encode call; this app allows
 * 2.5, 5, 10, 20 ms (120, 240, 480, 960 samples at 48 kHz): longer frames add delay;
 * - bitrate: libopus accepts 500..512000 bit/s; this app allows 16000..128000 for one mono voice/
 * instrument stream;
 * - complexity 0..10.
 */
struct LiveCodecSettings
{
    uint32_t frameSamples = 480;     // 10 ms (prov.: the prototypes' working value)
    uint32_t bitrateBps = 64000;     // (prov.) mono
    OpusApplication application = OpusApplication::RestrictedLowDelay;
    uint32_t complexity = 5;          // (prov.) moderate CPU; 10 = libopus default
    bool constantBitrate = true;          // hard CBR: constant packet size, predictable bandwidth
};

/** Receiver playout settings. */
struct LivePlayoutSettings
{
    uint32_t targetFrames = 3;       // jitter-buffer depth before playing (1..16 frames)
    uint32_t stallLimit = 20;        // consecutive underruns before refilling (5..200)
    float gainDb = -12.0f;                // live output gain (-60..0 dB; no boost)
};

/** Empty string = valid; otherwise a message naming the bad value and the allowed range. */
std::string validate(const LiveCodecSettings& s);
std::string validate(const LivePlayoutSettings& s);

/** Frame duration in ms for display (e.g. 480 -> 10.0). */
double frameMs(uint32_t frameSamples) noexcept;
bool isAllowedFrame(uint32_t frameSamples) noexcept;

constexpr uint32_t kMinTargetFrames = 1;
constexpr uint32_t kMaxTargetFrames = 16;
constexpr float kMinGainDb = -60.0f;
constexpr float kMaxGainDb = 0.0f;
constexpr uint32_t kMinBitrate = 16000;
constexpr uint32_t kMaxBitrate = 128000;

