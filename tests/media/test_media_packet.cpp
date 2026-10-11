// Live media packet format (ADR-008 header v1 as built, ADR-017) and its validation order.

#include <catch2/catch_test_macros.hpp>

#include <cstring>
#include <vector>

#include "rr/media/media_packet.hpp"

using namespace rr::media;

namespace {

std::vector<std::uint8_t> audio_packet(std::uint32_t session = 0x1a2b3c4d, std::size_t payload_size = 80) {
    MediaHeader h;
    h.seq = 7;
    h.media_index = 3360;
    h.session_id = session;
    h.type = PacketType::Audio;
    h.flags = kCodecOpus;
    std::vector<std::uint8_t> payload(payload_size);
    for (std::size_t i = 0; i < payload.size(); ++i) {
        payload[i] = static_cast<std::uint8_t>(i * 7 + 1);
    }
    std::vector<std::uint8_t> out(kHeaderBytes + payload_size);
    REQUIRE(write_packet(h, payload.data(), payload.size(), out.data(), out.size()) == out.size());
    return out;
}

PacketCheck check(const std::vector<std::uint8_t>& d, std::uint32_t session = 0x1a2b3c4d) {
    MediaHeader h;
    const std::uint8_t* payload = nullptr;
    return parse_packet(d.data(), d.size(), session, h, payload);
}

void refresh_crc(std::vector<std::uint8_t>& d) {
    std::uint32_t crc = crc32_ieee(d.data(), 22);
    crc = crc32_ieee(d.data() + kHeaderBytes, d.size() - kHeaderBytes, crc);
    d[22] = static_cast<std::uint8_t>(crc >> 24);
    d[23] = static_cast<std::uint8_t>(crc >> 16);
    d[24] = static_cast<std::uint8_t>(crc >> 8);
    d[25] = static_cast<std::uint8_t>(crc);
}

}  // namespace

TEST_CASE("CRC-32/IEEE matches the standard check value", "[media][packet]") {
    const char* text = "123456789";
    CHECK(crc32_ieee(reinterpret_cast<const std::uint8_t*>(text), 9) == 0xCBF43926u);
}

TEST_CASE("An audio packet round-trips with every header field", "[media][packet]") {
    const auto d = audio_packet();
    CHECK(d.size() == kHeaderBytes + 80);
    MediaHeader h;
    const std::uint8_t* payload = nullptr;
    REQUIRE(parse_packet(d.data(), d.size(), 0x1a2b3c4d, h, payload) == PacketCheck::Ok);
    CHECK(h.seq == 7);
    CHECK(h.media_index == 3360);
    CHECK(h.session_id == 0x1a2b3c4d);
    CHECK(h.stream_id == kStreamProducerMic);
    CHECK(h.payload_len == 80);
    CHECK(h.type == PacketType::Audio);
    CHECK(h.flags == kCodecOpus);
    CHECK(payload == d.data() + kHeaderBytes);
    CHECK(payload[1] == 8);
    CHECK(d[20] == 0x10);  // version 1, type 0
}

TEST_CASE("Malformed datagrams are rejected with the right reason, before any field is trusted", "[media][packet]") {
    SECTION("too short / too long / payload length mismatch") {
        auto d = audio_packet();
        d.resize(25);
        CHECK(check(d) == PacketCheck::BadLength);
        CHECK(check(std::vector<std::uint8_t>(kMaxDatagramBytes + 1, 0x10)) == PacketCheck::BadLength);
        auto e = audio_packet();
        e.push_back(0);  // one byte more than payload_len says
        CHECK(check(e) == PacketCheck::BadLength);
        auto f = audio_packet();
        f.pop_back();
        CHECK(check(f) == PacketCheck::BadLength);
    }
    SECTION("header version: prototype packets (version 0) and future versions") {
        auto d = audio_packet();
        d[20] = 0x00;
        CHECK(check(d) == PacketCheck::BadVersion);
        d[20] = 0x20;
        CHECK(check(d) == PacketCheck::BadVersion);
    }
    SECTION("unknown or unimplemented type") {
        auto d = audio_packet();
        d[20] = 0x11;  // PROBE_REQ: designed, not implemented
        CHECK(check(d) == PacketCheck::BadType);
        d[20] = 0x19;
        CHECK(check(d) == PacketCheck::BadType);
    }
    SECTION("corruption in the header or the payload") {
        auto d = audio_packet();
        d[3] ^= 0x01;  // sequence number
        CHECK(check(d) == PacketCheck::BadCrc);
        auto e = audio_packet();
        e[kHeaderBytes + 10] ^= 0x80;
        CHECK(check(e) == PacketCheck::BadCrc);
    }
    SECTION("another session's traffic") {
        CHECK(check(audio_packet(0x11111111)) == PacketCheck::BadSession);
    }
    SECTION("type-specific payload checks") {
        auto d = audio_packet();
        d[21] = 0x00;  // codec PCM16: not negotiated in Stage 7
        refresh_crc(d);
        CHECK(check(d) == PacketCheck::BadPayload);
        d[21] = kCodecOpus | 0x04;  // reserved bit
        refresh_crc(d);
        CHECK(check(d) == PacketCheck::BadPayload);
        d[21] = kCodecOpus;
        d[17] = 2;  // stream 2 (performer mic) does not exist in Stage 7
        refresh_crc(d);
        CHECK(check(d) == PacketCheck::BadPayload);
        CHECK(check(audio_packet(0x1a2b3c4d, 1277)) == PacketCheck::BadPayload);  // > one Opus frame
    }
}

TEST_CASE("End-of-stream and receiver reports have fixed shapes", "[media][packet]") {
    MediaHeader h;
    h.session_id = 42;
    h.type = PacketType::EndOfStream;
    std::uint8_t eos[kHeaderBytes];
    REQUIRE(write_packet(h, nullptr, 0, eos, sizeof eos) == kHeaderBytes);
    MediaHeader out;
    const std::uint8_t* payload = nullptr;
    CHECK(parse_packet(eos, sizeof eos, 42, out, payload) == PacketCheck::Ok);
    CHECK(out.type == PacketType::EndOfStream);

    ReceiverReport r;
    r.received = 123456789012ull;
    r.lost_estimate = 3;
    r.late = 4;
    r.duplicates = 5;
    r.reordered = 6;
    r.jitter_us = 789;
    r.jb_fill = 3;
    r.jb_target = 3;
    r.underruns = 9;
    r.concealed = 12;
    r.decode_errors = 1;
    r.invalid_packets = 2;
    r.flags = ReceiverReport::kFlagPlaying;
    std::uint8_t body[ReceiverReport::kBytes];
    write_report(r, body);
    h.type = PacketType::ReceiverReport;
    std::uint8_t datagram[kHeaderBytes + ReceiverReport::kBytes];
    REQUIRE(write_packet(h, body, sizeof body, datagram, sizeof datagram) == sizeof datagram);
    REQUIRE(parse_packet(datagram, sizeof datagram, 42, out, payload) == PacketCheck::Ok);
    const ReceiverReport back = read_report(payload);
    CHECK(back.received == r.received);
    CHECK(back.lost_estimate == 3);
    CHECK(back.late == 4);
    CHECK(back.duplicates == 5);
    CHECK(back.reordered == 6);
    CHECK(back.jitter_us == 789);
    CHECK(back.underruns == 9);
    CHECK(back.concealed == 12);
    CHECK(back.flags == ReceiverReport::kFlagPlaying);
    // A report of the wrong size is refused.
    REQUIRE(write_packet(h, body, 60, datagram, sizeof datagram) == kHeaderBytes + 60);
    CHECK(parse_packet(datagram, kHeaderBytes + 60, 42, out, payload) == PacketCheck::BadPayload);
}

TEST_CASE("Session id text maps to the header's u32", "[media][packet]") {
    std::uint32_t v = 0;
    CHECK(session_id_to_u32("1a2b3c4d", v));
    CHECK(v == 0x1a2b3c4du);
    CHECK_FALSE(session_id_to_u32("00000000", v));
    CHECK_FALSE(session_id_to_u32("1A2B3C4D", v));
    CHECK_FALSE(session_id_to_u32("1a2b3c4", v));
    CHECK_FALSE(session_id_to_u32("1a2b3c4g", v));
}
