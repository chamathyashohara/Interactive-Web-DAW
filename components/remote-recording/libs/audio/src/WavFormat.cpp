#include "rr/audio/WavFormat.h"

const std::array<uint8_t, 16> kSubtypeIeeeFloatGuid = {
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
};

namespace
{

void putU16(std::vector<uint8_t>& out, uint16_t v)
{
    out.push_back(static_cast<uint8_t>(v & 0xFF));
    out.push_back(static_cast<uint8_t>(v >> 8));
}

void putU32(std::vector<uint8_t>& out, uint32_t v)
{
    for (int i = 0; i < 4; ++i)
    {
        out.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xFF));
    }
}

void putTag(std::vector<uint8_t>& out, const char (&tag)[5])
{
    out.insert(out.end(), tag, tag + 4);
}

uint32_t fmtChunkSize(const WavFormat& f) noexcept
{
    return f.formatTag() == kWaveFormatIeeeFloat ? 18u : 40u;
}

}  // namespace

WavHeaderLayout wavHeaderLayout(const WavFormat& format) noexcept
{
    WavHeaderLayout layout;
    const uint32_t fmt = fmtChunkSize(format);
    // RIFF(12) + "fmt "(8 + fmt) + "fact"(8 + 4) + "data"(8)
    layout.factFramesOffset = 12 + 8 + fmt + 8;
    layout.dataSizeOffset = layout.factFramesOffset + 4 + 4;
    layout.headerBytes = layout.dataSizeOffset + 4;
    return layout;
}

uint64_t maxWavFrames(const WavFormat& format) noexcept
{
    const WavHeaderLayout layout = wavHeaderLayout(format);
    // RIFF size = file size - 8 must fit in 32 bits.
    const uint64_t maxData = 0xFFFFFFFFull - (layout.headerBytes - 8);
    return maxData / format.blockAlign();
}

std::vector<uint8_t> buildWavHeader(const WavFormat& f, uint64_t frames)
{
    const WavHeaderLayout layout = wavHeaderLayout(f);
    const uint64_t dataBytes64 = frames * f.blockAlign();
    const auto dataBytes = static_cast<uint32_t>(dataBytes64 > 0xFFFFFFFFull ? 0xFFFFFFFFull : dataBytes64);
    const auto riffSize = static_cast<uint32_t>(
        (static_cast<uint64_t>(layout.headerBytes) - 8 + dataBytes) > 0xFFFFFFFFull
            ? 0xFFFFFFFFull
            : static_cast<uint64_t>(layout.headerBytes) - 8 + dataBytes);

    std::vector<uint8_t> h;
    h.reserve(layout.headerBytes);
    putTag(h, "RIFF");
    putU32(h, riffSize);
    putTag(h, "WAVE");

    putTag(h, "fmt ");
    putU32(h, fmtChunkSize(f));
    putU16(h, f.formatTag());
    putU16(h, static_cast<uint16_t>(f.channels));
    putU32(h, f.sampleRate);
    putU32(h, f.byteRate());
    putU16(h, static_cast<uint16_t>(f.blockAlign()));
    putU16(h, 32);  // bits per sample
    if (f.formatTag() == kWaveFormatIeeeFloat)
    {
        putU16(h, 0);  // cbSize
    }
    else
    {
        putU16(h, 22);  // cbSize
        putU16(h, 32);  // valid bits per sample
        putU32(h, 0);   // channel mask: not specified
        h.insert(h.end(), kSubtypeIeeeFloatGuid.begin(), kSubtypeIeeeFloatGuid.end());
    }

    putTag(h, "fact");
    putU32(h, 4);
    putU32(h, static_cast<uint32_t>(frames > 0xFFFFFFFFull ? 0xFFFFFFFFull : frames));

    putTag(h, "data");
    putU32(h, dataBytes);
    return h;
}

