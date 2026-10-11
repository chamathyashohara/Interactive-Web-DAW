#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>

#include "rr/audio/file_io.hpp"
#include "rr/audio/wav_format.hpp"

namespace rr::audio {

// Safe WAV file lifecycle (ADR-007). Used only from the recorder worker thread.
//
//   open(final_path)  -> creates "<final_path>.partial" exclusively (never overwrites) and
//                        writes a header that describes 0 frames
//   write_frames()    -> appends float32 frames; any failure latches an error
//   refresh_header()  -> rewrites the size fields so a crash leaves a recoverable file
//   finalise()        -> writes the final header, flushes to disk, closes, renames
//                        ".partial" -> final name without replacing anything
//   abandon()         -> closes after an error, keeps ".partial" with the best header possible
class WavWriter {
public:
    explicit WavWriter(FileOpener opener = default_file_opener());
    ~WavWriter();  // abandons an open file (never deletes it)
    WavWriter(const WavWriter&) = delete;
    WavWriter& operator=(const WavWriter&) = delete;

    bool open(const std::filesystem::path& final_path, const WavFormat& format);
    bool write_frames(const float* interleaved, std::uint64_t frames);
    bool write_silence(std::uint64_t frames);
    bool refresh_header();
    bool finalise();
    void abandon();

    bool is_open() const noexcept { return file_ != nullptr; }
    bool failed() const noexcept { return failed_; }
    bool finalised() const noexcept { return finalised_; }
    bool size_limit_reached() const noexcept { return size_limit_reached_; }
    const std::string& error() const noexcept { return error_; }
    std::uint64_t frames_written() const noexcept { return frames_; }
    const WavFormat& format() const noexcept { return format_; }
    const std::filesystem::path& partial_path() const noexcept { return partial_path_; }
    const std::filesystem::path& final_path() const noexcept { return final_path_; }

    static std::filesystem::path partial_path_for(const std::filesystem::path& final_path);

private:
    bool fail(const std::string& message);

    FileOpener opener_;
    std::unique_ptr<WritableFile> file_;
    WavFormat format_;
    std::filesystem::path final_path_;
    std::filesystem::path partial_path_;
    std::uint64_t frames_ = 0;
    std::uint64_t max_frames_ = 0;
    bool failed_ = false;
    bool finalised_ = false;
    bool size_limit_reached_ = false;
    std::string error_;
};

}  // namespace rr::audio
