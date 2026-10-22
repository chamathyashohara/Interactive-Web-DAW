#include "rr/audio/WavWriter.h"

#include <utility>
#include <vector>

WavWriter::WavWriter(FileOpener opener) : opener(std::move(opener)) {}

WavWriter::~WavWriter()
{
    if (file)
    {
        abandon();
    }
}

std::filesystem::path WavWriter::partialPathFor(const std::filesystem::path& finalPath)
{
    std::filesystem::path p = finalPath;
    p += ".partial";
    return p;
}

bool WavWriter::fail(const std::string& message)
{
    if (!failed)
    {
        failed = true;
        error = message;
    }
    return false;
}

bool WavWriter::open(const std::filesystem::path& path, const WavFormat& fmt)
{
    if (file)
    {
        return fail("writer already has an open file");
    }
    if (!fmt.valid())
    {
        return fail("unsupported WAV format: " + std::to_string(fmt.channels) + " channels at " +
                    std::to_string(fmt.sampleRate) + " Hz");
    }
    std::error_code ec;
    if (std::filesystem::exists(path, ec))
    {
        return fail("take file already exists, refusing to overwrite: " + pathToUtf8(path));
    }
    format = fmt;
    finalPath = path;
    partialPath = partialPathFor(path);
    frames = 0;
    maxFrames = maxWavFrames(fmt);

    std::string openError;
    file = opener(partialPath, openError);
    if (!file)
    {
        return fail(openError);
    }
    const std::vector<uint8_t> header = buildWavHeader(format, 0);
    if (!file->write(header.data(), header.size()))
    {
        return fail("cannot write WAV header: " + file->lastError());
    }
    return true;
}

bool WavWriter::writeFrames(const float* interleaved, uint64_t frameCount)
{
    if (failed || !file)
    {
        return false;
    }
    if (frames + frameCount > maxFrames)
    {
        sizeLimitReached = true;
        return fail("WAV size limit (4 GiB) reached");
    }
    const auto bytes = static_cast<size_t>(frameCount * format.blockAlign());
    if (!file->write(interleaved, bytes))
    {
        return fail("write failed after " + std::to_string(frames) + " frames: " + file->lastError());
    }
    frames += frameCount;
    return true;
}

bool WavWriter::writeSilence(uint64_t frameCount)
{
    static constexpr uint64_t kChunkFrames = 4096;
    std::vector<float> zeros(static_cast<size_t>(kChunkFrames * format.channels), 0.0f);
    while (frameCount > 0)
    {
        const uint64_t n = frameCount < kChunkFrames ? frameCount : kChunkFrames;
        if (!writeFrames(zeros.data(), n))
        {
            return false;
        }
        frameCount -= n;
    }
    return true;
}

bool WavWriter::refreshHeader()
{
    if (failed || !file)
    {
        return false;
    }
    const std::vector<uint8_t> header = buildWavHeader(format, frames);
    if (!file->writeAt(0, header.data(), header.size()))
    {
        return fail("header refresh failed: " + file->lastError());
    }
    return true;
}

bool WavWriter::finalise()
{
    if (!file)
    {
        return fail("finalise without an open file");
    }
    if (failed)
    {
        return false;  // caller must abandon(); a failed file is never renamed to .wav
    }
    if (!refreshHeader())
    {
        return false;
    }
    if (!file->flushToDisk())
    {
        return fail("flush to disk failed: " + file->lastError());
    }
    if (!file->close())
    {
        return fail("close failed: " + file->lastError());
    }
    file.reset();
    std::string renameError;
    if (!renameNoReplace(partialPath, finalPath, renameError))
    {
        return fail(renameError);  // the data is intact in the .partial file
    }
    finalised = true;
    return true;
}

void WavWriter::abandon()
{
    if (!file)
    {
        return;
    }
    // Best effort: make the header describe what was written, then close. The file keeps
    // its ".partial" name so it is never mistaken for a finished take.
    const std::vector<uint8_t> header = buildWavHeader(format, frames);
    file->writeAt(0, header.data(), header.size());
    file->flushToDisk();
    file->close();
    file.reset();
}

