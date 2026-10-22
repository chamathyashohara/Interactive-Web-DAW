#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <set>

#include "rr/audio/TakeMetadata.h"
#include "rr/audio/TakeNaming.h"
#include "TestSupport.h"

TEST_CASE("session IDs are 8 lower-case hex digits and vary", "[audio][naming]")
{
    std::set<std::string> ids;
    for (int i = 0; i < 50; ++i)
    {
        const std::string id = makeSessionId();
        CHECK(isValidSessionId(id));
        ids.insert(id);
    }
    CHECK(ids.size() > 45);
    CHECK_FALSE(isValidSessionId("ABCDEF01"));
    CHECK_FALSE(isValidSessionId("00000000"));
    CHECK_FALSE(isValidSessionId("abc"));
}

TEST_CASE("folder and take names follow the documented pattern", "[audio][naming]")
{
    CHECK(sessionFolderName(1791676800123, "ab12cd34") == "20261011-000000_ab12cd34");
    CHECK(takeStem(7, Role::Performer, "ab12cd34") == "take07_performer_ab12cd34");
    CHECK(takeStem(123, Role::Producer, "ab12cd34") == "take123_producer_ab12cd34");
}

TEST_CASE("next free take number skips every existing file of that take", "[audio][naming]")
{
    const auto dir = freshTempDir("naming");
    CHECK(nextFreeTakeNumber(dir, Role::Producer, "ab12cd34") == 1);
    { std::ofstream(dir / "take01_producer_ab12cd34.wav") << "x"; }
    { std::ofstream(dir / "take02_producer_ab12cd34.wav.partial") << "x"; }
    { std::ofstream(dir / "take03_producer_ab12cd34.json") << "x"; }
    { std::ofstream(dir / "take04_performer_ab12cd34.wav") << "x"; }  // other role: not a clash
    CHECK(nextFreeTakeNumber(dir, Role::Producer, "ab12cd34") == 4);
    CHECK(nextFreeTakeNumber(dir, Role::Performer, "ab12cd34") == 1);
    CHECK(nextFreeTakeNumber(dir / "missing", Role::Producer, "ab12cd34") == 1);
}

TEST_CASE("take metadata JSON contains the documented fields", "[audio][metadata]")
{
    TakeMetadata m;
    m.takeNumber = 2;
    m.role = Role::Performer;
    m.sessionId = "ab12cd34";
    m.status = TakeStatus::IncompleteDevice;
    m.finalised = true;
    m.stopReason = "device_lost";
    m.error = "input device stopped \"unplugged\"";
    m.frames = 96000;
    m.sampleRate = 48000;
    m.channels = 2;
    m.wavFormatTag = 3;
    m.capture.sourceKind = "device";
    m.capture.conversionNotes = {"no sample-format conversion"};
    m.hasGaps = true;
    m.gaps.push_back(TakeGap{480, 960});
    const std::string json = toJson(m);
    CHECK(json.find("\"schema\": \"rr.take.v1\"") != std::string::npos);
    CHECK(json.find("\"status\": \"incomplete_device\"") != std::string::npos);
    CHECK(json.find("\"finalised\": true") != std::string::npos);
    CHECK(json.find("\"duration_s\": 2.000000") != std::string::npos);
    CHECK(json.find("\\\"unplugged\\\"") != std::string::npos);
    CHECK(json.find("{\"file_frame\": 480, \"frames\": 960, \"filled_with\": \"silence\"}") != std::string::npos);
    CHECK(json.find("\"conversion_notes\": [\"no sample-format conversion\"]") != std::string::npos);
}
