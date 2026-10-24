#pragma once

#include <cstdint>
#include <filesystem>
#include <string>

#include "rr/shared/Role.h"

// Session and take naming (REC-03, VER-02).
//   session folder: <root>/<YYYYMMDD-HHMMSS>_<session8>         (UTC time of creation)
//   take file:      take<NN>_<role>_<session8>.wav               (+ .wav.partial, .json)
// The session ID is 8 lower-case hex digits. Later the producer will assign it to both PCs;
// in Stage 4 each app creates its own local session.

std::string makeSessionId();  // random, 8 hex digits, never "00000000"

bool isValidSessionId(const std::string& id) noexcept;

std::string sessionFolderName(int64_t utcMs, const std::string& sessionId);

/** "take07_performer_ab12cd34" (no extension). takeNumber 1..999. */
std::string takeStem(uint32_t takeNumber, Role role, const std::string& sessionId);

/**
 * Smallest take number >= 1 such that no file starting with that take's stem exists in
 * `sessionDir` (checks .wav, .wav.partial, .json, .recovered.wav and anything else).
 */
uint32_t nextFreeTakeNumber(const std::filesystem::path& sessionDir, Role role,
                                    const std::string& sessionId);

