#pragma once

// Helpers for the audio tests.
//
// TEST SIGNAL - NOT A MICROPHONE. These tests feed a synthetic counter signal into
// CaptureIngest::onBlock(), the same entry point the real miniaudio capture callback uses.
// They test the recording pipeline's logic, not audio hardware. Real-device validation is the
// manual protocol in docs/testing/AUDIO_DEVICE_TEST_PROTOCOL.md.

#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include "rr/audio/CaptureIngest.h"
#include "rr/audio/FileIo.h"
#include "rr/audio/TakeNaming.h"
#include "rr/audio/WavInspect.h"
#include "rr/shared/Clock.h"

/** A fresh, empty folder under the system temp directory. */
inline std::filesystem::path freshTempDir(const std::string& label)
{
    const auto dir = std::filesystem::temp_directory_path() / "rr_tests" / (label + "_" + makeSessionId());
    std::filesystem::remove_all(dir);
    std::filesystem::create_directories(dir);
    return dir;
}

/**
 * Value of frame `index` in the counter signal: a sawtooth with a distinct value per channel,
 * never exactly 0, so inserted silence is distinguishable from signal.
 */
inline float counterSample(uint64_t index, uint32_t channel)
{
    return 0.001f + static_cast<float>(index % 997) / 1000.0f + static_cast<float>(channel) * 0.0001f;
}

/**
 * Feeds `blocks` blocks of `framesPerBlock` frames of the counter signal, starting at
 * signal frame `firstIndex`. Returns the next signal index.
 */
inline uint64_t feedCounter(CaptureIngest& ingest, uint64_t firstIndex, uint32_t blocks,
                                  uint32_t framesPerBlock)
                                  {
    const uint32_t ch = ingest.getChannels();
    std::vector<float> block(static_cast<size_t>(framesPerBlock) * ch);
    uint64_t index = firstIndex;
    for (uint32_t b = 0; b < blocks; ++b)
    {
        for (uint32_t f = 0; f < framesPerBlock; ++f)
        {
            for (uint32_t c = 0; c < ch; ++c)
            {
                block[static_cast<size_t>(f) * ch + c] = counterSample(index, c);
            }
            ++index;
        }
        ingest.onBlock(block.data(), framesPerBlock, monotonicNs());
    }
    return index;
}

/** Reads all float samples of a WAV written by WavWriter. */
inline std::vector<float> readWavSamples(const std::filesystem::path& path)
{
    const WavInfo info = inspectWav(path);
    std::vector<float> samples(static_cast<size_t>(info.frames) * info.channels);
    std::ifstream in(path, std::ios::binary);
    in.seekg(static_cast<std::streamoff>(info.dataOffset));
    in.read(reinterpret_cast<char*>(samples.data()), static_cast<std::streamsize>(samples.size() * sizeof(float)));
    return samples;
}

/**
 * In-memory file that fails once more than `limit` bytes have been appended
 * (simulated "disk full").
 */
class FailingFile final : public WritableFile
{
public:
    explicit FailingFile(size_t limit) : limit(limit) {}
    bool write(const void* data, size_t count) override
    {
        if (bytes.size() + count > limit)
        {
            error = "simulated disk full";
            return false;
        }
        const auto* p = static_cast<const uint8_t*>(data);
        bytes.insert(bytes.end(), p, p + count);
        return true;
    }
    bool writeAt(uint64_t offset, const void* data, size_t count) override
    {
        if (offset + count > bytes.size())
        {
            return false;
        }
        std::memcpy(bytes.data() + offset, data, count);
        return true;
    }
    bool flushToDisk() override { return true; }
    bool close() override { return true; }
    std::string lastError() const override { return error; }

private:
    size_t limit;
    std::vector<uint8_t> bytes;
    std::string error;
};

inline FileOpener failingOpener(size_t limit)
{
    return [limit](const std::filesystem::path&, std::string&) -> std::unique_ptr<WritableFile> {
        return std::make_unique<FailingFile>(limit);
    };
}

