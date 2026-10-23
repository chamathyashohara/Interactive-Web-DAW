// libopus 1.6.1 wrappers and the bounded live settings (ADR-006, ADR-017).
// TEST SIGNAL - a synthetic sine, not a microphone.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "rr/media/OpusCodec.h"

namespace
{

constexpr double kPi = 3.14159265358979323846;

std::vector<float> sine(size_t frames, double hz, float amplitude, size_t offset = 0)
{
    std::vector<float> v(frames);
    for (size_t i = 0; i < frames; ++i)
    {
        v[i] = amplitude * static_cast<float>(std::sin(2.0 * kPi * hz * static_cast<double>(offset + i) / 48000.0));
    }
    return v;
}

// Share of the signal's energy at `hz` (Goertzel), 0..1.
double toneShare(const std::vector<float>& x, double hz)
{
    const double w = 2.0 * kPi * hz / 48000.0;
    const double coeff = 2.0 * std::cos(w);
    double s1 = 0.0;
    double s2 = 0.0;
    double energy = 0.0;
    for (const float v : x)
    {
        const double s0 = v + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
        energy += static_cast<double>(v) * v;
    }
    const double power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    return energy > 0.0 ? 2.0 * power / (static_cast<double>(x.size()) * energy) : 0.0;
}

}  // namespace

TEST_CASE("Live settings accept only the documented, bounded values", "[media][opus]")
{
    LiveCodecSettings c;
    CHECK(validate(c).empty());
    for (const uint32_t f : {120u, 240u, 480u, 960u})
    {
        c.frameSamples = f;
        CHECK(validate(c).empty());
    }
    for (const uint32_t f : {0u, 441u, 1920u, 2880u}) {  // 40/60 ms are legal Opus but not allowed live
        c.frameSamples = f;
        CHECK_FALSE(validate(c).empty());
    }
    c = LiveCodecSettings{};
    c.bitrateBps = 8000;
    CHECK_FALSE(validate(c).empty());
    c.bitrateBps = 200000;
    CHECK_FALSE(validate(c).empty());
    c = LiveCodecSettings{};
    c.complexity = 11;
    CHECK_FALSE(validate(c).empty());

    LivePlayoutSettings p;
    CHECK(validate(p).empty());
    p.targetFrames = 0;
    CHECK_FALSE(validate(p).empty());
    p.targetFrames = 17;
    CHECK_FALSE(validate(p).empty());
    p = LivePlayoutSettings{};
    p.gainDb = 6.0f;  // no boost
    CHECK_FALSE(validate(p).empty());
    p.gainDb = -61.0f;
    CHECK_FALSE(validate(p).empty());
}

TEST_CASE("Opus encoder reports its version, delay and settings; packets fit one datagram", "[media][opus]")
{
    CHECK(opus_version().find("libopus 1.6.1") != std::string::npos);
    for (const auto app : {OpusApplication::RestrictedLowDelay, OpusApplication::Audio})
    {
        for (const uint32_t frame : {120u, 240u, 480u, 960u})
        {
            LiveCodecSettings s;
            s.application = app;
            s.frameSamples = frame;
            OpusLiveEncoder enc;
            std::string error;
            REQUIRE(enc.create(s, error));
            CHECK(enc.lookaheadSamples() > 0);
            CHECK(enc.actualBitrate() == 64000);
            CHECK(enc.actualComplexity() == 5);
            const auto pcm = sine(frame, 440.0, 0.25f);
            uint8_t out[1276];
            const int bytes = enc.encode(pcm.data(), out, sizeof out);
            CHECK(bytes > 0);
            CHECK(bytes <= 1276);
            CHECK(OpusLiveDecoder::packetSamples(out, static_cast<size_t>(bytes)) == static_cast<int>(frame));
        }
    }
}

TEST_CASE("Opus round trip keeps a 440 Hz tone; PLC fills a missing frame", "[media][opus]")
{
    LiveCodecSettings s;  // 10 ms, 64 kbit/s, RESTRICTED_LOWDELAY, CBR
    OpusLiveEncoder enc;
    OpusLiveDecoder dec;
    std::string error;
    REQUIRE(enc.create(s, error));
    REQUIRE(dec.create(error));
    std::vector<float> decoded;
    uint8_t packet[1276];
    float pcm[OpusLiveDecoder::kMaxFrameSamples];
    int cbrSize = -1;
    bool constant = true;
    for (int f = 0; f < 50; ++f)
    {
        const auto in = sine(480, 440.0, 0.25f, static_cast<size_t>(f) * 480);
        const int bytes = enc.encode(in.data(), packet, sizeof packet);
        REQUIRE(bytes > 0);
        if (f > 0)
        {
            constant = constant && (cbrSize < 0 || bytes == cbrSize);
            cbrSize = bytes;
        }
        const int n = dec.decode(packet, static_cast<size_t>(bytes), pcm, OpusLiveDecoder::kMaxFrameSamples);
        REQUIRE(n == 480);
        if (f >= 5)
        {
            decoded.insert(decoded.end(), pcm, pcm + n);
        }
    }
    CHECK(constant);           // hard CBR: constant packet size
    CHECK(cbrSize == 80);     // 64000 bit/s * 10 ms / 8
    CHECK(toneShare(decoded, 440.0) > 0.9);

    const int concealed = dec.conceal(pcm, 480);
    CHECK(concealed == 480);
}

TEST_CASE("The decoder rejects garbage without crashing", "[media][opus]")
{
    OpusLiveDecoder dec;
    std::string error;
    REQUIRE(dec.create(error));
    float pcm[OpusLiveDecoder::kMaxFrameSamples];
    uint8_t junk[3] = {0xFF, 0xFF, 0xFF};  // code-3 packet with an impossible frame count
    CHECK(dec.decode(junk, sizeof junk, pcm, OpusLiveDecoder::kMaxFrameSamples) < 0);
    CHECK(OpusLiveDecoder::packetSamples(junk, 0) < 0);
}
