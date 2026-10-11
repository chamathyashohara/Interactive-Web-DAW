#pragma once

// File handling for the take transfer (Stage 11, ADR-020).
//  - The performer's original is opened READ-ONLY, and other writers are refused while it is open
//    (Windows share mode without FILE_SHARE_WRITE), so it cannot change underneath a transfer and
//    the transfer can never change it.
//  - The producer names every received file itself from its own session id and take id
//    (XFER-03). Names that arrive over the network are display-only and sanitised.
//  - Received data goes to "<final>.xfer.partial"; a small journal next to it records how many
//    verified chunks are on disk, so an interrupted transfer resumes where it stopped.

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <optional>
#include <string>

namespace rr::xfer {

class ReadOnlyFile {
public:
    ReadOnlyFile() = default;
    ~ReadOnlyFile();
    ReadOnlyFile(const ReadOnlyFile&) = delete;
    ReadOnlyFile& operator=(const ReadOnlyFile&) = delete;

    bool open(const std::filesystem::path& path, std::string& error);
    // Reads up to `size` bytes at `offset`; got = 0 at the end of the file.
    bool read_at(std::uint64_t offset, void* buffer, std::size_t size, std::size_t& got, std::string& error);
    std::uint64_t size() const noexcept { return size_; }
    bool is_open() const noexcept { return f_ != nullptr; }
    void close() noexcept;

private:
    std::FILE* f_ = nullptr;
    std::uint64_t size_ = 0;
};

// The producer's ".xfer.partial": opened for writing without ever touching any other file.
class PartialFile {
public:
    PartialFile() = default;
    ~PartialFile();
    PartialFile(const PartialFile&) = delete;
    PartialFile& operator=(const PartialFile&) = delete;

    // Creates the file, or opens an existing one cut back to `keep_bytes` (resume).
    bool open(const std::filesystem::path& path, std::uint64_t keep_bytes, std::string& error);
    bool write_at(std::uint64_t offset, const void* data, std::size_t size, std::string& error);
    bool flush_to_disk(std::string& error);
    void close() noexcept;
    bool is_open() const noexcept { return f_ != nullptr; }

private:
    std::FILE* f_ = nullptr;
};

struct ReceivePaths {
    std::filesystem::path dir;       // <producer session folder>/from_performer
    std::filesystem::path final_wav; // take<NN>_performer_<session>.wav
    std::filesystem::path partial;   // <final>.xfer.partial
    std::filesystem::path journal;   // <final>.xfer.journal
    std::filesystem::path record;    // <final>.transfer.json (written once, after VERIFIED)
};

// Builds the paths from trusted local values only. False (with error) if the session id is not
// 8 hex digits or the take id is outside 1..999.
bool make_receive_paths(const std::filesystem::path& dir, const std::string& session_id, std::uint32_t take_id,
                        ReceivePaths& out, std::string& error);

// True if `p`, after normalisation, lies inside `dir` (no "..", no other root).
bool path_is_inside(const std::filesystem::path& dir, const std::filesystem::path& p);

// Display-only form of a name received over the network: keeps [A-Za-z0-9._-], at most 80
// characters, drops any directory part. Never used to build a path.
std::string display_safe_name(const std::string& untrusted);

struct Journal {
    std::string session_id;
    std::uint32_t take_id = 0;
    std::uint64_t file_bytes = 0;
    std::string sha256_hex;
    std::uint32_t chunk_bytes = 0;
    std::uint32_t chunks_done = 0;  // contiguous verified chunks flushed to the partial file
};

std::string journal_text(const Journal& j);
// Strict parse; nullopt for anything unexpected (a torn journal means "start again").
std::optional<Journal> parse_journal(const std::string& text);
bool write_journal(const std::filesystem::path& path, const Journal& j, std::string& error);
std::optional<Journal> read_journal(const std::filesystem::path& path);

}  // namespace rr::xfer
