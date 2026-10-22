#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

/** Result of reading a WAV file's structure (no audio decoding). */
struct WavInfo
{
    bool readable = false;          // file could be opened
    bool riffWave = false;         // starts with RIFF....WAVE
    bool hasFmt = false;
    bool hasData = false;
    uint16_t formatTag = 0;   // 3 = IEEE float, 0xFFFE = extensible, 1 = PCM
    bool isFloat32 = false;        // IEEE float, 32 bits (direct or via extensible sub-format)
    uint32_t channels = 0;
    uint32_t sampleRate = 0;
    uint32_t bitsPerSample = 0;
    uint32_t blockAlign = 0;
    uint64_t fileBytes = 0;
    uint64_t dataOffset = 0;
    uint64_t dataBytesInHeader = 0;
    uint64_t dataBytesInFile = 0;    // what is actually present after dataOffset
    uint64_t frames = 0;                // whole frames actually present
    uint64_t factFrames = 0;           // from 'fact' if present
    bool headerConsistent = false;          // header sizes match the file contents exactly
    std::vector<std::string> problems;       // human-readable findings

    /** A finished take: valid float32 WAV whose header matches the file. */
    bool isCompleteFloatWav() const noexcept
    {
        return readable && riffWave && hasFmt && hasData && isFloat32 && headerConsistent;
    }
};

WavInfo inspectWav(const std::filesystem::path& path);

/**
 * Recovery of a ".wav.partial" left by a crash (ERR-05b / ERR-10). Writes a NEW file
 * "<stem>.recovered.wav" next to it containing every whole frame present, with a correct
 * header. The ".partial" file is never modified or deleted.
 */
struct RecoveryResult
{
    bool ok = false;
    std::filesystem::path recoveredPath;
    uint64_t frames = 0;
    uint64_t trailingBytesDropped = 0;  // partial frame at the end, if any
    std::string error;
};
RecoveryResult recoverPartial(const std::filesystem::path& partialPath);

/** All "*.wav.partial" files below `root` (recursive). Missing root -> empty list. */
std::vector<std::filesystem::path> findPartialFiles(const std::filesystem::path& root);

