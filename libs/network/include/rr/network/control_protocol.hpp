#pragma once

// Control protocol 1.0 wire format (PROTOCOL_OVERVIEW.md §4–§5, revised in Stage 6).
//
//   u32 length      bytes after this field, 12 .. kMaxFrameBytes
//   u16 type        MsgType
//   u16 reserved    0
//   u32 msg_id      sender's counter, strictly increasing per connection, starts at 1
//   u32 ref_id      msg_id this frame answers (ACK/NACK/ERROR), else 0
//   TLV...          u16 tag | u16 len | len bytes, big-endian integers, UTF-8 strings
//
// Every frame carries Tag::SentNs (sender's monotonic clock). Unknown tags are ignored;
// unknown types, duplicate tags, missing required tags and oversize frames are errors.

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace rr::net {

inline constexpr std::size_t kHeaderBytes = 12;      // after the length field
inline constexpr std::size_t kMaxFrameBytes = 16384; // after the length field (control messages are small)
inline constexpr std::size_t kMaxStringBytes = 256;

enum class MsgType : std::uint16_t {
    Hello = 0x0001,          // R->S: protocol version offer
    HelloAck = 0x0002,       // S->R: version accepted
    Join = 0x0003,           // R->S: pairing code (first join) or resume token (reconnect)
    JoinAck = 0x0004,        // S->R: session id, resume token, producer name
    Error = 0x000F,          // either: error code (+ ref_id of the offending frame)
    Heartbeat = 0x0010,      // either: liveness + clock-offset sample
    HeartbeatAck = 0x0011,
    ReadyStatus = 0x0020,    // either: readiness, consent, state
    Arm = 0x0030,            // S->R: prepare take N
    ArmAck = 0x0031,         // R->S: (accepted flag + error code when refused)
    ScheduleStart = 0x0032,  // S->R: start take N at producer time T
    StartAck = 0x0033,       // R->S: planned local start (or refusal)
    TakeStarted = 0x0034,    // either: the local recording actually started
    Cancel = 0x0035,         // S->R: abandon take N
    StopSchedule = 0x0040,   // S->R: stop take N at producer time T
    StopAck = 0x0041,        // R->S
    LocalStop = 0x0042,      // R->S: performer stopped on its own (user, fault, limit)
    TakeFinalised = 0x0043,  // either: final status of take N
    SessionClosed = 0x0050,  // either: leaving / ending the session (reason)
    TransferRequest = 0x0060,  // S->R, protocol 1.2: send take N's file on the transfer connection
    TransferAck = 0x0061,      // R->S, protocol 1.2: accepted, or refused with a reason
};

enum class Tag : std::uint16_t {
    SentNs = 1,          // i64 sender monotonic ns (every frame)
    ProtoMajor = 2,      // u16
    ProtoMinor = 3,      // u16
    Role = 4,            // u8 (1 producer, 2 performer)
    AppVersion = 5,      // str
    DisplayName = 6,     // str
    PairingCode = 7,     // str (6 digits) - never logged
    SessionId = 8,       // str (8 hex)
    ClientId = 9,        // str (8 hex, random per performer process)
    ErrorCode = 10,      // u16 rr::ErrorCode
    ErrorText = 11,      // str
    Ready = 12,          // u8 bool
    Reasons = 13,        // str ("; "-separated not-ready reasons)
    State = 14,          // u8 rr::session::SessionState
    TakeId = 15,         // u32
    StartAtNs = 16,      // i64 producer monotonic ns
    StopAtNs = 17,       // i64 producer monotonic ns
    PlannedLocalNs = 18, // i64 receiver monotonic ns
    ThetaNs = 19,        // i64 estimated offset (responder - requester)
    UncertaintyNs = 20,  // i64
    EchoSentNs = 21,     // i64 (heartbeat t1 echoed)
    RecvNs = 22,         // i64 (heartbeat t2)
    FirstFrame = 23,     // u64 capture frame index
    Status = 24,         // u8 rr::TakeStatus
    Frames = 25,         // u64
    StopReason = 26,     // str
    Consent = 27,        // u8 bool
    MaxTakeSeconds = 28, // u32
    ResumeToken = 29,    // str (32 hex) - never logged
    Accepted = 30,       // u8 bool
    FirstSampleNs = 31,  // i64 estimated local time of the first written sample
    LateFrames = 32,     // u64 frames by which a scheduled start was missed (0 = on time)
    ReadyChecks = 33,    // str, protocol 1.1: readiness checklist "id=0|1,..." (rr/control/readiness.hpp)
    TransferPort = 34,   // u16, protocol 1.2: producer's take-transfer TCP port
    TransferToken = 35,  // str (32 hex), protocol 1.2: one-time transfer token - never logged
    DeliveryConsent = 36,  // u8 bool, protocol 1.2 (READY_STATUS): performer allows take copies (XFER-05)
};

const char* msg_type_name(MsgType type) noexcept;
bool is_known_msg_type(std::uint16_t value) noexcept;

struct Frame {
    MsgType type = MsgType::Error;
    std::uint32_t msg_id = 0;
    std::uint32_t ref_id = 0;
    std::map<std::uint16_t, std::string> fields;  // tag -> raw bytes

    void set_u8(Tag tag, std::uint8_t v);
    void set_u16(Tag tag, std::uint16_t v);
    void set_u32(Tag tag, std::uint32_t v);
    void set_u64(Tag tag, std::uint64_t v);
    void set_i64(Tag tag, std::int64_t v);
    void set_str(Tag tag, const std::string& v);  // truncated to kMaxStringBytes

    bool has(Tag tag) const;
    std::optional<std::uint8_t> u8(Tag tag) const;
    std::optional<std::uint16_t> u16(Tag tag) const;
    std::optional<std::uint32_t> u32(Tag tag) const;
    std::optional<std::uint64_t> u64(Tag tag) const;
    std::optional<std::int64_t> i64(Tag tag) const;
    std::optional<std::string> str(Tag tag) const;
};

// Bytes on the wire, including the u32 length prefix. Throws nothing; oversize frames are
// truncated by construction (callers only build small messages).
std::vector<std::uint8_t> encode(const Frame& frame);

// Tags that must be present (with the right width) for each message type.
std::vector<Tag> required_tags(MsgType type);

// Checks presence and width of the required tags. Returns an empty string if valid.
std::string validate(const Frame& frame);

// Reassembles frames from a TCP byte stream. Bounded: one frame at most kMaxFrameBytes, and
// at most one frame plus 64 KiB buffered. After an error the connection must be closed.
class FrameDecoder {
public:
    enum class Result { NeedMore, Frame, Error };

    void feed(const std::uint8_t* data, std::size_t size);
    Result next(Frame& out, std::string& error);
    std::size_t buffered() const noexcept { return buffer_.size() - offset_; }

private:
    std::vector<std::uint8_t> buffer_;
    std::size_t offset_ = 0;
    bool failed_ = false;
};

}  // namespace rr::net
