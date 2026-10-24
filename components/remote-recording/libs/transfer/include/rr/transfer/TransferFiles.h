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

class ReadOnlyFile
{
public:
    ReadOnlyFile() = default;
    ~ReadOnlyFile();
    ReadOnlyFile(const ReadOnlyFile&) = delete;
    ReadOnlyFile& operator=(const ReadOnlyFile&) = delete;

    bool open(const std::filesystem::path& path, std::string& error);
    /** Reads up to `size` bytes at `offset`; got = 0 at the end of the file. */
    bool readAt(uint64_t offset, void* buffer, size_t size, size_t& got, std::string& error);
    uint64_t getSize() const noexcept { return size; }
    bool is_open() const noexcept { return f != nullptr; }
    void close() noexcept;

private:
    std::FILE* f = nullptr;
    uint64_t size = 0;
};

/** The producer's ".xfer.partial": opened for writing without ever touching any other file. */
class PartialFile
{
public:
    PartialFile() = default;
    ~PartialFile();
    PartialFile(const PartialFile&) = delete;
    PartialFile& operator=(const PartialFile&) = delete;

    /** Creates the file, or opens an existing one cut back to `keepBytes` (resume). */
    bool open(const std::filesystem::path& path, uint64_t keepBytes, std::string& error);
    bool writeAt(uint64_t offset, const void* data, size_t size, std::string& error);
    bool flushToDisk(std::string& error);
    void close() noexcept;
    bool is_open() const noexcept { return f != nullptr; }

private:
    std::FILE* f = nullptr;
};

struct ReceivePaths
{
    std::filesystem::path dir;       // <producer session folder>/from_performer
    std::filesystem::path finalWav; // take<NN>_performer_<session>.wav
    std::filesystem::path partial;   // <final>.xfer.partial
    std::filesystem::path journal;   // <final>.xfer.journal
    std::filesystem::path record;    // <final>.transfer.json (written once, after VERIFIED)
};

/**
 * Builds the paths from trusted local values only. False (with error) if the session id is not
 * 8 hex digits or the take id is outside 1..999.
 */
bool makeReceivePaths(const std::filesystem::path& dir, const std::string& sessionId, uint32_t takeId,
                        ReceivePaths& out, std::string& error);

/** True if `p`, after normalisation, lies inside `dir` (no "..", no other root). */
bool pathIsInside(const std::filesystem::path& dir, const std::filesystem::path& p);

/**
 * Display-only form of a name received over the network: keeps [A-Za-z0-9._-], at most 80
 * characters, drops any directory part. Never used to build a path.
 */
std::string displaySafeName(const std::string& untrusted);

struct Journal
{
    std::string sessionId;
    uint32_t takeId = 0;
    uint64_t fileBytes = 0;
    std::string sha256Hex;
    uint32_t chunkBytes = 0;
    uint32_t chunksDone = 0;  // contiguous verified chunks flushed to the partial file
};

std::string journalText(const Journal& j);
/** Strict parse; nullopt for anything unexpected (a torn journal means "start again"). */
std::optional<Journal> parseJournal(const std::string& text);
bool writeJournal(const std::filesystem::path& path, const Journal& j, std::string& error);
std::optional<Journal> readJournal(const std::filesystem::path& path);

