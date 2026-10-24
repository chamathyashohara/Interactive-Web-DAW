#include <catch2/catch_test_macros.hpp>

#include <cstring>

#include "rr/audio/WavFormat.h"

namespace
{
uint32_t u32At(const std::vector<uint8_t>& h, size_t o)
{
    return static_cast<uint32_t>(h[o]) | (static_cast<uint32_t>(h[o + 1]) << 8) |
           (static_cast<uint32_t>(h[o + 2]) << 16) | (static_cast<uint32_t>(h[o + 3]) << 24);
}
uint16_t u16At(const std::vector<uint8_t>& h, size_t o)
{
    return static_cast<uint16_t>(h[o] | (h[o + 1] << 8));
}
}  // namespace

TEST_CASE("mono/stereo float header: tag 3, fmt 18 bytes, fact and data", "[audio][wav]")
{
    WavFormat f;
    f.sampleRate = 48000;
    f.channels = 2;
    const auto h = buildWavHeader(f, 1000);
    const WavHeaderLayout layout = wavHeaderLayout(f);
    REQUIRE(h.size() == 58);
    REQUIRE(layout.headerBytes == 58);
    CHECK(std::memcmp(h.data(), "RIFF", 4) == 0);
    CHECK(std::memcmp(h.data() + 8, "WAVE", 4) == 0);
    CHECK(std::memcmp(h.data() + 12, "fmt ", 4) == 0);
    CHECK(u32At(h, 16) == 18);
    CHECK(u16At(h, 20) == 3);
    CHECK(u16At(h, 22) == 2);
    CHECK(u32At(h, 24) == 48000);
    CHECK(u32At(h, 28) == 48000u * 8u);  // byte rate
    CHECK(u16At(h, 32) == 8);             // block align
    CHECK(u16At(h, 34) == 32);
    CHECK(std::memcmp(h.data() + 38, "fact", 4) == 0);
    CHECK(u32At(h, layout.factFramesOffset) == 1000);
    CHECK(std::memcmp(h.data() + 50, "data", 4) == 0);
    CHECK(u32At(h, layout.dataSizeOffset) == 8000);
    CHECK(u32At(h, 4) == 58 - 8 + 8000);  // RIFF size
}

TEST_CASE("more than two channels use WAVE_FORMAT_EXTENSIBLE with the float GUID", "[audio][wav]")
{
    WavFormat f;
    f.sampleRate = 48000;
    f.channels = 4;
    const auto h = buildWavHeader(f, 10);
    REQUIRE(h.size() == 80);
    CHECK(u32At(h, 16) == 40);
    CHECK(u16At(h, 20) == 0xFFFE);
    CHECK(u16At(h, 36) == 22);  // cbSize
    CHECK(u16At(h, 38) == 32);  // valid bits
    CHECK(u32At(h, 40) == 0);   // channel mask not specified
    CHECK(std::memcmp(h.data() + 44, kSubtypeIeeeFloatGuid.data(), 16) == 0);
}

TEST_CASE("format validity and the 4 GiB limit", "[audio][wav]")
{
    WavFormat f;
    f.channels = 0;
    CHECK_FALSE(f.valid());
    f.channels = 9;
    CHECK_FALSE(f.valid());
    f.channels = 1;
    CHECK(f.valid());
    // Mono float32 at 48 kHz: about 6.2 hours fit in a WAV file.
    const double hours = static_cast<double>(maxWavFrames(f)) / 48000.0 / 3600.0;
    CHECK(hours > 6.2);
    CHECK(hours < 6.3);
}
