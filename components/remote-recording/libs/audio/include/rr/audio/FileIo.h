#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <string>

/**
 * Minimal file interface used by the WAV writer, so tests can inject failures
 * (disk full, write errors) without a real full disk.
 */
class WritableFile
{
public:
    virtual ~WritableFile() = default;
    virtual bool write(const void* data, size_t bytes) = 0;           // append at end
    virtual bool writeAt(uint64_t offset, const void* data, size_t bytes) = 0;  // then back to end
    virtual bool flushToDisk() = 0;  // flush buffers and ask the OS to persist (FlushFileBuffers)
    virtual bool close() = 0;
    virtual std::string lastError() const = 0;
};

/**
 * Opens `path` for writing only if it does NOT already exist ("wbx": never overwrites).
 * Returns nullptr and sets `error` on failure.
 */
using FileOpener = std::function<std::unique_ptr<WritableFile>(const std::filesystem::path& path, std::string& error)>;
FileOpener defaultFileOpener();

/**
 * Renames without replacing an existing target (MoveFileExW with MOVEFILE_WRITE_THROUGH and
 * without MOVEFILE_REPLACE_EXISTING on Windows). Returns false and sets `error` on failure.
 */
bool renameNoReplace(const std::filesystem::path& from, const std::filesystem::path& to, std::string& error);

/** Writes `text` to `path` via a temporary file and a no-replace rename. Fails if `path` exists. */
bool writeTextFileAtomically(const std::filesystem::path& path, const std::string& text, std::string& error);

/** Free bytes available to this user on the volume holding `dir` (0 if unknown). */
uint64_t availableDiskBytes(const std::filesystem::path& dir) noexcept;

/** UTF-8 representation of a path, for metadata and logs. */
std::string pathToUtf8(const std::filesystem::path& path);

