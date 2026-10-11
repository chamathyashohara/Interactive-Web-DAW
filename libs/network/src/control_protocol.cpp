#include "rr/network/control_protocol.hpp"

#include <algorithm>

namespace rr::net {
namespace {

std::string be_bytes(std::uint64_t v, int width) {
    std::string out(static_cast<std::size_t>(width), '\0');
    for (int i = width - 1; i >= 0; --i) {
        out[static_cast<std::size_t>(i)] = static_cast<char>(v & 0xFF);
        v >>= 8;
    }
    return out;
}

std::optional<std::uint64_t> from_be(const std::string& bytes, std::size_t width) {
    if (bytes.size() != width) {
        return std::nullopt;
    }
    std::uint64_t v = 0;
    for (const char c : bytes) {
        v = (v << 8) | static_cast<std::uint8_t>(c);
    }
    return v;
}

void put16(std::vector<std::uint8_t>& out, std::uint16_t v) {
    out.push_back(static_cast<std::uint8_t>(v >> 8));
    out.push_back(static_cast<std::uint8_t>(v & 0xFF));
}

void put32(std::vector<std::uint8_t>& out, std::uint32_t v) {
    for (int i = 3; i >= 0; --i) {
        out.push_back(static_cast<std::uint8_t>((v >> (8 * i)) & 0xFF));
    }
}

std::uint16_t get16(const std::uint8_t* p) {
    return static_cast<std::uint16_t>((p[0] << 8) | p[1]);
}

std::uint32_t get32(const std::uint8_t* p) {
    return (static_cast<std::uint32_t>(p[0]) << 24) | (static_cast<std::uint32_t>(p[1]) << 16) |
           (static_cast<std::uint32_t>(p[2]) << 8) | static_cast<std::uint32_t>(p[3]);
}

int tag_width(Tag tag) {
    switch (tag) {
    case Tag::Role:
    case Tag::Ready:
    case Tag::State:
    case Tag::Status:
    case Tag::Consent:
    case Tag::Accepted:
    case Tag::DeliveryConsent:
        return 1;
    case Tag::ProtoMajor:
    case Tag::ProtoMinor:
    case Tag::ErrorCode:
    case Tag::TransferPort:
        return 2;
    case Tag::TakeId:
    case Tag::MaxTakeSeconds:
        return 4;
    case Tag::SentNs:
    case Tag::StartAtNs:
    case Tag::StopAtNs:
    case Tag::PlannedLocalNs:
    case Tag::ThetaNs:
    case Tag::UncertaintyNs:
    case Tag::EchoSentNs:
    case Tag::RecvNs:
    case Tag::FirstFrame:
    case Tag::Frames:
    case Tag::FirstSampleNs:
    case Tag::LateFrames:
        return 8;
    default:
        return 0;  // string
    }
}

}  // namespace

const char* msg_type_name(MsgType type) noexcept {
    switch (type) {
    case MsgType::Hello: return "HELLO";
    case MsgType::HelloAck: return "HELLO_ACK";
    case MsgType::Join: return "JOIN";
    case MsgType::JoinAck: return "JOIN_ACK";
    case MsgType::Error: return "ERROR";
    case MsgType::Heartbeat: return "HEARTBEAT";
    case MsgType::HeartbeatAck: return "HEARTBEAT_ACK";
    case MsgType::ReadyStatus: return "READY_STATUS";
    case MsgType::Arm: return "ARM";
    case MsgType::ArmAck: return "ARM_ACK";
    case MsgType::ScheduleStart: return "SCHEDULE_START";
    case MsgType::StartAck: return "START_ACK";
    case MsgType::TakeStarted: return "TAKE_STARTED";
    case MsgType::Cancel: return "CANCEL";
    case MsgType::StopSchedule: return "STOP_SCHEDULE";
    case MsgType::StopAck: return "STOP_ACK";
    case MsgType::LocalStop: return "LOCAL_STOP";
    case MsgType::TakeFinalised: return "TAKE_FINALISED";
    case MsgType::SessionClosed: return "SESSION_CLOSED";
    case MsgType::TransferRequest: return "TRANSFER_REQUEST";
    case MsgType::TransferAck: return "TRANSFER_ACK";
    }
    return "UNKNOWN";
}

bool is_known_msg_type(std::uint16_t value) noexcept {
    return std::string(msg_type_name(static_cast<MsgType>(value))) != "UNKNOWN";
}

void Frame::set_u8(Tag tag, std::uint8_t v) { fields[static_cast<std::uint16_t>(tag)] = be_bytes(v, 1); }
void Frame::set_u16(Tag tag, std::uint16_t v) { fields[static_cast<std::uint16_t>(tag)] = be_bytes(v, 2); }
void Frame::set_u32(Tag tag, std::uint32_t v) { fields[static_cast<std::uint16_t>(tag)] = be_bytes(v, 4); }
void Frame::set_u64(Tag tag, std::uint64_t v) { fields[static_cast<std::uint16_t>(tag)] = be_bytes(v, 8); }
void Frame::set_i64(Tag tag, std::int64_t v) {
    fields[static_cast<std::uint16_t>(tag)] = be_bytes(static_cast<std::uint64_t>(v), 8);
}
void Frame::set_str(Tag tag, const std::string& v) {
    fields[static_cast<std::uint16_t>(tag)] = v.substr(0, kMaxStringBytes);
}

bool Frame::has(Tag tag) const {
    return fields.count(static_cast<std::uint16_t>(tag)) != 0;
}

namespace {
template <typename T>
std::optional<T> get_int(const Frame& f, Tag tag, std::size_t width) {
    const auto it = f.fields.find(static_cast<std::uint16_t>(tag));
    if (it == f.fields.end()) {
        return std::nullopt;
    }
    const auto v = from_be(it->second, width);
    if (!v) {
        return std::nullopt;
    }
    return static_cast<T>(*v);
}
}  // namespace

std::optional<std::uint8_t> Frame::u8(Tag tag) const { return get_int<std::uint8_t>(*this, tag, 1); }
std::optional<std::uint16_t> Frame::u16(Tag tag) const { return get_int<std::uint16_t>(*this, tag, 2); }
std::optional<std::uint32_t> Frame::u32(Tag tag) const { return get_int<std::uint32_t>(*this, tag, 4); }
std::optional<std::uint64_t> Frame::u64(Tag tag) const { return get_int<std::uint64_t>(*this, tag, 8); }
std::optional<std::int64_t> Frame::i64(Tag tag) const { return get_int<std::int64_t>(*this, tag, 8); }
std::optional<std::string> Frame::str(Tag tag) const {
    const auto it = fields.find(static_cast<std::uint16_t>(tag));
    if (it == fields.end()) {
        return std::nullopt;
    }
    return it->second;
}

std::vector<std::uint8_t> encode(const Frame& f) {
    std::vector<std::uint8_t> out;
    out.reserve(64);
    put32(out, 0);  // length placeholder
    put16(out, static_cast<std::uint16_t>(f.type));
    put16(out, 0);
    put32(out, f.msg_id);
    put32(out, f.ref_id);
    for (const auto& [tag, value] : f.fields) {
        const std::size_t room = 4 + kMaxFrameBytes - out.size();
        if (room < 4) {
            break;
        }
        const std::size_t len = std::min<std::size_t>({value.size(), room - 4, 0xFFFF});
        put16(out, tag);
        put16(out, static_cast<std::uint16_t>(len));
        out.insert(out.end(), value.begin(), value.begin() + static_cast<std::ptrdiff_t>(len));
    }
    const auto length = static_cast<std::uint32_t>(out.size() - 4);
    for (int i = 0; i < 4; ++i) {
        out[static_cast<std::size_t>(i)] = static_cast<std::uint8_t>((length >> (8 * (3 - i))) & 0xFF);
    }
    return out;
}

std::vector<Tag> required_tags(MsgType type) {
    std::vector<Tag> r{Tag::SentNs};
    switch (type) {
    case MsgType::Hello:
        r.insert(r.end(), {Tag::ProtoMajor, Tag::ProtoMinor, Tag::Role, Tag::AppVersion});
        break;
    case MsgType::HelloAck:
        r.insert(r.end(), {Tag::ProtoMajor, Tag::ProtoMinor, Tag::AppVersion});
        break;
    case MsgType::Join:
        r.insert(r.end(), {Tag::ClientId, Tag::DisplayName});  // + PairingCode or ResumeToken (checked by the server)
        break;
    case MsgType::JoinAck:
        r.insert(r.end(), {Tag::SessionId, Tag::ResumeToken, Tag::DisplayName, Tag::MaxTakeSeconds});
        break;
    case MsgType::Error:
        r.insert(r.end(), {Tag::ErrorCode});
        break;
    case MsgType::Heartbeat:
        break;
    case MsgType::HeartbeatAck:
        r.insert(r.end(), {Tag::EchoSentNs, Tag::RecvNs});
        break;
    case MsgType::ReadyStatus:
        r.insert(r.end(), {Tag::Ready, Tag::Consent, Tag::State});
        break;
    case MsgType::Arm:
        r.insert(r.end(), {Tag::TakeId, Tag::MaxTakeSeconds});
        break;
    case MsgType::ArmAck:
    case MsgType::StartAck:
    case MsgType::StopAck:
        r.insert(r.end(), {Tag::TakeId, Tag::Accepted});
        break;
    case MsgType::ScheduleStart:
        r.insert(r.end(), {Tag::TakeId, Tag::StartAtNs});
        break;
    case MsgType::TakeStarted:
        r.insert(r.end(), {Tag::TakeId, Tag::FirstFrame, Tag::FirstSampleNs});
        break;
    case MsgType::Cancel:
        r.insert(r.end(), {Tag::TakeId, Tag::ErrorCode});
        break;
    case MsgType::StopSchedule:
        r.insert(r.end(), {Tag::TakeId, Tag::StopAtNs});
        break;
    case MsgType::LocalStop:
        r.insert(r.end(), {Tag::TakeId, Tag::StopReason});
        break;
    case MsgType::TakeFinalised:
        r.insert(r.end(), {Tag::TakeId, Tag::Status, Tag::Frames});
        break;
    case MsgType::SessionClosed:
        r.insert(r.end(), {Tag::ErrorCode});
        break;
    case MsgType::TransferRequest:
        r.insert(r.end(), {Tag::TakeId, Tag::TransferPort, Tag::TransferToken});
        break;
    case MsgType::TransferAck:
        r.insert(r.end(), {Tag::TakeId, Tag::Accepted});
        break;
    }
    return r;
}

std::string validate(const Frame& f) {
    if (!is_known_msg_type(static_cast<std::uint16_t>(f.type))) {
        return "unknown message type";
    }
    for (const Tag tag : required_tags(f.type)) {
        const auto it = f.fields.find(static_cast<std::uint16_t>(tag));
        if (it == f.fields.end()) {
            return std::string(msg_type_name(f.type)) + ": missing field " + std::to_string(static_cast<int>(tag));
        }
        const int width = tag_width(tag);
        if (width != 0 && it->second.size() != static_cast<std::size_t>(width)) {
            return std::string(msg_type_name(f.type)) + ": field " + std::to_string(static_cast<int>(tag)) +
                   " has the wrong size";
        }
    }
    for (const auto& [tag, value] : f.fields) {
        const int width = tag_width(static_cast<Tag>(tag));
        if (width == 0 && value.size() > kMaxStringBytes) {
            return "string field too long";
        }
        if (width != 0 && value.size() != static_cast<std::size_t>(width)) {
            return "field " + std::to_string(tag) + " has the wrong size";
        }
    }
    return {};
}

void FrameDecoder::feed(const std::uint8_t* data, std::size_t size) {
    if (failed_) {
        return;
    }
    if (offset_ > 0 && offset_ == buffer_.size()) {
        buffer_.clear();
        offset_ = 0;
    }
    buffer_.insert(buffer_.end(), data, data + size);
}

FrameDecoder::Result FrameDecoder::next(Frame& out, std::string& error) {
    if (failed_) {
        error = "decoder already failed";
        return Result::Error;
    }
    const std::size_t available = buffer_.size() - offset_;
    if (available > 4 + kMaxFrameBytes + 65536) {
        failed_ = true;
        error = "too much unread data";
        return Result::Error;
    }
    if (available < 4) {
        return Result::NeedMore;
    }
    const std::uint8_t* p = buffer_.data() + offset_;
    const std::uint32_t length = get32(p);
    if (length < kHeaderBytes || length > kMaxFrameBytes) {
        failed_ = true;
        error = "frame length " + std::to_string(length) + " out of range";
        return Result::Error;
    }
    if (available < 4 + static_cast<std::size_t>(length)) {
        return Result::NeedMore;
    }
    const std::uint8_t* body = p + 4;
    const std::uint16_t type = get16(body);
    if (!is_known_msg_type(type)) {
        failed_ = true;
        error = "unknown message type " + std::to_string(type);
        return Result::Error;
    }
    if (get16(body + 2) != 0) {
        failed_ = true;
        error = "reserved field not zero";
        return Result::Error;
    }
    Frame f;
    f.type = static_cast<MsgType>(type);
    f.msg_id = get32(body + 4);
    f.ref_id = get32(body + 8);
    std::size_t pos = kHeaderBytes;
    while (pos < length) {
        if (pos + 4 > length) {
            failed_ = true;
            error = "truncated TLV header";
            return Result::Error;
        }
        const std::uint16_t tag = get16(body + pos);
        const std::uint16_t len = get16(body + pos + 2);
        pos += 4;
        if (pos + len > length) {
            failed_ = true;
            error = "TLV runs past the end of the frame";
            return Result::Error;
        }
        if (f.fields.count(tag) != 0) {
            failed_ = true;
            error = "duplicate tag " + std::to_string(tag);
            return Result::Error;
        }
        f.fields.emplace(tag, std::string(reinterpret_cast<const char*>(body + pos), len));
        pos += len;
    }
    offset_ += 4 + length;
    const std::string problem = validate(f);
    if (!problem.empty()) {
        failed_ = true;
        error = problem;
        return Result::Error;
    }
    out = std::move(f);
    return Result::Frame;
}

}  // namespace rr::net
