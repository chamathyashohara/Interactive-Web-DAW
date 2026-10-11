#pragma once

// Helpers for the audio tests.
//
// TEST SIGNAL - NOT A MICROPHONE. These tests feed a synthetic counter signal into
// CaptureIngest::on_block(), the same entry point the real miniaudio capture callback uses.
// They test the recording pipeline's logic, not audio hardware. Real-device validation is the
// manual protocol in docs/testing/AUDIO_DEVICE_TEST_PROTOCOL.md.

#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include "rr/audio/capture_ingest.hpp"
#include "rr/audio/file_io.hpp"
#include "rr/audio/take_naming.hpp"
#include "rr/audio/wav_inspect.hpp"
#include "rr/shared/clock.hpp"

namespace rr::test {

// A fresh, empty folder under the system temp directory.
inline std::filesystem::path fresh_temp_dir(const std::string& label) {
    const auto dir = std::filesystem::temp_directory_path() / "rr_tests" / (label + "_" + audio::make_session_id());
    std::filesystem::remove_all(dir);
    std::filesystem::create_directories(dir);
    return dir;
}

// Value of frame `index` in the counter signal: a sawtooth with a distinct value per channel,
// never exactly 0, so inserted silence is distinguishable from signal.
inline float counter_sample(std::uint64_t index, std::uint32_t channel) {
    return 0.001f + static_cast<float>(index % 997) / 1000.0f + static_cast<float>(channel) * 0.0001f;
}

// Feeds `blocks` blocks of `frames_per_block` frames of the counter signal, starting at
// signal frame `first_index`. Returns the next signal index.
inline std::uint64_t feed_counter(audio::CaptureIngest& ingest, std::uint64_t first_index, std::uint32_t blocks,
                                  std::uint32_t frames_per_block) {
    const std::uint32_t ch = ingest.channels();
    std::vector<float> block(static_cast<std::size_t>(frames_per_block) * ch);
    std::uint64_t index = first_index;
    for (std::uint32_t b = 0; b < blocks; ++b) {
        for (std::uint32_t f = 0; f < frames_per_block; ++f) {
            for (std::uint32_t c = 0; c < ch; ++c) {
                block[static_cast<std::size_t>(f) * ch + c] = counter_sample(index, c);
            }
            ++index;
        }
        ingest.on_block(block.data(), frames_per_block, time::monotonic_ns());
    }
    return index;
}

// Reads all float samples of a WAV written by WavWriter.
inline std::vector<float> read_wav_samples(const std::filesystem::path& path) {
    const audio::WavInfo info = audio::inspect_wav(path);
    std::vector<float> samples(static_cast<std::size_t>(info.frames) * info.channels);
    std::ifstream in(path, std::ios::binary);
    in.seekg(static_cast<std::streamoff>(info.data_offset));
    in.read(reinterpret_cast<char*>(samples.data()), static_cast<std::streamsize>(samples.size() * sizeof(float)));
    return samples;
}

// In-memory file that fails once more than `limit` bytes have been appended
// (simulated "disk full").
class FailingFile final : public audio::WritableFile {
public:
    explicit FailingFile(std::size_t limit) : limit_(limit) {}
    bool write(const void* data, std::size_t bytes) override {
        if (bytes_.size() + bytes > limit_) {
            error_ = "simulated disk full";
            return false;
        }
        const auto* p = static_cast<const std::uint8_t*>(data);
        bytes_.insert(bytes_.end(), p, p + bytes);
        return true;
    }
    bool write_at(std::uint64_t offset, const void* data, std::size_t bytes) override {
        if (offset + bytes > bytes_.size()) {
            return false;
        }
        std::memcpy(bytes_.data() + offset, data, bytes);
        return true;
    }
    bool flush_to_disk() override { return true; }
    bool close() override { return true; }
    std::string last_error() const override { return error_; }

private:
    std::size_t limit_;
    std::vector<std::uint8_t> bytes_;
    std::string error_;
};

inline audio::FileOpener failing_opener(std::size_t limit) {
    return [limit](const std::filesystem::path&, std::string&) -> std::unique_ptr<audio::WritableFile> {
        return std::make_unique<FailingFile>(limit);
    };
}

}  // namespace rr::test
