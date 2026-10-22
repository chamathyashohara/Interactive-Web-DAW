#include <catch2/catch_test_macros.hpp>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <vector>

#include "rr/audio/WavFormat.h"
#include "rr/audio/WavInspect.h"
#include "rr/audio/WavWriter.h"
#include "TestSupport.h"

namespace
{
// Writes a .partial the way a crash would leave it: header claims 0 frames, data follows.
std::filesystem::path makeCrashedPartial(const std::filesystem::path& dir, size_t frames, size_t extraBytes)
{
    WavFormat f;
    f.sampleRate = 48000;
    f.channels = 1;
    const auto path = dir / "take03_producer_abcdef01.wav.partial";
    std::ofstream out(path, std::ios::binary);
    const auto header = buildWavHeader(f, 0);
    out.write(reinterpret_cast<const char*>(header.data()), static_cast<std::streamsize>(header.size()));
    std::vector<float> samples(frames);
    for (size_t i = 0; i < frames; ++i)
    {
        samples[i] = static_cast<float>(i) / static_cast<float>(frames);
    }
    out.write(reinterpret_cast<const char*>(samples.data()), static_cast<std::streamsize>(frames * sizeof(float)));
    for (size_t i = 0; i < extraBytes; ++i)
    {
        out.put('\x7f');  // a frame cut off mid-write
    }
    return path;
}
}  // namespace

TEST_CASE("a crashed .partial is detected as not finalised", "[audio][inspect]")
{
    const auto dir = freshTempDir("inspect");
    const auto partial = makeCrashedPartial(dir, 4800, 2);
    const WavInfo info = inspectWav(partial);
    CHECK(info.riffWave);
    CHECK(info.isFloat32);
    CHECK(info.frames == 4800);
    CHECK_FALSE(info.headerConsistent);
    CHECK_FALSE(info.isCompleteFloatWav());
    CHECK_FALSE(info.problems.empty());
}

TEST_CASE("recovery copies all whole frames and never touches the .partial", "[audio][inspect]")
{
    const auto dir = freshTempDir("recover");
    const auto partial = makeCrashedPartial(dir, 4800, 3);
    const auto sizeBefore = std::filesystem::file_size(partial);

    const RecoveryResult r = recoverPartial(partial);
    REQUIRE(r.ok);
    CHECK(r.frames == 4800);
    CHECK(r.trailingBytesDropped == 3);
    CHECK(r.recoveredPath.filename().string() == "take03_producer_abcdef01.recovered.wav");
    CHECK(std::filesystem::file_size(partial) == sizeBefore);  // original untouched

    const WavInfo info = inspectWav(r.recoveredPath);
    CHECK(info.isCompleteFloatWav());
    CHECK(info.frames == 4800);
    const auto samples = readWavSamples(r.recoveredPath);
    CHECK(samples[4799] == 4799.0f / 4800.0f);

    // Running recovery again refuses to overwrite the recovered file.
    CHECK_FALSE(recoverPartial(partial).ok);
}

TEST_CASE("garbage and missing files are reported, not accepted", "[audio][inspect]")
{
    const auto dir = freshTempDir("garbage");
    { std::ofstream(dir / "x.wav") << "this is not audio"; }
    CHECK_FALSE(inspectWav(dir / "x.wav").riffWave);
    CHECK_FALSE(inspectWav(dir / "missing.wav").readable);
    CHECK_FALSE(recoverPartial(dir / "x.wav").ok);
}

TEST_CASE("leftover .partial files are found recursively", "[audio][inspect]")
{
    const auto dir = freshTempDir("scan");
    std::filesystem::create_directories(dir / "s1");
    makeCrashedPartial(dir / "s1", 10, 0);
    { std::ofstream(dir / "s1" / "take01_producer_abcdef01.wav") << "x"; }
    const auto found = findPartialFiles(dir);
    REQUIRE(found.size() == 1);
    CHECK(found[0].filename().string() == "take03_producer_abcdef01.wav.partial");
    CHECK(findPartialFiles(dir / "does_not_exist").empty());
}
