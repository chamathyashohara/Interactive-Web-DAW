#include "rr/audio/take_naming.hpp"

#include <cstdio>
#include <random>
#include <system_error>

#include "rr/audio/file_io.hpp"
#include "rr/shared/clock.hpp"

namespace rr::audio {

std::string make_session_id() {
    std::random_device rd;
    std::uint32_t value = 0;
    while (value == 0) {
        value = (static_cast<std::uint32_t>(rd()) << 1) ^ static_cast<std::uint32_t>(rd());
    }
    char text[9];
    std::snprintf(text, sizeof text, "%08x", value);
    return text;
}

bool is_valid_session_id(const std::string& id) noexcept {
    if (id.size() != 8 || id == "00000000") {
        return false;
    }
    for (const char c : id) {
        const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        if (!hex) {
            return false;
        }
    }
    return true;
}

std::string session_folder_name(std::int64_t utc_ms, const std::string& session_id) {
    // "2026-10-11T04:05:06.789Z" -> "20261011-040506"
    const std::string iso = time::format_utc_iso8601_ms(utc_ms);
    std::string compact;
    compact += iso.substr(0, 4);
    compact += iso.substr(5, 2);
    compact += iso.substr(8, 2);
    compact += '-';
    compact += iso.substr(11, 2);
    compact += iso.substr(14, 2);
    compact += iso.substr(17, 2);
    return compact + "_" + session_id;
}

std::string take_stem(std::uint32_t take_number, Role role, const std::string& session_id) {
    char number[8];
    std::snprintf(number, sizeof number, "%02u", static_cast<unsigned>(take_number));
    return std::string("take") + number + "_" + std::string(role_id(role)) + "_" + session_id;
}

std::uint32_t next_free_take_number(const std::filesystem::path& session_dir, Role role,
                                    const std::string& session_id) {
    for (std::uint32_t n = 1; n < 1000; ++n) {
        const std::string stem = take_stem(n, role, session_id);
        bool used = false;
        std::error_code ec;
        if (std::filesystem::exists(session_dir, ec)) {
            for (const auto& entry : std::filesystem::directory_iterator(session_dir, ec)) {
                const std::string name = path_to_utf8(entry.path().filename());
                if (name.compare(0, stem.size(), stem) == 0 &&
                    (name.size() == stem.size() || name[stem.size()] == '.')) {
                    used = true;
                    break;
                }
            }
        }
        if (!used) {
            return n;
        }
    }
    return 0;  // 999 takes in one session: caller reports "no free take number"
}

}  // namespace rr::audio
