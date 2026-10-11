#include <catch2/catch_test_macros.hpp>

#include <vector>

#include "rr/network/control_protocol.hpp"

using namespace rr::net;

namespace {

Frame heartbeat(std::uint32_t id) {
    Frame f;
    f.type = MsgType::Heartbeat;
    f.msg_id = id;
    f.set_i64(Tag::SentNs, 123456789);
    return f;
}

std::vector<std::uint8_t> raw_frame(std::uint16_t type, std::uint32_t length_field, std::size_t body_bytes) {
    std::vector<std::uint8_t> out = {static_cast<std::uint8_t>(length_field >> 24), static_cast<std::uint8_t>(length_field >> 16),
                                     static_cast<std::uint8_t>(length_field >> 8), static_cast<std::uint8_t>(length_field),
                                     static_cast<std::uint8_t>(type >> 8), static_cast<std::uint8_t>(type), 0, 0,
                                     0, 0, 0, 1, 0, 0, 0, 0};
    out.resize(4 + body_bytes, 0);
    return out;
}

}  // namespace

TEST_CASE("frames round-trip through encode and the stream decoder", "[network][protocol]") {
    Frame f;
    f.type = MsgType::ScheduleStart;
    f.msg_id = 7;
    f.ref_id = 3;
    f.set_i64(Tag::SentNs, -5);
    f.set_u32(Tag::TakeId, 42);
    f.set_i64(Tag::StartAtNs, 9'000'000'000LL);
    f.set_str(Tag::DisplayName, "Studio A");
    const auto bytes = encode(f);

    FrameDecoder d;
    d.feed(bytes.data(), bytes.size());
    Frame out;
    std::string error;
    REQUIRE(d.next(out, error) == FrameDecoder::Result::Frame);
    CHECK(out.type == MsgType::ScheduleStart);
    CHECK(out.msg_id == 7);
    CHECK(out.ref_id == 3);
    CHECK(out.i64(Tag::SentNs) == -5);
    CHECK(out.u32(Tag::TakeId) == 42u);
    CHECK(out.i64(Tag::StartAtNs) == 9'000'000'000LL);
    CHECK(out.str(Tag::DisplayName) == std::string("Studio A"));
    CHECK(d.next(out, error) == FrameDecoder::Result::NeedMore);
}

TEST_CASE("frames split at every byte boundary still decode", "[network][protocol]") {
    auto a = encode(heartbeat(1));
    const auto b = encode(heartbeat(2));
    a.insert(a.end(), b.begin(), b.end());
    FrameDecoder d;
    std::vector<std::uint32_t> ids;
    Frame out;
    std::string error;
    for (const std::uint8_t byte : a) {
        d.feed(&byte, 1);
        while (d.next(out, error) == FrameDecoder::Result::Frame) {
            ids.push_back(out.msg_id);
        }
    }
    CHECK(ids == std::vector<std::uint32_t>{1, 2});
}

TEST_CASE("malformed input is rejected and the decoder stays failed", "[network][protocol]") {
    Frame out;
    std::string error;
    SECTION("length too large") {
        FrameDecoder d;
        const auto r = raw_frame(0x0010, kMaxFrameBytes + 1, 16);
        d.feed(r.data(), r.size());
        CHECK(d.next(out, error) == FrameDecoder::Result::Error);
        CHECK(error.find("out of range") != std::string::npos);
    }
    SECTION("length too small") {
        FrameDecoder d;
        const auto r = raw_frame(0x0010, 4, 16);
        d.feed(r.data(), r.size());
        CHECK(d.next(out, error) == FrameDecoder::Result::Error);
    }
    SECTION("unknown message type") {
        FrameDecoder d;
        const auto r = raw_frame(0x7777, 12, 12);
        d.feed(r.data(), r.size());
        CHECK(d.next(out, error) == FrameDecoder::Result::Error);
        CHECK(error.find("unknown message type") != std::string::npos);
    }
    SECTION("required field missing") {
        Frame f;
        f.type = MsgType::Arm;  // needs TakeId and MaxTakeSeconds
        f.msg_id = 1;
        f.set_i64(Tag::SentNs, 1);
        const auto bytes = encode(f);
        FrameDecoder d;
        d.feed(bytes.data(), bytes.size());
        CHECK(d.next(out, error) == FrameDecoder::Result::Error);
        CHECK(error.find("missing field") != std::string::npos);
    }
    SECTION("wrong field width") {
        Frame f = heartbeat(1);
        f.fields[static_cast<std::uint16_t>(Tag::SentNs)] = "abc";
        const auto bytes = encode(f);
        FrameDecoder d;
        d.feed(bytes.data(), bytes.size());
        CHECK(d.next(out, error) == FrameDecoder::Result::Error);
    }
    SECTION("duplicate tag") {
        auto bytes = encode(heartbeat(1));
        // append a second SentNs TLV and fix the length
        const std::uint8_t extra[] = {0, 1, 0, 8, 0, 0, 0, 0, 0, 0, 0, 1};
        bytes.insert(bytes.end(), extra, extra + sizeof extra);
        const auto len = static_cast<std::uint32_t>(bytes.size() - 4);
        bytes[0] = static_cast<std::uint8_t>(len >> 24);
        bytes[1] = static_cast<std::uint8_t>(len >> 16);
        bytes[2] = static_cast<std::uint8_t>(len >> 8);
        bytes[3] = static_cast<std::uint8_t>(len);
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

TEST_CASE("unknown tags are ignored; strings are capped", "[network][protocol]") {
    Frame f = heartbeat(1);
    f.fields[999] = "future field";
    f.set_str(Tag::ErrorText, std::string(1000, 'x'));
    const auto bytes = encode(f);
    FrameDecoder d;
    d.feed(bytes.data(), bytes.size());
    Frame out;
    std::string error;
    REQUIRE(d.next(out, error) == FrameDecoder::Result::Frame);
    CHECK(out.str(Tag::ErrorText)->size() == kMaxStringBytes);
}

TEST_CASE("every message type has a name and the required SentNs", "[network][protocol]") {
    for (int t : {0x0001, 0x0002, 0x0003, 0x0004, 0x000F, 0x0010, 0x0011, 0x0020, 0x0030, 0x0031, 0x0032,
                            0x0033, 0x0034, 0x0035, 0x0040, 0x0041, 0x0042, 0x0043, 0x0050}) {
        CHECK(is_known_msg_type(static_cast<std::uint16_t>(t)));
        const auto req = required_tags(static_cast<MsgType>(t));
        CHECK(req.front() == Tag::SentNs);
    }
    CHECK_FALSE(is_known_msg_type(0x0099));
}
