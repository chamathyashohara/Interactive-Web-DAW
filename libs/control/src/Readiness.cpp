#include "rr/control/Readiness.h"

namespace
{

constexpr ReadyItem kAll[] = {ReadyItem::InputDevice,       ReadyItem::EngineHealthy, ReadyItem::FolderWritable,
                              ReadyItem::DiskSpace,         ReadyItem::NoActiveRecording, ReadyItem::Consent,
                              ReadyItem::Connected,         ReadyItem::ClockOffset};

}  // namespace

const char* readyItemId(ReadyItem item) noexcept
{
    switch (item)
    {
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

const char* readyItemLabel(ReadyItem item) noexcept
{
    switch (item)
    {
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

bool readyItemFromId(const std::string& id, ReadyItem& out) noexcept
{
    for (const ReadyItem item : kAll)
    {
        if (id == readyItemId(item))
        {
            out = item;
            return true;
        }
    }
    return false;
}

std::string encodeChecks(const std::vector<ReadinessCheck>& checks)
{
    std::string s;
    for (const auto& c : checks)
    {
        if (!s.empty())
        {
            s += ',';
        }
        s += readyItemId(c.item);
        s += c.ok ? "=1" : "=0";
    }
    return s;
}

std::vector<ReadinessCheck> decodeChecks(const std::string& text)
{
    std::vector<ReadinessCheck> out;
    size_t pos = 0;
    while (pos < text.size())
    {
        size_t end = text.find(',', pos);
        if (end == std::string::npos)
        {
            end = text.size();
        }
        const std::string pair = text.substr(pos, end - pos);
        const size_t eq = pair.find('=');
        ReadyItem item{};
        if (eq != std::string::npos && readyItemFromId(pair.substr(0, eq), item))
        {
            ReadinessCheck c;
            c.item = item;
            c.ok = pair.substr(eq + 1) == "1";
            out.push_back(c);
        }
        pos = end + 1;
    }
    return out;
}

bool allMandatoryOk(const std::vector<ReadinessCheck>& checks) noexcept
{
    for (const auto& c : checks)
    {
        if (c.mandatory && !c.ok)
        {
            return false;
        }
    }
    return true;
}

