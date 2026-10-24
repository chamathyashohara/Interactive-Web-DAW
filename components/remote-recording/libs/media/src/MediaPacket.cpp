#include "rr/media/MediaPacket.h"

#include <array>
#include <cstring>

namespace
{

std::array<uint32_t, 256> makeCrcTable()
{
    std::array<uint32_t, 256> table{};
    for (uint32_t i = 0; i < 256; ++i)
    {
        uint32_t c = i;
        for (int k = 0; k < 8; ++k)
        {
            c = (c & 1u) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
        table[i] = c;
    }
    return table;
}

const std::array<uint32_t, 256>& crcTable()
{
    static const std::array<uint32_t, 256> table = makeCrcTable();
    return table;
}

void put16(uint8_t* p, uint16_t v)
{
    p[0] = static_cast<uint8_t>(v >> 8);
    p[1] = static_cast<uint8_t>(v);
}
void put32(uint8_t* p, uint32_t v)
{
    for (int i = 0; i < 4; ++i)
    {
        p[i] = static_cast<uint8_t>(v >> (24 - 8 * i));
    }
}
void put64(uint8_t* p, uint64_t v)
{
    for (int i = 0; i < 8; ++i)
    {
        p[i] = static_cast<uint8_t>(v >> (56 - 8 * i));
    }
}
uint16_t get16(const uint8_t* p)
{
    return static_cast<uint16_t>((p[0] << 8) | p[1]);
}
uint32_t get32(const uint8_t* p)
{
    uint32_t v = 0;
    for (int i = 0; i < 4; ++i)
    {
        v = (v << 8) | p[i];
    }
    return v;
}
uint64_t get64(const uint8_t* p)
{
    uint64_t v = 0;
    for (int i = 0; i < 8; ++i)
    {
        v = (v << 8) | p[i];
    }
    return v;
}

}  // namespace

const char* packetCheckName(PacketCheck c) noexcept
{
    switch (c)
    {
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

void InvalidCounts::count(PacketCheck c) noexcept
{
    switch (c)
    {
        case PacketCheck::Ok: break;
        case PacketCheck::BadLength: ++badLength; break;
        case PacketCheck::BadVersion: ++badVersion; break;
        case PacketCheck::BadType: ++badType; break;
        case PacketCheck::BadCrc: ++badCrc; break;
        case PacketCheck::BadSession: ++badSession; break;
        case PacketCheck::BadPayload: ++badPayload; break;
    }
}

uint32_t crc32Ieee(const uint8_t* data, size_t size, uint32_t crc) noexcept
{
    const auto& table = crcTable();
    crc = ~crc;
    for (size_t i = 0; i < size; ++i)
    {
        crc = table[(crc ^ data[i]) & 0xFFu] ^ (crc >> 8);
    }
    return ~crc;
}

size_t writePacket(const MediaHeader& h, const uint8_t* payload, size_t payloadSize,
                         uint8_t* out, size_t outSize) noexcept
                         {
    if (payloadSize > kMaxPayloadBytes || outSize < kMediaHeaderBytes + payloadSize)
    {
        return 0;
    }
    put32(out + 0, h.seq);
    put64(out + 4, h.mediaIndex);
    put32(out + 12, h.sessionId);
    put16(out + 16, h.streamId);
    put16(out + 18, static_cast<uint16_t>(payloadSize));
    out[20] = static_cast<uint8_t>((kHeaderVersion << 4) | (static_cast<uint8_t>(h.type) & 0x0Fu));
    out[21] = h.flags;
    if (payloadSize > 0)
    {
        std::memcpy(out + kMediaHeaderBytes, payload, payloadSize);
    }
    uint32_t crc = crc32Ieee(out, 22);
    crc = crc32Ieee(out + kMediaHeaderBytes, payloadSize, crc);
    put32(out + 22, crc);
    return kMediaHeaderBytes + payloadSize;
}

PacketCheck parsePacket(const uint8_t* data, size_t size, uint32_t expectedSession,
                         MediaHeader& h, const uint8_t*& payload) noexcept
                         {
    if (data == nullptr || size < kMediaHeaderBytes || size > kMaxDatagramBytes)
    {
        return PacketCheck::BadLength;
    }
    if ((data[20] >> 4) != kHeaderVersion)
    {
        return PacketCheck::BadVersion;
    }
    const uint8_t type = data[20] & 0x0Fu;
    if (type != static_cast<uint8_t>(PacketType::Audio) && type != static_cast<uint8_t>(PacketType::EndOfStream) &&
        type != static_cast<uint8_t>(PacketType::ReceiverReport))
        {
        return PacketCheck::BadType;
    }
    const uint16_t payloadLen = get16(data + 18);
    if (payloadLen != size - kMediaHeaderBytes)
    {
        return PacketCheck::BadLength;
    }
    uint32_t crc = crc32Ieee(data, 22);
    crc = crc32Ieee(data + kMediaHeaderBytes, payloadLen, crc);
    if (crc != get32(data + 22))
    {
        return PacketCheck::BadCrc;
    }
    if (get32(data + 12) != expectedSession)
    {
        return PacketCheck::BadSession;
    }
    h.seq = get32(data + 0);
    h.mediaIndex = get64(data + 4);
    h.sessionId = get32(data + 12);
    h.streamId = get16(data + 16);
    h.payloadLen = payloadLen;
    h.type = static_cast<PacketType>(type);
    h.flags = data[21];
    payload = data + kMediaHeaderBytes;

    if (h.streamId != kStreamProducerMic && h.streamId != kStreamPerformerMic)
    {
        return PacketCheck::BadPayload;
    }
    switch (h.type)
    {
        case PacketType::Audio:
            // One Opus packet: TOC byte + at most 1275 bytes per frame (RFC 6716 §3.2.1);
            // the frame length itself is checked with libopus by the receiver.
            if ((h.flags & 0x03u) != kCodecOpus || (h.flags & 0xF8u) != 0 || payloadLen == 0 || payloadLen > 1276)
            {
                return PacketCheck::BadPayload;
            }
            break;
        case PacketType::EndOfStream:
            if (h.flags != 0 || payloadLen != 0)
            {
                return PacketCheck::BadPayload;
            }
            break;
        case PacketType::ReceiverReport:
            if (h.flags != 0 || payloadLen != ReceiverReport::kBytes)
            {
                return PacketCheck::BadPayload;
            }
            break;
    }
    return PacketCheck::Ok;
}

void writeReport(const ReceiverReport& r, uint8_t* out) noexcept
{
    put64(out + 0, r.received);
    put64(out + 8, r.lostEstimate);
    put32(out + 16, r.late);
    put32(out + 20, r.duplicates);
    put32(out + 24, r.reordered);
    put32(out + 28, r.jitterUs);
    put32(out + 32, r.jbFill);
    put32(out + 36, r.jbTarget);
    put32(out + 40, r.underruns);
    put32(out + 44, r.concealed);
    put32(out + 48, r.decodeErrors);
    put32(out + 52, r.invalidPackets);
    put32(out + 56, r.flags);
    put32(out + 60, 0);
}

ReceiverReport readReport(const uint8_t* in) noexcept
{
    ReceiverReport r;
    r.received = get64(in + 0);
    r.lostEstimate = get64(in + 8);
    r.late = get32(in + 16);
    r.duplicates = get32(in + 20);
    r.reordered = get32(in + 24);
    r.jitterUs = get32(in + 28);
    r.jbFill = get32(in + 32);
    r.jbTarget = get32(in + 36);
    r.underruns = get32(in + 40);
    r.concealed = get32(in + 44);
    r.decodeErrors = get32(in + 48);
    r.invalidPackets = get32(in + 52);
    r.flags = get32(in + 56);
    return r;
}

bool sessionIdToU32(const std::string& text, uint32_t& out) noexcept
{
    if (text.size() != 8)
    {
        return false;
    }
    uint32_t v = 0;
    for (const char c : text)
    {
        uint32_t d = 0;
        if (c >= '0' && c <= '9')
        {
            d = static_cast<uint32_t>(c - '0');
        }
        else if (c >= 'a' && c <= 'f')
        {
            d = static_cast<uint32_t>(c - 'a' + 10);
        }
        else
        {
            return false;
        }
        v = (v << 4) | d;
    }
    if (v == 0)
    {
        return false;
    }
    out = v;
    return true;
}

