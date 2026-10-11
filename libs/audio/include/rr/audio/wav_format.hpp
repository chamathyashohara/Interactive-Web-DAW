#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace rr::audio {

// Master recording format (ADR-007): RIFF/WAVE, 32-bit IEEE float, device-native channel
// count and sample rate.
//  - 1 or 2 channels: WAVE_FORMAT_IEEE_FLOAT (tag 3), fmt chunk 18 bytes (cbSize = 0).
//  - 3..8 channels:   WAVE_FORMAT_EXTENSIBLE (tag 0xFFFE) with the IEEE_FLOAT sub-format,
//                     channel mask 0 ("not specified": microphone-array channels are not
//                     loudspeaker positions).
// Both carry a 'fact' chunk (sample frames), as the RIFF spec requires for non-PCM data.
inline constexpr std::uint16_t kWaveFormatIeeeFloat = 3;
inline constexpr std::uint16_t kWaveFormatExtensible = 0xFFFE;
inline constexpr std::uint32_t kMaxChannels = 8;
inline constexpr std::uint32_t kBytesPerSample = 4;  // float32

struct WavFormat {
    std::uint32_t sample_rate = 48000;
    std::uint32_t channels = 1;

    std::uint16_t format_tag() const noexcept {
        return channels <= 2 ? kWaveFormatIeeeFloat : kWaveFormatExtensible;
    }
    std::uint32_t block_align() const noexcept { return channels * kBytesPerSample; }
    std::uint32_t byte_rate() const noexcept { return sample_rate * block_align(); }
    bool valid() const noexcept {
        return channels >= 1 && channels <= kMaxChannels && sample_rate >= 8000 && sample_rate <= 384000;
    }
};

// Header layout facts for a given format.
struct WavHeaderLayout {
    std::uint32_t header_bytes = 0;        // bytes before the first sample
    std::uint32_t riff_size_offset = 4;
    std::uint32_t fact_frames_offset = 0;
    std::uint32_t data_size_offset = 0;
};

WavHeaderLayout wav_header_layout(const WavFormat& format) noexcept;

// Complete header for `frames` sample frames (all size fields filled in).
std::vector<std::uint8_t> build_wav_header(const WavFormat& format, std::uint64_t frames);

// Largest frame count whose data still fits the 32-bit RIFF size fields.
std::uint64_t max_wav_frames(const WavFormat& format) noexcept;

// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {00000003-0000-0010-8000-00AA00389B71}, little-endian bytes.
extern const std::array<std::uint8_t, 16> kSubtypeIeeeFloatGuid;

}  // namespace rr::audio
