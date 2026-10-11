#include "rr/control/readiness.hpp"

namespace rr::control {
namespace {

constexpr ReadyItem kAll[] = {ReadyItem::InputDevice,       ReadyItem::EngineHealthy, ReadyItem::FolderWritable,
                              ReadyItem::DiskSpace,         ReadyItem::NoActiveRecording, ReadyItem::Consent,
                              ReadyItem::Connected,         ReadyItem::ClockOffset};

}  // namespace

const char* ready_item_id(ReadyItem item) noexcept {
    switch (item) {
        case ReadyItem::InputDevice: return "input";
        case ReadyItem::EngineHealthy: return "engine";
        case ReadyItem::FolderWritable: return "folder";
        case ReadyItem::DiskSpace: return "disk";
        case ReadyItem::NoActiveRecording: return "idle";
        case ReadyItem::Consent: return "consent";
        case ReadyItem::Connected: return "link";
        case ReadyItem::ClockOffset: return "clock";
    }
    return "unknown";
}

const char* ready_item_label(ReadyItem item) noexcept {
    switch (item) {
        case ReadyItem::InputDevice: return "Input device open";
        case ReadyItem::EngineHealthy: return "Audio engine healthy";
        case ReadyItem::FolderWritable: return "Recording folder writable";
        case ReadyItem::DiskSpace: return "Enough disk space for the longest take";
        case ReadyItem::NoActiveRecording: return "No other recording active";
        case ReadyItem::Consent: return "Recording consent given (armed)";
        case ReadyItem::Connected: return "Connected to the other PC";
        case ReadyItem::ClockOffset: return "Clock offset to the producer measured";
    }
    return "Unknown check";
}

bool ready_item_from_id(const std::string& id, ReadyItem& out) noexcept {
    for (const ReadyItem item : kAll) {
        if (id == ready_item_id(item)) {
            out = item;
            return true;
        }
    }
    return false;
}

std::string encode_checks(const std::vector<ReadinessCheck>& checks) {
    std::string s;
    for (const auto& c : checks) {
        if (!s.empty()) {
            s += ',';
        }
        s += ready_item_id(c.item);
        s += c.ok ? "=1" : "=0";
    }
    return s;
}

std::vector<ReadinessCheck> decode_checks(const std::string& text) {
    std::vector<ReadinessCheck> out;
    std::size_t pos = 0;
    while (pos < text.size()) {
        std::size_t end = text.find(',', pos);
        if (end == std::string::npos) {
            end = text.size();
        }
        const std::string pair = text.substr(pos, end - pos);
        const std::size_t eq = pair.find('=');
        ReadyItem item{};
        if (eq != std::string::npos && ready_item_from_id(pair.substr(0, eq), item)) {
            ReadinessCheck c;
            c.item = item;
            c.ok = pair.substr(eq + 1) == "1";
            out.push_back(c);
        }
        pos = end + 1;
    }
    return out;
}

bool all_mandatory_ok(const std::vector<ReadinessCheck>& checks) noexcept {
    for (const auto& c : checks) {
        if (c.mandatory && !c.ok) {
            return false;
        }
    }
    return true;
}

}  // namespace rr::control
