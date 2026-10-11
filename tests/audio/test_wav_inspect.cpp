#include <catch2/catch_test_macros.hpp>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <vector>

#include "rr/audio/wav_format.hpp"
#include "rr/audio/wav_inspect.hpp"
#include "rr/audio/wav_writer.hpp"
#include "test_support.hpp"

using namespace rr::audio;

namespace {
// Writes a .partial the way a crash would leave it: header claims 0 frames, data follows.
std::filesystem::path make_crashed_partial(const std::filesystem::path& dir, std::size_t frames, std::size_t extra_bytes) {
    WavFormat f;
    f.sample_rate = 48000;
    f.channels = 1;
    const auto path = dir / "take03_producer_abcdef01.wav.partial";
    std::ofstream out(path, std::ios::binary);
    const auto header = build_wav_header(f, 0);
    out.write(reinterpret_cast<const char*>(header.data()), static_cast<std::streamsize>(header.size()));
    std::vector<float> samples(frames);
    for (std::size_t i = 0; i < frames; ++i) {
        samples[i] = static_cast<float>(i) / static_cast<float>(frames);
    }
    out.write(reinterpret_cast<const char*>(samples.data()), static_cast<std::streamsize>(frames * sizeof(float)));
    for (std::size_t i = 0; i < extra_bytes; ++i) {
        out.put('\x7f');  // a frame cut off mid-write
    }
    return path;
}
}  // namespace

TEST_CASE("a crashed .partial is detected as not finalised", "[audio][inspect]") {
    const auto dir = rr::test::fresh_temp_dir("inspect");
    const auto partial = make_crashed_partial(dir, 4800, 2);
    const WavInfo info = inspect_wav(partial);
    CHECK(info.riff_wave);
    CHECK(info.is_float32);
    CHECK(info.frames == 4800);
    CHECK_FALSE(info.header_consistent);
    CHECK_FALSE(info.is_complete_float_wav());
    CHECK_FALSE(info.problems.empty());
}

TEST_CASE("recovery copies all whole frames and never touches the .partial", "[audio][inspect]") {
    const auto dir = rr::test::fresh_temp_dir("recover");
    const auto partial = make_crashed_partial(dir, 4800, 3);
    const auto size_before = std::filesystem::file_size(partial);

    const RecoveryResult r = recover_partial(partial);
    REQUIRE(r.ok);
    CHECK(r.frames == 4800);
    CHECK(r.trailing_bytes_dropped == 3);
    CHECK(r.recovered_path.filename().string() == "take03_producer_abcdef01.recovered.wav");
    CHECK(std::filesystem::file_size(partial) == size_before);  // original untouched

    const WavInfo info = inspect_wav(r.recovered_path);
    CHECK(info.is_complete_float_wav());
    CHECK(info.frames == 4800);
    const auto samples = rr::test::read_wav_samples(r.recovered_path);
    CHECK(samples[4799] == 4799.0f / 4800.0f);

    // Running recovery again refuses to overwrite the recovered file.
    CHECK_FALSE(recover_partial(partial).ok);
}

TEST_CASE("garbage and missing files are reported, not accepted", "[audio][inspect]") {
    const auto dir = rr::test::fresh_temp_dir("garbage");
    { std::ofstream(dir / "x.wav") << "this is not audio"; }
    CHECK_FALSE(inspect_wav(dir / "x.wav").riff_wave);
    CHECK_FALSE(inspect_wav(dir / "missing.wav").readable);
    CHECK_FALSE(recover_partial(dir / "x.wav").ok);
}

TEST_CASE("leftover .partial files are found recursively", "[audio][inspect]") {
    const auto dir = rr::test::fresh_temp_dir("scan");
    std::filesystem::create_directories(dir / "s1");
    make_crashed_partial(dir / "s1", 10, 0);
    { std::ofstream(dir / "s1" / "take01_producer_abcdef01.wav") << "x"; }
    const auto found = find_partial_files(dir);
    REQUIRE(found.size() == 1);
    CHECK(found[0].filename().string() == "take03_producer_abcdef01.wav.partial");
    CHECK(find_partial_files(dir / "does_not_exist").empty());
}
