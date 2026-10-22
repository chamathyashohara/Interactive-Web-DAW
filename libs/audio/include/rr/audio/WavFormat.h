#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

/**
 * Master recording format (ADR-007): RIFF/WAVE, 32-bit IEEE float, device-native channel
 * count and sample rate.
 * - 1 or 2 channels: WAVE_FORMAT_IEEE_FLOAT (tag 3), fmt chunk 18 bytes (cbSize = 0).
 * - 3..8 channels:   WAVE_FORMAT_EXTENSIBLE (tag 0xFFFE) with the IEEE_FLOAT sub-format,
 * channel mask 0 ("not specified": microphone-array channels are not
 * loudspeaker positions).
 * Both carry a 'fact' chunk (sample frames), as the RIFF spec requires for non-PCM data.
 */
inline constexpr uint16_t kWaveFormatIeeeFloat = 3;
inline constexpr uint16_t kWaveFormatExtensible = 0xFFFE;
inline constexpr uint32_t kMaxChannels = 8;
inline constexpr uint32_t kBytesPerSample = 4;  // float32

struct WavFormat
{
    uint32_t sampleRate = 48000;
    uint32_t channels = 1;

    uint16_t formatTag() const noexcept
    {
        return channels <= 2 ? kWaveFormatIeeeFloat : kWaveFormatExtensible;
    }
    uint32_t blockAlign() const noexcept { return channels * kBytesPerSample; }
    uint32_t byteRate() const noexcept { return sampleRate * blockAlign(); }
    bool valid() const noexcept
    {
        return channels >= 1 && channels <= kMaxChannels && sampleRate >= 8000 && sampleRate <= 384000;
    }
};

/** Header layout facts for a given format. */
struct WavHeaderLayout
{
    uint32_t headerBytes = 0;        // bytes before the first sample
    uint32_t riffSizeOffset = 4;
    uint32_t factFramesOffset = 0;
    uint32_t dataSizeOffset = 0;
};

WavHeaderLayout wavHeaderLayout(const WavFormat& format) noexcept;

/** Complete header for `frames` sample frames (all size fields filled in). */
std::vector<uint8_t> buildWavHeader(const WavFormat& format, uint64_t frames);

/** Largest frame count whose data still fits the 32-bit RIFF size fields. */
uint64_t maxWavFrames(const WavFormat& format) noexcept;

/** KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {00000003-0000-0010-8000-00AA00389B71}, little-endian bytes. */
extern const std::array<uint8_t, 16> kSubtypeIeeeFloatGuid;

