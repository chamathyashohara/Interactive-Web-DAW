#include "rr/transfer/TransferProtocol.h"

#include <cstring>

namespace
{

class Writer
{
public:
    void u8(uint8_t v) { b.push_back(v); }
    void u16(uint16_t v)
    {
        b.push_back(static_cast<uint8_t>(v >> 8));
        b.push_back(static_cast<uint8_t>(v));
    }
    void u32(uint32_t v)
    {
        u16(static_cast<uint16_t>(v >> 16));
        u16(static_cast<uint16_t>(v));
    }
    void u64(uint64_t v)
    {
        u32(static_cast<uint32_t>(v >> 32));
        u32(static_cast<uint32_t>(v));
    }
    void bytes(const void* p, size_t n)
    {
        const auto* c = static_cast<const uint8_t*>(p);
        b.insert(b.end(), c, c + n);
    }
    void fixed(const std::string& s, size_t n) {  // exactly n bytes, zero-padded
        for (size_t i = 0; i < n; ++i)
        {
            b.push_back(i < s.size() ? static_cast<uint8_t>(s[i]) : 0);
        }
    }
    void text(const std::string& s, size_t limit)
    {
        const size_t n = s.size() < limit ? s.size() : limit;
        u16(static_cast<uint16_t>(n));
        bytes(s.data(), n);
    }
    std::vector<uint8_t> b;
};

class Reader
{
public:
    Reader(const uint8_t* p, size_t n) : p(p), n(n) {}
    bool u8(uint8_t& v)
    {
        if (!need(1)) return false;
        v = p[i++];
        return true;
    }
    bool u16(uint16_t& v)
    {
        if (!need(2)) return false;
        v = static_cast<uint16_t>((p[i] << 8) | p[i + 1]);
        i += 2;
        return true;
    }
    bool u32(uint32_t& v)
    {
        uint16_t hi = 0, lo = 0;
        if (!u16(hi) || !u16(lo)) return false;
        v = (static_cast<uint32_t>(hi) << 16) | lo;
        return true;
    }
    bool u64(uint64_t& v)
    {
        uint32_t hi = 0, lo = 0;
        if (!u32(hi) || !u32(lo)) return false;
        v = (static_cast<uint64_t>(hi) << 32) | lo;
        return true;
    }
    bool digest(Digest& d)
    {
        if (!need(d.size())) return false;
        std::memcpy(d.data(), p + i, d.size());
        i += d.size();
        return true;
    }
    bool fixed(std::string& s, size_t len)
    {
        if (!need(len)) return false;
        s.assign(reinterpret_cast<const char*>(p + i), len);
        i += len;
        return true;
    }
    bool text(std::string& s, size_t limit)
    {
        uint16_t len = 0;
        if (!u16(len) || len > limit || !need(len)) return false;
        s.assign(reinterpret_cast<const char*>(p + i), len);
        i += len;
        return true;
    }
    bool blob(std::vector<uint8_t>& v, size_t len)
    {
        if (!need(len)) return false;
        v.assign(p + i, p + i + len);
        i += len;
        return true;
    }
    bool atEnd() const { return i == n; }

private:
    bool need(size_t k) const { return n - i >= k; }
    const uint8_t* p;
    size_t n;
    size_t i = 0;
};

bool isHex(const std::string& s)
{
    for (const char c : s)
    {
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
        {
            return false;
        }
    }
    return true;
}

bool decodePayload(XType type, Reader& r, XMsg& m, std::string& error)
{
    m.type = type;
    bool ok = true;
    switch (type)
    {
    case XType::Hello: {
        uint32_t magic = 0;
        uint16_t version = 0;
        ok = r.u32(magic) && r.u16(version) && r.fixed(m.sessionId, 8) && r.fixed(m.token, kTokenChars) && r.u32(m.takeId);
        if (ok && magic != kMagic)
        {
            error = "not an RRXF stream";
            return false;
        }
        if (ok && version != kVersion)
        {
            error = "unsupported RRXF version " + std::to_string(version);
            return false;
        }
        if (ok && (!isHex(m.sessionId) || !isHex(m.token)))
        {
            error = "malformed HELLO";
            return false;
        }
        break;
    }
    case XType::Offer:
        ok = r.u32(m.takeId) && r.u64(m.fileBytes) && r.u32(m.chunkBytes) && r.u32(m.chunkCount) &&
             r.digest(m.fileSha) && r.u32(m.sampleRate) && r.u16(m.channels) && r.u16(m.bits) &&
             r.u16(m.formatTag) && r.u64(m.frames) && r.u8(m.takeStatus) && r.text(m.name, kMaxNameBytes);
        break;
    case XType::Resume:
        ok = r.u32(m.takeId) && r.u32(m.nextChunk) && r.u16(m.code) && r.text(m.text, kMaxTextBytes);
        break;
    case XType::Chunk: {
        uint32_t n = 0;
        ok = r.u32(m.index) && r.u32(n) && r.digest(m.chunkSha);
        if (ok && (n == 0 || n > kMaxChunkBytes))
        {
            error = "chunk length out of range";
            return false;
        }
        ok = ok && r.blob(m.data, n);
        break;
    }
    case XType::Ack:
        ok = r.u32(m.nextChunk);
        break;
    case XType::Nack:
        ok = r.u32(m.nextChunk) && r.u16(m.code);
        break;
    case XType::Done:
        ok = r.u32(m.takeId);
        break;
    case XType::Result: {
        uint8_t already = 0;
        ok = r.u32(m.takeId) && r.u16(m.code) && r.u8(already) && r.text(m.text, kMaxTextBytes);
        m.already = already != 0;
        break;
    }
    case XType::Abort:
        ok = r.u16(m.code) && r.text(m.text, kMaxTextBytes);
        break;
    default:
        error = "unknown RRXF message type";
        return false;
    }
    if (!ok || !r.atEnd())
    {
        error = std::string("malformed ") + xtypeName(type);
        return false;
    }
    return true;
}

}  // namespace

const char* xtypeName(XType t) noexcept
{
    switch (t)
    {
        case XType::Hello: return "HELLO";
        case XType::Offer: return "OFFER";
        case XType::Resume: return "RESUME";
        case XType::Chunk: return "CHUNK";
        case XType::Ack: return "ACK";
        case XType::Nack: return "NACK";
        case XType::Done: return "DONE";
        case XType::Result: return "RESULT";
        case XType::Abort: return "ABORT";
    }
    return "UNKNOWN";
}

uint32_t chunkCountFor(uint64_t fileBytes, uint32_t chunkBytes) noexcept
{
    if (chunkBytes == 0)
    {
        return 0;
    }
    return static_cast<uint32_t>((fileBytes + chunkBytes - 1) / chunkBytes);
}

std::vector<uint8_t> encode(const XMsg& m)
{
    Writer w;
    w.u32(0);  // length, patched below
    w.u16(static_cast<uint16_t>(m.type));
    w.u16(0);
    switch (m.type)
    {
    case XType::Hello:
        w.u32(kMagic);
        w.u16(kVersion);
        w.fixed(m.sessionId, 8);
        w.fixed(m.token, kTokenChars);
        w.u32(m.takeId);
        break;
    case XType::Offer:
        w.u32(m.takeId);
        w.u64(m.fileBytes);
        w.u32(m.chunkBytes);
        w.u32(m.chunkCount);
        w.bytes(m.fileSha.data(), m.fileSha.size());
        w.u32(m.sampleRate);
        w.u16(m.channels);
        w.u16(m.bits);
        w.u16(m.formatTag);
        w.u64(m.frames);
        w.u8(m.takeStatus);
        w.text(m.name, kMaxNameBytes);
        break;
    case XType::Resume:
        w.u32(m.takeId);
        w.u32(m.nextChunk);
        w.u16(m.code);
        w.text(m.text, kMaxTextBytes);
        break;
    case XType::Chunk: {
        const size_t n = m.data.size() < kMaxChunkBytes ? m.data.size() : kMaxChunkBytes;
        w.u32(m.index);
        w.u32(static_cast<uint32_t>(n));
        w.bytes(m.chunkSha.data(), m.chunkSha.size());
        w.bytes(m.data.data(), n);
        break;
    }
    case XType::Ack:
        w.u32(m.nextChunk);
        break;
    case XType::Nack:
        w.u32(m.nextChunk);
        w.u16(m.code);
        break;
    case XType::Done:
        w.u32(m.takeId);
        break;
    case XType::Result:
        w.u32(m.takeId);
        w.u16(m.code);
        w.u8(m.already ? 1 : 0);
        w.text(m.text, kMaxTextBytes);
        break;
    case XType::Abort:
        w.u16(m.code);
        w.text(m.text, kMaxTextBytes);
        break;
    }
    const uint32_t len = static_cast<uint32_t>(w.b.size() - 4);
    w.b[0] = static_cast<uint8_t>(len >> 24);
    w.b[1] = static_cast<uint8_t>(len >> 16);
    w.b[2] = static_cast<uint8_t>(len >> 8);
    w.b[3] = static_cast<uint8_t>(len);
    return w.b;
}

void XDecoder::feed(const uint8_t* data, size_t size)
{
    if (off > 0 && off == buf.size())
    {
        buf.clear();
        off = 0;
    }
    else if (off > 65536)
    {
        buf.erase(buf.begin(), buf.begin() + static_cast<ptrdiff_t>(off));
        off = 0;
    }
    buf.insert(buf.end(), data, data + size);
}

XDecoder::Result XDecoder::next(XMsg& out, std::string& error)
{
    if (failed)
    {
        error = "decoder failed earlier";
        return Result::Error;
    }
    const size_t avail = buf.size() - off;
    if (avail > kBound)
    {
        failed = true;
        error = "too much unread data";
        return Result::Error;
    }
    if (avail < 4)
    {
        return Result::NeedMore;
    }
    const uint8_t* p = buf.data() + off;
    const uint32_t len = (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
                              (static_cast<uint32_t>(p[2]) << 8) | p[3];
    if (len < 4 || len > kMaxTransferFrameBytes)
    {
        failed = true;
        error = "frame length out of range";
        return Result::Error;
    }
    if (avail < 4 + static_cast<size_t>(len))
    {
        return Result::NeedMore;
    }
    const uint16_t type = static_cast<uint16_t>((p[4] << 8) | p[5]);
    const uint16_t reserved = static_cast<uint16_t>((p[6] << 8) | p[7]);
    if (reserved != 0)
    {
        failed = true;
        error = "reserved field not zero";
        return Result::Error;
    }
    Reader r(p + 8, len - 4);
    out = XMsg{};
    if (!decodePayload(static_cast<XType>(type), r, out, error))
    {
        failed = true;
        return Result::Error;
    }
    off += 4 + len;
    return Result::Message;
}

