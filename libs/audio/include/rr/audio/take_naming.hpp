#pragma once

#include <cstdint>
#include <filesystem>
#include <string>

#include "rr/shared/role.hpp"

namespace rr::audio {

// Session and take naming (REC-03, VER-02).
//   session folder: <root>/<YYYYMMDD-HHMMSS>_<session8>         (UTC time of creation)
//   take file:      take<NN>_<role>_<session8>.wav               (+ .wav.partial, .json)
// The session ID is 8 lower-case hex digits. Later the producer will assign it to both PCs;
// in Stage 4 each app creates its own local session.

std::string make_session_id();  // random, 8 hex digits, never "00000000"

bool is_valid_session_id(const std::string& id) noexcept;

std::string session_folder_name(std::int64_t utc_ms, const std::string& session_id);

// "take07_performer_ab12cd34" (no extension). take_number 1..999.
std::string take_stem(std::uint32_t take_number, Role role, const std::string& session_id);

// Smallest take number >= 1 such that no file starting with that take's stem exists in
// `session_dir` (checks .wav, .wav.partial, .json, .recovered.wav and anything else).
std::uint32_t next_free_take_number(const std::filesystem::path& session_dir, Role role,
                                    const std::string& session_id);

}  // namespace rr::audio
