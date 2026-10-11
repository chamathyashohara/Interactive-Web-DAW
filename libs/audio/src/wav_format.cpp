#include "rr/audio/wav_format.hpp"

namespace rr::audio {

const std::array<std::uint8_t, 16> kSubtypeIeeeFloatGuid = {
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
};

namespace {

void put_u16(std::vector<std::uint8_t>& out, std::uint16_t v) {
    out.push_back(static_cast<std::uint8_t>(v & 0xFF));
    out.push_back(static_cast<std::uint8_t>(v >> 8));
}

void put_u32(std::vector<std::uint8_t>& out, std::uint32_t v) {
    for (int i = 0; i < 4; ++i) {
        out.push_back(static_cast<std::uint8_t>((v >> (8 * i)) & 0xFF));
    }
}

void put_tag(std::vector<std::uint8_t>& out, const char (&tag)[5]) {
    out.insert(out.end(), tag, tag + 4);
}

std::uint32_t fmt_chunk_size(const WavFormat& f) noexcept {
    return f.format_tag() == kWaveFormatIeeeFloat ? 18u : 40u;
}

}  // namespace

WavHeaderLayout wav_header_layout(const WavFormat& format) noexcept {
    WavHeaderLayout layout;
    const std::uint32_t fmt = fmt_chunk_size(format);
    // RIFF(12) + "fmt "(8 + fmt) + "fact"(8 + 4) + "data"(8)
    layout.fact_frames_offset = 12 + 8 + fmt + 8;
    layout.data_size_offset = layout.fact_frames_offset + 4 + 4;
    layout.header_bytes = layout.data_size_offset + 4;
    return layout;
}

std::uint64_t max_wav_frames(const WavFormat& format) noexcept {
    const WavHeaderLayout layout = wav_header_layout(format);
    // RIFF size = file size - 8 must fit in 32 bits.
    const std::uint64_t max_data = 0xFFFFFFFFull - (layout.header_bytes - 8);
    return max_data / format.block_align();
}

std::vector<std::uint8_t> build_wav_header(const WavFormat& f, std::uint64_t frames) {
    const WavHeaderLayout layout = wav_header_layout(f);
    const std::uint64_t data_bytes64 = frames * f.block_align();
    const auto data_bytes = static_cast<std::uint32_t>(data_bytes64 > 0xFFFFFFFFull ? 0xFFFFFFFFull : data_bytes64);
    const auto riff_size = static_cast<std::uint32_t>(
        (static_cast<std::uint64_t>(layout.header_bytes) - 8 + data_bytes) > 0xFFFFFFFFull
            ? 0xFFFFFFFFull
            : static_cast<std::uint64_t>(layout.header_bytes) - 8 + data_bytes);

    std::vector<std::uint8_t> h;
    h.reserve(layout.header_bytes);
    put_tag(h, "RIFF");
    put_u32(h, riff_size);
    put_tag(h, "WAVE");

    put_tag(h, "fmt ");
    put_u32(h, fmt_chunk_size(f));
    put_u16(h, f.format_tag());
    put_u16(h, static_cast<std::uint16_t>(f.channels));
    put_u32(h, f.sample_rate);
    put_u32(h, f.byte_rate());
    put_u16(h, static_cast<std::uint16_t>(f.block_align()));
    put_u16(h, 32);  // bits per sample
    if (f.format_tag() == kWaveFormatIeeeFloat) {
        put_u16(h, 0);  // cbSize
    } else {
        put_u16(h, 22);  // cbSize
        put_u16(h, 32);  // valid bits per sample
        put_u32(h, 0);   // channel mask: not specified
        h.insert(h.end(), kSubtypeIeeeFloatGuid.begin(), kSubtypeIeeeFloatGuid.end());
    }

    put_tag(h, "fact");
    put_u32(h, 4);
    put_u32(h, static_cast<std::uint32_t>(frames > 0xFFFFFFFFull ? 0xFFFFFFFFull : frames));

    put_tag(h, "data");
    put_u32(h, data_bytes);
    return h;
}

}  // namespace rr::audio
