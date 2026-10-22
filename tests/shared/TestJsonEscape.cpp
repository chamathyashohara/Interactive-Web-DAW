#include <catch2/catch_test_macros.hpp>

#include "rr/shared/JsonEscape.h"

TEST_CASE("JSON escaping of special characters", "[shared][json]")
{
    CHECK(jsonEscape("plain") == "plain");
    CHECK(jsonEscape("a\"b") == "a\\\"b");
    CHECK(jsonEscape("C:\\takes") == "C:\\\\takes");
    CHECK(jsonEscape("line1\nline2\r\t") == "line1\\nline2\\r\\t");
    CHECK(jsonEscape(std::string("\x01\x1f", 2)) == "\\u0001\\u001f");
}

TEST_CASE("UTF-8 text passes through unchanged", "[shared][json]")
{
    const std::string sinhala = "\xe0\xb7\x83\xe0\xb7\x92\xe0\xb6\xb1\xe0\xb7\x8a";  // UTF-8 bytes
    CHECK(jsonEscape(sinhala) == sinhala);
}
