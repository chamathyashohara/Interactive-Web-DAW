#include "rr/transfer/transfer_protocol.hpp"

#include <cstring>

namespace rr::xfer {
namespace {

class Writer {
public:
    void u8(std::uint8_t v) { b.push_back(v); }
    void u16(std::uint16_t v) {
        b.push_back(static_cast<std::uint8_t>(v >> 8));
        b.push_back(static_cast<std::uint8_t>(v));
    }
    void u32(std::uint32_t v) {
        u16(static_cast<std::uint16_t>(v >> 16));
        u16(static_cast<std::uint16_t>(v));
    }
    void u64(std::uint64_t v) {
        u32(static_cast<std::uint32_t>(v >> 32));
        u32(static_cast<std::uint32_t>(v));
    }
    void bytes(const void* p, std::size_t n) {
        const auto* c = static_cast<const std::uint8_t*>(p);
        b.insert(b.end(), c, c + n);
    }
    void fixed(const std::string& s, std::size_t n) {  // exactly n bytes, zero-padded
        for (std::size_t i = 0; i < n; ++i) {
            b.push_back(i < s.size() ? static_cast<std::uint8_t>(s[i]) : 0);
        }
    }
    void text(const std::string& s, std::size_t limit) {
        const std::size_t n = s.size() < limit ? s.size() : limit;
        u16(static_cast<std::uint16_t>(n));
        bytes(s.data(), n);
    }
    std::vector<std::uint8_t> b;
};

class Reader {
public:
    Reader(const std::uint8_t* p, std::size_t n) : p_(p), n_(n) {}
    bool u8(std::uint8_t& v) {
        if (!need(1)) return false;
        v = p_[i_++];
        return true;
    }
    bool u16(std::uint16_t& v) {
        if (!need(2)) return false;
        v = static_cast<std::uint16_t>((p_[i_] << 8) | p_[i_ + 1]);
        i_ += 2;
        return true;
    }
    bool u32(std::uint32_t& v) {
        std::uint16_t hi = 0, lo = 0;
        if (!u16(hi) || !u16(lo)) return false;
        v = (static_cast<std::uint32_t>(hi) << 16) | lo;
        return true;
    }
    bool u64(std::uint64_t& v) {
        std::uint32_t hi = 0, lo = 0;
        if (!u32(hi) || !u32(lo)) return false;
        v = (static_cast<std::uint64_t>(hi) << 32) | lo;
        return true;
    }
    bool digest(Digest& d) {
        if (!need(d.size())) return false;
        std::memcpy(d.data(), p_ + i_, d.size());
        i_ += d.size();
        return true;
    }
    bool fixed(std::string& s, std::size_t n) {
        if (!need(n)) return false;
        s.assign(reinterpret_cast<const char*>(p_ + i_), n);
        i_ += n;
        return true;
    }
    bool text(std::string& s, std::size_t limit) {
        std::uint16_t n = 0;
        if (!u16(n) || n > limit || !need(n)) return false;
        s.assign(reinterpret_cast<const char*>(p_ + i_), n);
        i_ += n;
        return true;
    }
    bool blob(std::vector<std::uint8_t>& v, std::size_t n) {
        if (!need(n)) return false;
        v.assign(p_ + i_, p_ + i_ + n);
        i_ += n;
        return true;
    }
    bool at_end() const { return i_ == n_; }

private:
    bool need(std::size_t k) const { return n_ - i_ >= k; }
    const std::uint8_t* p_;
    std::size_t n_;
    std::size_t i_ = 0;
};

bool is_hex(const std::string& s) {
    for (const char c : s) {
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
            return false;
        }
    }
    return true;
}

bool decode_payload(XType type, Reader& r, XMsg& m, std::string& error) {
    m.type = type;
    bool ok = true;
    switch (type) {
    case XType::Hello: {
        std::uint32_t magic = 0;
        std::uint16_t version = 0;
        ok = r.u32(magic) && r.u16(version) && r.fixed(m.session_id, 8) && r.fixed(m.token, kTokenChars) && r.u32(m.take_id);
        if (ok && magic != kMagic) {
            error = "not an RRXF stream";
            return false;
        }
        if (ok && version != kVersion) {
            error = "unsupported RRXF version " + std::to_string(version);
            return false;
        }
        if (ok && (!is_hex(m.session_id) || !is_hex(m.token))) {
            error = "malformed HELLO";
            return false;
        }
        break;
    }
    case XType::Offer:
        ok = r.u32(m.take_id) && r.u64(m.file_bytes) && r.u32(m.chunk_bytes) && r.u32(m.chunk_count) &&
             r.digest(m.file_sha) && r.u32(m.sample_rate) && r.u16(m.channels) && r.u16(m.bits) &&
             r.u16(m.format_tag) && r.u64(m.frames) && r.u8(m.take_status) && r.text(m.name, kMaxNameBytes);
        break;
    case XType::Resume:
        ok = r.u32(m.take_id) && r.u32(m.next_chunk) && r.u16(m.code) && r.text(m.text, kMaxTextBytes);
        break;
    case XType::Chunk: {
        std::uint32_t n = 0;
        ok = r.u32(m.index) && r.u32(n) && r.digest(m.chunk_sha);
        if (ok && (n == 0 || n > kMaxChunkBytes)) {
            error = "chunk length out of range";
            return false;
        }
        ok = ok && r.blob(m.data, n);
        break;
    }
    case XType::Ack:
        ok = r.u32(m.next_chunk);
        break;
    case XType::Nack:
        ok = r.u32(m.next_chunk) && r.u16(m.code);
        break;
    case XType::Done:
        ok = r.u32(m.take_id);
        break;
    case XType::Result: {
        std::uint8_t already = 0;
        ok = r.u32(m.take_id) && r.u16(m.code) && r.u8(already) && r.text(m.text, kMaxTextBytes);
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
    if (!ok || !r.at_end()) {
        error = std::string("malformed ") + xtype_name(type);
        return false;
    }
    return true;
}

}  // namespace

const char* xtype_name(XType t) noexcept {
    switch (t) {
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

std::uint32_t chunk_count_for(std::uint64_t file_bytes, std::uint32_t chunk_bytes) noexcept {
    if (chunk_bytes == 0) {
        return 0;
    }
    return static_cast<std::uint32_t>((file_bytes + chunk_bytes - 1) / chunk_bytes);
}

std::vector<std::uint8_t> encode(const XMsg& m) {
    Writer w;
    w.u32(0);  // length, patched below
    w.u16(static_cast<std::uint16_t>(m.type));
    w.u16(0);
    switch (m.type) {
    case XType::Hello:
        w.u32(kMagic);
        w.u16(kVersion);
        w.fixed(m.session_id, 8);
        w.fixed(m.token, kTokenChars);
        w.u32(m.take_id);
        break;
    case XType::Offer:
        w.u32(m.take_id);
        w.u64(m.file_bytes);
        w.u32(m.chunk_bytes);
        w.u32(m.chunk_count);
        w.bytes(m.file_sha.data(), m.file_sha.size());
        w.u32(m.sample_rate);
        w.u16(m.channels);
        w.u16(m.bits);
        w.u16(m.format_tag);
        w.u64(m.frames);
        w.u8(m.take_status);
        w.text(m.name, kMaxNameBytes);
        break;
    case XType::Resume:
        w.u32(m.take_id);
        w.u32(m.next_chunk);
        w.u16(m.code);
        w.text(m.text, kMaxTextBytes);
        break;
    case XType::Chunk: {
        const std::size_t n = m.data.size() < kMaxChunkBytes ? m.data.size() : kMaxChunkBytes;
        w.u32(m.index);
        w.u32(static_cast<std::uint32_t>(n));
        w.bytes(m.chunk_sha.data(), m.chunk_sha.size());
        w.bytes(m.data.data(), n);
        break;
    }
    case XType::Ack:
        w.u32(m.next_chunk);
        break;
    case XType::Nack:
        w.u32(m.next_chunk);
        w.u16(m.code);
        break;
    case XType::Done:
        w.u32(m.take_id);
        break;
    case XType::Result:
        w.u32(m.take_id);
        w.u16(m.code);
        w.u8(m.already ? 1 : 0);
        w.text(m.text, kMaxTextBytes);
        break;
    case XType::Abort:
        w.u16(m.code);
        w.text(m.text, kMaxTextBytes);
        break;
    }
    const std::uint32_t len = static_cast<std::uint32_t>(w.b.size() - 4);
    w.b[0] = static_cast<std::uint8_t>(len >> 24);
    w.b[1] = static_cast<std::uint8_t>(len >> 16);
    w.b[2] = static_cast<std::uint8_t>(len >> 8);
    w.b[3] = static_cast<std::uint8_t>(len);
    return w.b;
}

void XDecoder::feed(const std::uint8_t* data, std::size_t size) {
    if (off_ > 0 && off_ == buf_.size()) {
        buf_.clear();
        off_ = 0;
    } else if (off_ > 65536) {
        buf_.erase(buf_.begin(), buf_.begin() + static_cast<std::ptrdiff_t>(off_));
        off_ = 0;
    }
    buf_.insert(buf_.end(), data, data + size);
}

XDecoder::Result XDecoder::next(XMsg& out, std::string& error) {
    if (failed_) {
        error = "decoder failed earlier";
        return Result::Error;
    }
    const std::size_t avail = buf_.size() - off_;
    if (avail > kBound) {
        failed_ = true;
        error = "too much unread data";
        return Result::Error;
    }
    if (avail < 4) {
        return Result::NeedMore;
    }
    const std::uint8_t* p = buf_.data() + off_;
    const std::uint32_t len = (static_cast<std::uint32_t>(p[0]) << 24) | (static_cast<std::uint32_t>(p[1]) << 16) |
                              (static_cast<std::uint32_t>(p[2]) << 8) | p[3];
    if (len < 4 || len > kMaxFrameBytes) {
        failed_ = true;
        error = "frame length out of range";
        return Result::Error;
    }
    if (avail < 4 + static_cast<std::size_t>(len)) {
        return Result::NeedMore;
    }
    const std::uint16_t type = static_cast<std::uint16_t>((p[4] << 8) | p[5]);
    const std::uint16_t reserved = static_cast<std::uint16_t>((p[6] << 8) | p[7]);
    if (reserved != 0) {
        failed_ = true;
        error = "reserved field not zero";
        return Result::Error;
    }
    Reader r(p + 8, len - 4);
    out = XMsg{};
    if (!decode_payload(static_cast<XType>(type), r, out, error)) {
        failed_ = true;
        return Result::Error;
    }
    off_ += 4 + len;
    return Result::Message;
}

}  // namespace rr::xfer
