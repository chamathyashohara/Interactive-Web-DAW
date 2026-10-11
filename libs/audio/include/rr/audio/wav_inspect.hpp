#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace rr::audio {

// Result of reading a WAV file's structure (no audio decoding).
struct WavInfo {
    bool readable = false;          // file could be opened
    bool riff_wave = false;         // starts with RIFF....WAVE
    bool has_fmt = false;
    bool has_data = false;
    std::uint16_t format_tag = 0;   // 3 = IEEE float, 0xFFFE = extensible, 1 = PCM
    bool is_float32 = false;        // IEEE float, 32 bits (direct or via extensible sub-format)
    std::uint32_t channels = 0;
    std::uint32_t sample_rate = 0;
    std::uint32_t bits_per_sample = 0;
    std::uint32_t block_align = 0;
    std::uint64_t file_bytes = 0;
    std::uint64_t data_offset = 0;
    std::uint64_t data_bytes_in_header = 0;
    std::uint64_t data_bytes_in_file = 0;    // what is actually present after data_offset
    std::uint64_t frames = 0;                // whole frames actually present
    std::uint64_t fact_frames = 0;           // from 'fact' if present
    bool header_consistent = false;          // header sizes match the file contents exactly
    std::vector<std::string> problems;       // human-readable findings

    // A finished take: valid float32 WAV whose header matches the file.
    bool is_complete_float_wav() const noexcept {
        return readable && riff_wave && has_fmt && has_data && is_float32 && header_consistent;
    }
};

WavInfo inspect_wav(const std::filesystem::path& path);

// Recovery of a ".wav.partial" left by a crash (ERR-05b / ERR-10). Writes a NEW file
// "<stem>.recovered.wav" next to it containing every whole frame present, with a correct
// header. The ".partial" file is never modified or deleted.
struct RecoveryResult {
    bool ok = false;
    std::filesystem::path recovered_path;
    std::uint64_t frames = 0;
    std::uint64_t trailing_bytes_dropped = 0;  // partial frame at the end, if any
    std::string error;
};
RecoveryResult recover_partial(const std::filesystem::path& partial_path);

// All "*.wav.partial" files below `root` (recursive). Missing root -> empty list.
std::vector<std::filesystem::path> find_partial_files(const std::filesystem::path& root);

}  // namespace rr::audio
