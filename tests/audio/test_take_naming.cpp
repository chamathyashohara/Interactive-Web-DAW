#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <set>

#include "rr/audio/take_metadata.hpp"
#include "rr/audio/take_naming.hpp"
#include "test_support.hpp"

using namespace rr::audio;
using rr::Role;

TEST_CASE("session IDs are 8 lower-case hex digits and vary", "[audio][naming]") {
    std::set<std::string> ids;
    for (int i = 0; i < 50; ++i) {
        const std::string id = make_session_id();
        CHECK(is_valid_session_id(id));
        ids.insert(id);
    }
    CHECK(ids.size() > 45);
    CHECK_FALSE(is_valid_session_id("ABCDEF01"));
    CHECK_FALSE(is_valid_session_id("00000000"));
    CHECK_FALSE(is_valid_session_id("abc"));
}

TEST_CASE("folder and take names follow the documented pattern", "[audio][naming]") {
    CHECK(session_folder_name(1791676800123, "ab12cd34") == "20261011-000000_ab12cd34");
    CHECK(take_stem(7, Role::Performer, "ab12cd34") == "take07_performer_ab12cd34");
    CHECK(take_stem(123, Role::Producer, "ab12cd34") == "take123_producer_ab12cd34");
}

TEST_CASE("next free take number skips every existing file of that take", "[audio][naming]") {
    const auto dir = rr::test::fresh_temp_dir("naming");
    CHECK(next_free_take_number(dir, Role::Producer, "ab12cd34") == 1);
    { std::ofstream(dir / "take01_producer_ab12cd34.wav") << "x"; }
    { std::ofstream(dir / "take02_producer_ab12cd34.wav.partial") << "x"; }
    { std::ofstream(dir / "take03_producer_ab12cd34.json") << "x"; }
    { std::ofstream(dir / "take04_performer_ab12cd34.wav") << "x"; }  // other role: not a clash
    CHECK(next_free_take_number(dir, Role::Producer, "ab12cd34") == 4);
    CHECK(next_free_take_number(dir, Role::Performer, "ab12cd34") == 1);
    CHECK(next_free_take_number(dir / "missing", Role::Producer, "ab12cd34") == 1);
}

TEST_CASE("take metadata JSON contains the documented fields", "[audio][metadata]") {
    TakeMetadata m;
    m.take_number = 2;
    m.role = Role::Performer;
    m.session_id = "ab12cd34";
    m.status = rr::TakeStatus::IncompleteDevice;
    m.finalised = true;
    m.stop_reason = "device_lost";
    m.error = "input device stopped \"unplugged\"";
    m.frames = 96000;
    m.sample_rate = 48000;
    m.channels = 2;
    m.wav_format_tag = 3;
    m.capture.source_kind = "device";
    m.capture.conversion_notes = {"no sample-format conversion"};
    m.has_gaps = true;
    m.gaps.push_back(TakeGap{480, 960});
    const std::string json = to_json(m);
    CHECK(json.find("\"schema\": \"rr.take.v1\"") != std::string::npos);
    CHECK(json.find("\"status\": \"incomplete_device\"") != std::string::npos);
    CHECK(json.find("\"finalised\": true") != std::string::npos);
    CHECK(json.find("\"duration_s\": 2.000000") != std::string::npos);
    CHECK(json.find("\\\"unplugged\\\"") != std::string::npos);
    CHECK(json.find("{\"file_frame\": 480, \"frames\": 960, \"filled_with\": \"silence\"}") != std::string::npos);
    CHECK(json.find("\"conversion_notes\": [\"no sample-format conversion\"]") != std::string::npos);
}
