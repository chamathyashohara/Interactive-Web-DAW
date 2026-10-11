#pragma once

// Take-transfer wire format "RRXF" version 1 (Stage 11, ADR-020, PROTOCOL_OVERVIEW §15).
// Its own TCP connection (performer -> producer, control port + 2), never the control channel.
//
//   u32 length    bytes after this field, 4 .. kMaxFrameBytes
//   u16 type      XType
//   u16 reserved  0
//   payload       fixed layout per type (big-endian integers), checked exactly on decode
//
//   HELLO   R->P  magic "RRXF", u16 version, session id (8 ASCII), one-time token (32 hex, never
//                 logged), u32 take
//   OFFER   R->P  u32 take, u64 file bytes, u32 chunk bytes, u32 chunk count, 32-byte SHA-256 of
//                 the whole file, u32 rate, u16 channels, u16 bits, u16 WAV format tag, u64 frames,
//                 u8 take status, u16 n + n bytes name (display only, <= 128)
//   RESUME  P->R  u32 take, u32 next chunk the producer needs, u16 code (0 = go), u16 n + text
//   CHUNK   R->P  u32 index, u32 n, 32-byte SHA-256 of the n bytes, n bytes (n <= kMaxChunkBytes)
//   ACK     P->R  u32 next chunk expected (every chunk up to it is verified and written)
//   NACK    P->R  u32 index to resend from, u16 reason
//   DONE    R->P  u32 take (every chunk sent)
//   RESULT  P->R  u32 take, u16 code (0 = VERIFIED), u8 already-verified flag, u16 n + text
//   ABORT   either  u16 code, u16 n + text; the sender of ABORT closes the connection

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "rr/transfer/sha256.hpp"

namespace rr::xfer {

inline constexpr std::uint32_t kMagic = 0x52525846;  // "RRXF"
inline constexpr std::uint16_t kVersion = 1;
inline constexpr std::uint32_t kDefaultChunkBytes = 32768;
inline constexpr std::uint32_t kMinChunkBytes = 1024;
inline constexpr std::uint32_t kMaxChunkBytes = 65536;
inline constexpr std::size_t kMaxFrameBytes = 4 + 4 + 4 + 32 + kMaxChunkBytes;  // CHUNK is the largest
inline constexpr std::size_t kMaxTextBytes = 256;
inline constexpr std::size_t kMaxNameBytes = 128;
inline constexpr std::size_t kTokenChars = 32;

enum class XType : std::uint16_t {
    Hello = 1,
    Offer = 2,
    Resume = 3,
    Chunk = 4,
    Ack = 5,
    Nack = 6,
    Done = 7,
    Result = 8,
    Abort = 9,
};

const char* xtype_name(XType t) noexcept;

struct XMsg {
    XType type = XType::Abort;
    // HELLO
    std::string session_id;   // 8 hex
    std::string token;        // 32 hex, never logged
    std::uint32_t take_id = 0;  // HELLO, OFFER, RESUME, DONE, RESULT
    // OFFER
    std::uint64_t file_bytes = 0;
    std::uint32_t chunk_bytes = 0;
    std::uint32_t chunk_count = 0;
    Digest file_sha{};
    std::uint32_t sample_rate = 0;
    std::uint16_t channels = 0;
    std::uint16_t bits = 0;
    std::uint16_t format_tag = 0;
    std::uint64_t frames = 0;
    std::uint8_t take_status = 0;
    std::string name;         // untrusted, display only
    // RESUME (next_chunk), ACK (next_chunk), NACK (next_chunk = resend from), CHUNK (index)
    std::uint32_t next_chunk = 0;
    std::uint32_t index = 0;
    Digest chunk_sha{};
    std::vector<std::uint8_t> data;
    // RESUME / RESULT / ABORT / NACK
    std::uint16_t code = 0;    // rr::ErrorCode value; 0 = OK
    bool already = false;      // RESULT: the producer already had an identical verified copy
    std::string text;
};

// Bytes on the wire including the length prefix. Strings longer than their limit are cut.
std::vector<std::uint8_t> encode(const XMsg& m);

// Number of chunks for a file (ceil(bytes / chunk)); 0 for an empty file.
std::uint32_t chunk_count_for(std::uint64_t file_bytes, std::uint32_t chunk_bytes) noexcept;

// Reassembles messages from the TCP stream. Bounded: one frame at most kMaxFrameBytes, at most
// one frame plus 64 KiB buffered. After an error the connection must be closed.
class XDecoder {
public:
    enum class Result { NeedMore, Message, Error };
    void feed(const std::uint8_t* data, std::size_t size);
    Result next(XMsg& out, std::string& error);
    std::size_t buffered() const noexcept { return buf_.size() - off_; }
    // Bytes that may still be fed before the bound is reached.
    std::size_t room() const noexcept { return buffered() < kBound ? kBound - buffered() : 0; }
    bool can_accept_more() const noexcept { return room() > 0; }
    static constexpr std::size_t kBound = 4 + kMaxFrameBytes + 65536;

private:
    std::vector<std::uint8_t> buf_;
    std::size_t off_ = 0;
    bool failed_ = false;
};

}  // namespace rr::xfer
