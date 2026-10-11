#include "rr/audio/wav_writer.hpp"

#include <utility>
#include <vector>

namespace rr::audio {

WavWriter::WavWriter(FileOpener opener) : opener_(std::move(opener)) {}

WavWriter::~WavWriter() {
    if (file_) {
        abandon();
    }
}

std::filesystem::path WavWriter::partial_path_for(const std::filesystem::path& final_path) {
    std::filesystem::path p = final_path;
    p += ".partial";
    return p;
}

bool WavWriter::fail(const std::string& message) {
    if (!failed_) {
        failed_ = true;
        error_ = message;
    }
    return false;
}

bool WavWriter::open(const std::filesystem::path& final_path, const WavFormat& format) {
    if (file_) {
        return fail("writer already has an open file");
    }
    if (!format.valid()) {
        return fail("unsupported WAV format: " + std::to_string(format.channels) + " channels at " +
                    std::to_string(format.sample_rate) + " Hz");
    }
    std::error_code ec;
    if (std::filesystem::exists(final_path, ec)) {
        return fail("take file already exists, refusing to overwrite: " + path_to_utf8(final_path));
    }
    format_ = format;
    final_path_ = final_path;
    partial_path_ = partial_path_for(final_path);
    frames_ = 0;
    max_frames_ = max_wav_frames(format);

    std::string open_error;
    file_ = opener_(partial_path_, open_error);
    if (!file_) {
        return fail(open_error);
    }
    const std::vector<std::uint8_t> header = build_wav_header(format_, 0);
    if (!file_->write(header.data(), header.size())) {
        return fail("cannot write WAV header: " + file_->last_error());
    }
    return true;
}

bool WavWriter::write_frames(const float* interleaved, std::uint64_t frames) {
    if (failed_ || !file_) {
        return false;
    }
    if (frames_ + frames > max_frames_) {
        size_limit_reached_ = true;
        return fail("WAV size limit (4 GiB) reached");
    }
    const auto bytes = static_cast<std::size_t>(frames * format_.block_align());
    if (!file_->write(interleaved, bytes)) {
        return fail("write failed after " + std::to_string(frames_) + " frames: " + file_->last_error());
    }
    frames_ += frames;
    return true;
}

bool WavWriter::write_silence(std::uint64_t frames) {
    static constexpr std::uint64_t kChunkFrames = 4096;
    std::vector<float> zeros(static_cast<std::size_t>(kChunkFrames * format_.channels), 0.0f);
    while (frames > 0) {
        const std::uint64_t n = frames < kChunkFrames ? frames : kChunkFrames;
        if (!write_frames(zeros.data(), n)) {
            return false;
        }
        frames -= n;
    }
    return true;
}

bool WavWriter::refresh_header() {
    if (failed_ || !file_) {
        return false;
    }
    const std::vector<std::uint8_t> header = build_wav_header(format_, frames_);
    if (!file_->write_at(0, header.data(), header.size())) {
        return fail("header refresh failed: " + file_->last_error());
    }
    return true;
}

bool WavWriter::finalise() {
    if (!file_) {
        return fail("finalise without an open file");
    }
    if (failed_) {
        return false;  // caller must abandon(); a failed file is never renamed to .wav
    }
    if (!refresh_header()) {
        return false;
    }
    if (!file_->flush_to_disk()) {
        return fail("flush to disk failed: " + file_->last_error());
    }
    if (!file_->close()) {
        return fail("close failed: " + file_->last_error());
    }
    file_.reset();
    std::string rename_error;
    if (!rename_no_replace(partial_path_, final_path_, rename_error)) {
        return fail(rename_error);  // the data is intact in the .partial file
    }
    finalised_ = true;
    return true;
}

void WavWriter::abandon() {
    if (!file_) {
        return;
    }
    // Best effort: make the header describe what was written, then close. The file keeps
    // its ".partial" name so it is never mistaken for a finished take.
    const std::vector<std::uint8_t> header = build_wav_header(format_, frames_);
    file_->write_at(0, header.data(), header.size());
    file_->flush_to_disk();
    file_->close();
    file_.reset();
}

}  // namespace rr::audio
