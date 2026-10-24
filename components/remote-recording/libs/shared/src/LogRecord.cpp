#include "rr/shared/Clock.h"
#include "rr/shared/JsonEscape.h"
#include "rr/shared/Log.h"

std::string_view levelName(Level level) noexcept
{
    switch (level)
    {
    case Level::Trace: return "trace";
    case Level::Debug: return "debug";
    case Level::Info: return "info";
    case Level::Warn: return "warn";
    case Level::Error: return "error";
    }
    return "unknown";
}

std::string toJsonLine(const Record& r)
{
    std::string out;
    out.reserve(160 + r.message.size());
    out += "{\"t_utc\":\"";
    out += formatUtcIso8601Ms(r.utcMs);
    out += "\",\"t_mono_ns\":";
    out += std::to_string(r.monoNs);
    out += ",\"lvl\":\"";
    out += levelName(r.level);
    out += "\",\"comp\":\"";
    appendJsonEscaped(out, r.component);
    out += "\",\"event\":\"";
    appendJsonEscaped(out, r.event);
    out += "\",\"msg\":\"";
    appendJsonEscaped(out, r.message);
    out += "\",\"tid\":";
    out += std::to_string(r.threadId);
    out += ",\"fields\":{";
    bool first = true;
    for (const Field& f : r.fields)
    {
        if (!first)
        {
            out += ',';
        }
        first = false;
        out += '"';
        appendJsonEscaped(out, f.key);
        out += "\":\"";
        appendJsonEscaped(out, f.value);
        out += '"';
    }
    out += "}}";
    return out;
}

