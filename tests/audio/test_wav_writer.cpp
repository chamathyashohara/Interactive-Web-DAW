#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <vector>

#include "rr/audio/wav_inspect.hpp"
#include "rr/audio/wav_writer.hpp"
#include "test_support.hpp"

using namespace rr::audio;

namespace {
WavFormat stereo48k() {
    WavFormat f;
    f.sample_rate = 48000;
    f.channels = 2;
    return f;
}
std::vector<float> frames_of(std::size_t frames, float value) {
    return std::vector<float>(frames * 2, value);
}
}  // namespace

TEST_CASE("open writes .partial, finalise renames to .wav with a correct header", "[audio][wav]") {
    const auto dir = rr::test::fresh_temp_dir("writer");
    const auto final_path = dir / "take01_producer_abcdef01.wav";
    WavWriter w;
    REQUIRE(w.open(final_path, stereo48k()));
    CHECK(std::filesystem::exists(dir / "take01_producer_abcdef01.wav.partial"));
    CHECK_FALSE(std::filesystem::exists(final_path));

    const auto a = frames_of(1000, 0.25f);
    REQUIRE(w.write_frames(a.data(), 1000));
    REQUIRE(w.write_silence(500));
    CHECK(w.frames_written() == 1500);

    REQUIRE(w.finalise());
    CHECK(w.finalised());
    CHECK(std::filesystem::exists(final_path));
    CHECK_FALSE(std::filesystem::exists(dir / "take01_producer_abcdef01.wav.partial"));

    const WavInfo info = inspect_wav(final_path);
    CHECK(info.is_complete_float_wav());
    CHECK(info.frames == 1500);
    CHECK(info.fact_frames == 1500);
    CHECK(info.channels == 2);
    CHECK(info.sample_rate == 48000);
    const auto samples = rr::test::read_wav_samples(final_path);
    REQUIRE(samples.size() == 3000);
    CHECK(samples[0] == 0.25f);
    CHECK(samples[1999] == 0.25f);
    CHECK(samples[2000] == 0.0f);
}

TEST_CASE("an existing take file is never overwritten", "[audio][wav]") {
    const auto dir = rr::test::fresh_temp_dir("nooverwrite");
    const auto final_path = dir / "take01_producer_abcdef01.wav";
    { std::ofstream(final_path) << "existing"; }
    WavWriter w;
    CHECK_FALSE(w.open(final_path, stereo48k()));
    CHECK(w.failed());
    CHECK(w.error().find("refusing to overwrite") != std::string::npos);

    // A leftover .partial with the same name also blocks creation ("wbx").
    const auto other = dir / "take02_producer_abcdef01.wav";
    { std::ofstream(WavWriter::partial_path_for(other)) << "leftover"; }
    WavWriter w2;
    CHECK_FALSE(w2.open(other, stereo48k()));
    CHECK(w2.error().find("already exists") != std::string::npos);
}

TEST_CASE("a write failure latches, blocks finalisation and keeps the take incomplete", "[audio][wav]") {
    const auto dir = rr::test::fresh_temp_dir("diskfull");
    WavWriter w(rr::test::failing_opener(58 + 8 * 1000));  // header + 1000 stereo frames
    REQUIRE(w.open(dir / "take01_producer_abcdef01.wav", stereo48k()));
    const auto a = frames_of(800, 0.5f);
    CHECK(w.write_frames(a.data(), 800));
    CHECK_FALSE(w.write_frames(a.data(), 800));  // exceeds the simulated disk
    CHECK(w.failed());
    CHECK(w.error().find("simulated disk full") != std::string::npos);
    CHECK(w.frames_written() == 800);
    CHECK_FALSE(w.finalise());
    CHECK_FALSE(w.finalised());
    CHECK_FALSE(std::filesystem::exists(dir / "take01_producer_abcdef01.wav"));
}

TEST_CASE("refresh_header makes a crashed .partial readable up to the refresh", "[audio][wav]") {
    const auto dir = rr::test::fresh_temp_dir("refresh");
    const auto final_path = dir / "take01_performer_abcdef01.wav";
    auto w = std::make_unique<WavWriter>();
    REQUIRE(w->open(final_path, stereo48k()));
    const auto a = frames_of(2000, 0.1f);
    REQUIRE(w->write_frames(a.data(), 2000));
    REQUIRE(w->refresh_header());
    REQUIRE(w->write_frames(a.data(), 1000));
    // Simulated crash: the object is destroyed without finalise(). abandon() in the destructor
    // closes the file under its .partial name.
    w.reset();
    const auto partial = WavWriter::partial_path_for(final_path);
    REQUIRE(std::filesystem::exists(partial));
    CHECK_FALSE(std::filesystem::exists(final_path));
    const WavInfo info = inspect_wav(partial);
    CHECK(info.has_data);
    CHECK(info.frames == 3000);  // every whole frame present in the file
}
