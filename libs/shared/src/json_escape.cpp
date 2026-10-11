#include "rr/shared/json_escape.hpp"

namespace rr {

void append_json_escaped(std::string& out, std::string_view text) {
    static constexpr char kHex[] = "0123456789abcdef";
    for (const char ch : text) {
        const auto byte = static_cast<unsigned char>(ch);
        switch (ch) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        default:
            if (byte < 0x20) {
                out += "\\u00";
                out += kHex[byte >> 4];
                out += kHex[byte & 0x0F];
            } else {
                out += ch;
            }
        }
    }
}

std::string json_escape(std::string_view text) {
    std::string out;
    out.reserve(text.size() + 8);
    append_json_escaped(out, text);
    return out;
}

}  // namespace rr
