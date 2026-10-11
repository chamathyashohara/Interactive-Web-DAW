#include <catch2/catch_test_macros.hpp>

#include "rr/shared/json_escape.hpp"

using rr::json_escape;

TEST_CASE("JSON escaping of special characters", "[shared][json]") {
    CHECK(json_escape("plain") == "plain");
    CHECK(json_escape("a\"b") == "a\\\"b");
    CHECK(json_escape("C:\\takes") == "C:\\\\takes");
    CHECK(json_escape("line1\nline2\r\t") == "line1\\nline2\\r\\t");
    CHECK(json_escape(std::string("\x01\x1f", 2)) == "\\u0001\\u001f");
}

TEST_CASE("UTF-8 text passes through unchanged", "[shared][json]") {
    const std::string sinhala = "\xe0\xb7\x83\xe0\xb7\x92\xe0\xb6\xb1\xe0\xb7\x8a";  // UTF-8 bytes
    CHECK(json_escape(sinhala) == sinhala);
}
