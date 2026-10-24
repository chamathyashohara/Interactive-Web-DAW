#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <vector>

#include "rr/audio/WavInspect.h"
#include "rr/audio/WavWriter.h"
#include "TestSupport.h"

namespace
{
WavFormat stereo48k()
{
    WavFormat f;
    f.sampleRate = 48000;
    f.channels = 2;
    return f;
}
std::vector<float> framesOf(size_t frames, float value)
{
    return std::vector<float>(frames * 2, value);
}
}  // namespace

TEST_CASE("open writes .partial, finalise renames to .wav with a correct header", "[audio][wav]")
{
    const auto dir = freshTempDir("writer");
    const auto finalPath = dir / "take01_producer_abcdef01.wav";
    WavWriter w;
    REQUIRE(w.open(finalPath, stereo48k()));
    CHECK(std::filesystem::exists(dir / "take01_producer_abcdef01.wav.partial"));
    CHECK_FALSE(std::filesystem::exists(finalPath));

    const auto a = framesOf(1000, 0.25f);
    REQUIRE(w.writeFrames(a.data(), 1000));
    REQUIRE(w.writeSilence(500));
    CHECK(w.framesWritten() == 1500);

    REQUIRE(w.finalise());
    CHECK(w.isFinalised());
    CHECK(std::filesystem::exists(finalPath));
    CHECK_FALSE(std::filesystem::exists(dir / "take01_producer_abcdef01.wav.partial"));

    const WavInfo info = inspectWav(finalPath);
    CHECK(info.isCompleteFloatWav());
    CHECK(info.frames == 1500);
    CHECK(info.factFrames == 1500);
    CHECK(info.channels == 2);
    CHECK(info.sampleRate == 48000);
    const auto samples = readWavSamples(finalPath);
    REQUIRE(samples.size() == 3000);
    CHECK(samples[0] == 0.25f);
    CHECK(samples[1999] == 0.25f);
    CHECK(samples[2000] == 0.0f);
}

TEST_CASE("an existing take file is never overwritten", "[audio][wav]")
{
    const auto dir = freshTempDir("nooverwrite");
    const auto finalPath = dir / "take01_producer_abcdef01.wav";
    { std::ofstream(finalPath) << "existing"; }
    WavWriter w;
    CHECK_FALSE(w.open(finalPath, stereo48k()));
    CHECK(w.hasFailed());
    CHECK(w.getError().find("refusing to overwrite") != std::string::npos);

    // A leftover .partial with the same name also blocks creation ("wbx").
    const auto other = dir / "take02_producer_abcdef01.wav";
    { std::ofstream(WavWriter::partialPathFor(other)) << "leftover"; }
    WavWriter w2;
    CHECK_FALSE(w2.open(other, stereo48k()));
    CHECK(w2.getError().find("already exists") != std::string::npos);
}

TEST_CASE("a write failure latches, blocks finalisation and keeps the take incomplete", "[audio][wav]")
{
    const auto dir = freshTempDir("diskfull");
    WavWriter w(failingOpener(58 + 8 * 1000));  // header + 1000 stereo frames
    REQUIRE(w.open(dir / "take01_producer_abcdef01.wav", stereo48k()));
    const auto a = framesOf(800, 0.5f);
    CHECK(w.writeFrames(a.data(), 800));
    CHECK_FALSE(w.writeFrames(a.data(), 800));  // exceeds the simulated disk
    CHECK(w.hasFailed());
    CHECK(w.getError().find("simulated disk full") != std::string::npos);
    CHECK(w.framesWritten() == 800);
    CHECK_FALSE(w.finalise());
    CHECK_FALSE(w.isFinalised());
    CHECK_FALSE(std::filesystem::exists(dir / "take01_producer_abcdef01.wav"));
}

TEST_CASE("refresh_header makes a crashed .partial readable up to the refresh", "[audio][wav]")
{
    const auto dir = freshTempDir("refresh");
    const auto finalPath = dir / "take01_performer_abcdef01.wav";
    auto w = std::make_unique<WavWriter>();
    REQUIRE(w->open(finalPath, stereo48k()));
    const auto a = framesOf(2000, 0.1f);
    REQUIRE(w->writeFrames(a.data(), 2000));
    REQUIRE(w->refreshHeader());
    REQUIRE(w->writeFrames(a.data(), 1000));
    // Simulated crash: the object is destroyed without finalise(). abandon() in the destructor
    // closes the file under its .partial name.
    w.reset();
    const auto partial = WavWriter::partialPathFor(finalPath);
    REQUIRE(std::filesystem::exists(partial));
    CHECK_FALSE(std::filesystem::exists(finalPath));
    const WavInfo info = inspectWav(partial);
    CHECK(info.hasData);
    CHECK(info.frames == 3000);  // every whole frame present in the file
}
