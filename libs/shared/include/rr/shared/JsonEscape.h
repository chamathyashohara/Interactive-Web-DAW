#pragma once

#include <string>
#include <string_view>

/**
 * Escapes text for use inside a JSON string literal (RFC 8259): quote, backslash and
 * control characters below 0x20. UTF-8 bytes are passed through unchanged.
 */
void appendJsonEscaped(std::string& out, std::string_view text);
std::string jsonEscape(std::string_view text);

