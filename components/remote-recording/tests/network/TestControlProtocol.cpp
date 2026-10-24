#include <catch2/catch_test_macros.hpp>

#include <vector>

#include "rr/network/ControlProtocol.h"

namespace
{

Frame heartbeat(uint32_t id)
{
    Frame f;
    f.type = MsgType::Heartbeat;
    f.msgId = id;
    f.setI64(Tag::SentNs, 123456789);
    return f;
}

std::vector<uint8_t> rawFrame(uint16_t type, uint32_t lengthField, size_t bodyBytes)
{
    std::vector<uint8_t> out = {static_cast<uint8_t>(lengthField >> 24), static_cast<uint8_t>(lengthField >> 16),
                                     static_cast<uint8_t>(lengthField >> 8), static_cast<uint8_t>(lengthField),
                                     static_cast<uint8_t>(type >> 8), static_cast<uint8_t>(type), 0, 0,
                                     0, 0, 0, 1, 0, 0, 0, 0};
    out.resize(4 + bodyBytes, 0);
    return out;
}

}  // namespace

TEST_CASE("frames round-trip through encode and the stream decoder", "[network][protocol]")
{
    Frame f;
    f.type = MsgType::ScheduleStart;
    f.msgId = 7;
    f.refId = 3;
    f.setI64(Tag::SentNs, -5);
    f.setU32(Tag::TakeId, 42);
    f.setI64(Tag::StartAtNs, 9'000'000'000LL);
    f.setStr(Tag::DisplayName, "Studio A");
    const auto bytes = encode(f);

    FrameDecoder d;
    d.feed(bytes.data(), bytes.size());
    Frame out;
    std::string error;
    REQUIRE(d.next(out, error) == FrameDecoder::Result::Frame);
    CHECK(out.type == MsgType::ScheduleStart);
    CHECK(out.msgId == 7);
    CHECK(out.refId == 3);
    CHECK(out.i64(Tag::SentNs) == -5);
    CHECK(out.u32(Tag::TakeId) == 42u);
    CHECK(out.i64(Tag::StartAtNs) == 9'000'000'000LL);
    CHECK(out.str(Tag::DisplayName) == std::string("Studio A"));
    CHECK(d.next(out, error) == FrameDecoder::Result::NeedMore);
}

TEST_CASE("frames split at every byte boundary still decode", "[network][protocol]")
{
    auto a = encode(heartbeat(1));
    const auto b = encode(heartbeat(2));
    a.insert(a.end(), b.begin(), b.end());
    FrameDecoder d;
    std::vector<uint32_t> ids;
    Frame out;
    std::string error;
    for (const uint8_t byte : a)
    {
        d.feed(&byte, 1);
        while (d.next(out, error) == FrameDecoder::Result::Frame)
        {
            ids.push_back(out.msgId);
        }
    }
    CHECK(ids == std::vector<uint32_t>{1, 2});
}

TEST_CASE("malformed input is rejected and the decoder stays failed", "[network][protocol]")
{
    Frame out;
    std::string error;
    SECTION("length too large")
    {
        FrameDecoder d;
        const auto r = rawFrame(0x0010, kMaxControlFrameBytes + 1, 16);
        d.feed(r.data(), r.size());
        CHECK(d.next(out, error) == FrameDecoder::Result::Error);
        CHECK(error.find("out of range") != std::string::npos);
    }
    SECTION("length too small")
    {
        FrameDecoder d;
        const auto r = rawFrame(0x0010, 4, 16);
        d.feed(r.data(), r.size());
        CHECK(d.next(out, error) == FrameDecoder::Result::Error);
    }
    SECTION("unknown message type")
    {
        FrameDecoder d;
        const auto r = rawFrame(0x7777, 12, 12);
        d.feed(r.data(), r.size());
        CHECK(d.next(out, error) == FrameDecoder::Result::Error);
        CHECK(error.find("unknown message type") != std::string::npos);
    }
    SECTION("required field missing")
    {
        Frame f;
        f.type = MsgType::Arm;  // needs TakeId and MaxTakeSeconds
        f.msgId = 1;
        f.setI64(Tag::SentNs, 1);
        const auto bytes = encode(f);
        FrameDecoder d;
        d.feed(bytes.data(), bytes.size());
        CHECK(d.next(out, error) == FrameDecoder::Result::Error);
        CHECK(error.find("missing field") != std::string::npos);
    }
    SECTION("wrong field width")
    {
        Frame f = heartbeat(1);
        f.fields[static_cast<uint16_t>(Tag::SentNs)] = "abc";
        const auto bytes = encode(f);
        FrameDecoder d;
        d.feed(bytes.data(), bytes.size());
        CHECK(d.next(out, error) == FrameDecoder::Result::Error);
    }
    SECTION("duplicate tag")
    {
        auto bytes = encode(heartbeat(1));
        // append a second SentNs TLV and fix the length
        const uint8_t extra[] = {0, 1, 0, 8, 0, 0, 0, 0, 0, 0, 0, 1};
        bytes.insert(bytes.end(), extra, extra + sizeof extra);
        const auto len = static_cast<uint32_t>(bytes.size() - 4);
        bytes[0] = static_cast<uint8_t>(len >> 24);
        bytes[1] = static_cast<uint8_t>(len >> 16);
        bytes[2] = static_cast<uint8_t>(len >> 8);
        bytes[3] = static_cast<uint8_t>(len);
        FrameDecoder d;
        d.feed(bytes.data(), bytes.size());
        CHECK(d.next(out, error) == FrameDecoder::Result::Error);
        CHECK(error.find("duplicate tag") != std::string::npos);
        // stays failed
        const auto good = encode(heartbeat(2));
        d.feed(good.data(), good.size());
        CHECK(d.next(out, error) == FrameDecoder::Result::Error);
    }
}

TEST_CASE("unknown tags are ignored; strings are capped", "[network][protocol]")
{
    Frame f = heartbeat(1);
    f.fields[999] = "future field";
    f.setStr(Tag::ErrorText, std::string(1000, 'x'));
    const auto bytes = encode(f);
    FrameDecoder d;
    d.feed(bytes.data(), bytes.size());
    Frame out;
    std::string error;
    REQUIRE(d.next(out, error) == FrameDecoder::Result::Frame);
    CHECK(out.str(Tag::ErrorText)->size() == kMaxStringBytes);
}

TEST_CASE("every message type has a name and the required SentNs", "[network][protocol]")
{
    for (int t : {0x0001, 0x0002, 0x0003, 0x0004, 0x000F, 0x0010, 0x0011, 0x0020, 0x0030, 0x0031, 0x0032,
                            0x0033, 0x0034, 0x0035, 0x0040, 0x0041, 0x0042, 0x0043, 0x0050})
                            {
        CHECK(isKnownMsgType(static_cast<uint16_t>(t)));
        const auto req = requiredTags(static_cast<MsgType>(t));
        CHECK(req.front() == Tag::SentNs);
    }
    CHECK_FALSE(isKnownMsgType(0x0099));
}
