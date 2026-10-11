#pragma once

#include <string>
#include <string_view>

namespace rr {

// Escapes text for use inside a JSON string literal (RFC 8259): quote, backslash and
// control characters below 0x20. UTF-8 bytes are passed through unchanged.
void append_json_escaped(std::string& out, std::string_view text);
std::string json_escape(std::string_view text);

}  // namespace rr
