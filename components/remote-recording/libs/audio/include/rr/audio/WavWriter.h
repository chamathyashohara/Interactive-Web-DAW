#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>

#include "rr/audio/FileIo.h"
#include "rr/audio/WavFormat.h"

/**
 * Safe WAV file lifecycle (ADR-007). Used only from the recorder worker thread.
 *
 * open(finalPath)  -> creates "<finalPath>.partial" exclusively (never overwrites) and
 * writes a header that describes 0 frames
 * writeFrames()    -> appends float32 frames; any failure latches an error
 * refreshHeader()  -> rewrites the size fields so a crash leaves a recoverable file
 * finalise()        -> writes the final header, flushes to disk, closes, renames
 * ".partial" -> final name without replacing anything
 * abandon()         -> closes after an error, keeps ".partial" with the best header possible
 */
class WavWriter
{
public:
    explicit WavWriter(FileOpener opener = defaultFileOpener());
    ~WavWriter();  // abandons an open file (never deletes it)
    WavWriter(const WavWriter&) = delete;
    WavWriter& operator=(const WavWriter&) = delete;

    bool open(const std::filesystem::path& finalPath, const WavFormat& format);
    bool writeFrames(const float* interleaved, uint64_t frames);
    bool writeSilence(uint64_t frames);
    bool refreshHeader();
    bool finalise();
    void abandon();

    bool is_open() const noexcept { return file != nullptr; }
    bool hasFailed() const noexcept { return failed; }
    bool isFinalised() const noexcept { return finalised; }
    bool isSizeLimitReached() const noexcept { return sizeLimitReached; }
    const std::string& getError() const noexcept { return error; }
    uint64_t framesWritten() const noexcept { return frames; }
    const WavFormat& getFormat() const noexcept { return format; }
    const std::filesystem::path& getPartialPath() const noexcept { return partialPath; }
    const std::filesystem::path& getFinalPath() const noexcept { return finalPath; }

    static std::filesystem::path partialPathFor(const std::filesystem::path& finalPath);

private:
    bool fail(const std::string& message);

    FileOpener opener;
    std::unique_ptr<WritableFile> file;
    WavFormat format;
    std::filesystem::path finalPath;
    std::filesystem::path partialPath;
    uint64_t frames = 0;
    uint64_t maxFrames = 0;
    bool failed = false;
    bool finalised = false;
    bool sizeLimitReached = false;
    std::string error;
};

