#include "rr/media/media_packet.hpp"

#include <array>
#include <cstring>

namespace rr::media {
namespace {

std::array<std::uint32_t, 256> make_crc_table() {
    std::array<std::uint32_t, 256> table{};
    for (std::uint32_t i = 0; i < 256; ++i) {
        std::uint32_t c = i;
        for (int k = 0; k < 8; ++k) {
            c = (c & 1u) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
        table[i] = c;
    }
    return table;
}

const std::array<std::uint32_t, 256>& crc_table() {
    static const std::array<std::uint32_t, 256> table = make_crc_table();
    return table;
}

void put16(std::uint8_t* p, std::uint16_t v) {
    p[0] = static_cast<std::uint8_t>(v >> 8);
    p[1] = static_cast<std::uint8_t>(v);
}
void put32(std::uint8_t* p, std::uint32_t v) {
    for (int i = 0; i < 4; ++i) {
        p[i] = static_cast<std::uint8_t>(v >> (24 - 8 * i));
    }
}
void put64(std::uint8_t* p, std::uint64_t v) {
    for (int i = 0; i < 8; ++i) {
        p[i] = static_cast<std::uint8_t>(v >> (56 - 8 * i));
    }
}
std::uint16_t get16(const std::uint8_t* p) {
    return static_cast<std::uint16_t>((p[0] << 8) | p[1]);
}
std::uint32_t get32(const std::uint8_t* p) {
    std::uint32_t v = 0;
    for (int i = 0; i < 4; ++i) {
        v = (v << 8) | p[i];
    }
    return v;
}
std::uint64_t get64(const std::uint8_t* p) {
    std::uint64_t v = 0;
    for (int i = 0; i < 8; ++i) {
        v = (v << 8) | p[i];
    }
    return v;
}

}  // namespace

const char* packet_check_name(PacketCheck c) noexcept {
    switch (c) {
        case PacketCheck::Ok: return "ok";
        case PacketCheck::BadLength: return "bad_length";
        case PacketCheck::BadVersion: return "bad_version";
        case PacketCheck::BadType: return "bad_type";
        case PacketCheck::BadCrc: return "bad_crc";
        case PacketCheck::BadSession: return "bad_session";
        case PacketCheck::BadPayload: return "bad_payload";
    }
    return "unknown";
}

void InvalidCounts::count(PacketCheck c) noexcept {
    switch (c) {
        case PacketCheck::Ok: break;
        case PacketCheck::BadLength: ++bad_length; break;
        case PacketCheck::BadVersion: ++bad_version; break;
        case PacketCheck::BadType: ++bad_type; break;
        case PacketCheck::BadCrc: ++bad_crc; break;
        case PacketCheck::BadSession: ++bad_session; break;
        case PacketCheck::BadPayload: ++bad_payload; break;
    }
}

std::uint32_t crc32_ieee(const std::uint8_t* data, std::size_t size, std::uint32_t crc) noexcept {
    const auto& table = crc_table();
    crc = ~crc;
    for (std::size_t i = 0; i < size; ++i) {
        crc = table[(crc ^ data[i]) & 0xFFu] ^ (crc >> 8);
    }
    return ~crc;
}

std::size_t write_packet(const MediaHeader& h, const std::uint8_t* payload, std::size_t payload_size,
                         std::uint8_t* out, std::size_t out_size) noexcept {
    if (payload_size > kMaxPayloadBytes || out_size < kHeaderBytes + payload_size) {
        return 0;
    }
    put32(out + 0, h.seq);
    put64(out + 4, h.media_index);
    put32(out + 12, h.session_id);
    put16(out + 16, h.stream_id);
    put16(out + 18, static_cast<std::uint16_t>(payload_size));
    out[20] = static_cast<std::uint8_t>((kHeaderVersion << 4) | (static_cast<std::uint8_t>(h.type) & 0x0Fu));
    out[21] = h.flags;
    if (payload_size > 0) {
        std::memcpy(out + kHeaderBytes, payload, payload_size);
    }
    std::uint32_t crc = crc32_ieee(out, 22);
    crc = crc32_ieee(out + kHeaderBytes, payload_size, crc);
    put32(out + 22, crc);
    return kHeaderBytes + payload_size;
}

PacketCheck parse_packet(const std::uint8_t* data, std::size_t size, std::uint32_t expected_session,
                         MediaHeader& h, const std::uint8_t*& payload) noexcept {
    if (data == nullptr || size < kHeaderBytes || size > kMaxDatagramBytes) {
        return PacketCheck::BadLength;
    }
    if ((data[20] >> 4) != kHeaderVersion) {
        return PacketCheck::BadVersion;
    }
    const std::uint8_t type = data[20] & 0x0Fu;
    if (type != static_cast<std::uint8_t>(PacketType::Audio) && type != static_cast<std::uint8_t>(PacketType::EndOfStream) &&
        type != static_cast<std::uint8_t>(PacketType::ReceiverReport)) {
        return PacketCheck::BadType;
    }
    const std::uint16_t payload_len = get16(data + 18);
    if (payload_len != size - kHeaderBytes) {
        return PacketCheck::BadLength;
    }
    std::uint32_t crc = crc32_ieee(data, 22);
    crc = crc32_ieee(data + kHeaderBytes, payload_len, crc);
    if (crc != get32(data + 22)) {
        return PacketCheck::BadCrc;
    }
    if (get32(data + 12) != expected_session) {
        return PacketCheck::BadSession;
    }
    h.seq = get32(data + 0);
    h.media_index = get64(data + 4);
    h.session_id = get32(data + 12);
    h.stream_id = get16(data + 16);
    h.payload_len = payload_len;
    h.type = static_cast<PacketType>(type);
    h.flags = data[21];
    payload = data + kHeaderBytes;

    if (h.stream_id != kStreamProducerMic) {
        return PacketCheck::BadPayload;
    }
    switch (h.type) {
        case PacketType::Audio:
            // One Opus packet: TOC byte + at most 1275 bytes per frame (RFC 6716 §3.2.1);
            // the frame length itself is checked with libopus by the receiver.
            if ((h.flags & 0x03u) != kCodecOpus || (h.flags & 0xFCu) != 0 || payload_len == 0 || payload_len > 1276) {
                return PacketCheck::BadPayload;
            }
            break;
        case PacketType::EndOfStream:
            if (h.flags != 0 || payload_len != 0) {
                return PacketCheck::BadPayload;
            }
            break;
        case PacketType::ReceiverReport:
            if (h.flags != 0 || payload_len != ReceiverReport::kBytes) {
                return PacketCheck::BadPayload;
            }
            break;
    }
    return PacketCheck::Ok;
}

void write_report(const ReceiverReport& r, std::uint8_t* out) noexcept {
    put64(out + 0, r.received);
    put64(out + 8, r.lost_estimate);
    put32(out + 16, r.late);
    put32(out + 20, r.duplicates);
    put32(out + 24, r.reordered);
    put32(out + 28, r.jitter_us);
    put32(out + 32, r.jb_fill);
    put32(out + 36, r.jb_target);
    put32(out + 40, r.underruns);
    put32(out + 44, r.concealed);
    put32(out + 48, r.decode_errors);
    put32(out + 52, r.invalid_packets);
    put32(out + 56, r.flags);
    put32(out + 60, 0);
}

ReceiverReport read_report(const std::uint8_t* in) noexcept {
    ReceiverReport r;
    r.received = get64(in + 0);
    r.lost_estimate = get64(in + 8);
    r.late = get32(in + 16);
    r.duplicates = get32(in + 20);
    r.reordered = get32(in + 24);
    r.jitter_us = get32(in + 28);
    r.jb_fill = get32(in + 32);
    r.jb_target = get32(in + 36);
    r.underruns = get32(in + 40);
    r.concealed = get32(in + 44);
    r.decode_errors = get32(in + 48);
    r.invalid_packets = get32(in + 52);
    r.flags = get32(in + 56);
    return r;
}

bool session_id_to_u32(const std::string& text, std::uint32_t& out) noexcept {
    if (text.size() != 8) {
        return false;
    }
    std::uint32_t v = 0;
    for (const char c : text) {
        std::uint32_t d = 0;
        if (c >= '0' && c <= '9') {
            d = static_cast<std::uint32_t>(c - '0');
        } else if (c >= 'a' && c <= 'f') {
            d = static_cast<std::uint32_t>(c - 'a' + 10);
        } else {
            return false;
        }
        v = (v << 4) | d;
    }
    if (v == 0) {
        return false;
    }
    out = v;
    return true;
}

}  // namespace rr::media
