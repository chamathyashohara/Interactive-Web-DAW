#include "rr/shared/clock.hpp"
#include "rr/shared/json_escape.hpp"
#include "rr/shared/log.hpp"

namespace rr::log {

std::string_view level_name(Level level) noexcept {
    switch (level) {
    case Level::Trace: return "trace";
    case Level::Debug: return "debug";
    case Level::Info: return "info";
    case Level::Warn: return "warn";
    case Level::Error: return "error";
    }
    return "unknown";
}

std::string to_json_line(const Record& r) {
    std::string out;
    out.reserve(160 + r.message.size());
    out += "{\"t_utc\":\"";
    out += time::format_utc_iso8601_ms(r.utc_ms);
    out += "\",\"t_mono_ns\":";
    out += std::to_string(r.mono_ns);
    out += ",\"lvl\":\"";
    out += level_name(r.level);
    out += "\",\"comp\":\"";
    append_json_escaped(out, r.component);
    out += "\",\"event\":\"";
    append_json_escaped(out, r.event);
    out += "\",\"msg\":\"";
    append_json_escaped(out, r.message);
    out += "\",\"tid\":";
    out += std::to_string(r.thread_id);
    out += ",\"fields\":{";
    bool first = true;
    for (const Field& f : r.fields) {
        if (!first) {
            out += ',';
        }
        first = false;
        out += '"';
        append_json_escaped(out, f.key);
        out += "\":\"";
        append_json_escaped(out, f.value);
        out += '"';
    }
    out += "}}";
    return out;
}

}  // namespace rr::log
