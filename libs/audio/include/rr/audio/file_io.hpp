#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <string>

namespace rr::audio {

// Minimal file interface used by the WAV writer, so tests can inject failures
// (disk full, write errors) without a real full disk.
class WritableFile {
public:
    virtual ~WritableFile() = default;
    virtual bool write(const void* data, std::size_t bytes) = 0;           // append at end
    virtual bool write_at(std::uint64_t offset, const void* data, std::size_t bytes) = 0;  // then back to end
    virtual bool flush_to_disk() = 0;  // flush buffers and ask the OS to persist (FlushFileBuffers)
    virtual bool close() = 0;
    virtual std::string last_error() const = 0;
};

// Opens `path` for writing only if it does NOT already exist ("wbx": never overwrites).
// Returns nullptr and sets `error` on failure.
using FileOpener = std::function<std::unique_ptr<WritableFile>(const std::filesystem::path& path, std::string& error)>;
FileOpener default_file_opener();

// Renames without replacing an existing target (MoveFileExW with MOVEFILE_WRITE_THROUGH and
// without MOVEFILE_REPLACE_EXISTING on Windows). Returns false and sets `error` on failure.
bool rename_no_replace(const std::filesystem::path& from, const std::filesystem::path& to, std::string& error);

// Writes `text` to `path` via a temporary file and a no-replace rename. Fails if `path` exists.
bool write_text_file_atomically(const std::filesystem::path& path, const std::string& text, std::string& error);

// Free bytes available to this user on the volume holding `dir` (0 if unknown).
std::uint64_t available_disk_bytes(const std::filesystem::path& dir) noexcept;

// UTF-8 representation of a path, for metadata and logs.
std::string path_to_utf8(const std::filesystem::path& path);

}  // namespace rr::audio
