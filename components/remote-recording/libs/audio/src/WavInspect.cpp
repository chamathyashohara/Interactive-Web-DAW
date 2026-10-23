#include "rr/audio/WavInspect.h"

#include <algorithm>
#include <cstring>
#include <fstream>
#include <system_error>

#include "rr/audio/FileIo.h"
#include "rr/audio/WavFormat.h"
#include "rr/audio/WavWriter.h"

namespace
{

uint16_t u16(const uint8_t* p)
{
    return static_cast<uint16_t>(p[0] | (p[1] << 8));
}

uint32_t u32(const uint8_t* p)
{
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

}  // namespace

WavInfo inspectWav(const std::filesystem::path& path)
{
    WavInfo info;
    std::error_code ec;
    const auto size = std::filesystem::file_size(path, ec);
    std::ifstream in(path, std::ios::binary);
    if (ec || !in)
    {
        info.problems.emplace_back("cannot open file");
        return info;
    }
    info.readable = true;
    info.fileBytes = static_cast<uint64_t>(size);

    uint8_t riff[12];
    if (!in.read(reinterpret_cast<char*>(riff), 12) || std::memcmp(riff, "RIFF", 4) != 0 ||
        std::memcmp(riff + 8, "WAVE", 4) != 0)
        {
        info.problems.emplace_back("not a RIFF/WAVE file");
        return info;
    }
    info.riffWave = true;
    const uint64_t riffSize = u32(riff + 4);

    uint64_t pos = 12;
    while (pos + 8 <= info.fileBytes)
    {
        uint8_t chunk[8];
        in.seekg(static_cast<std::streamoff>(pos));
        if (!in.read(reinterpret_cast<char*>(chunk), 8))
        {
            break;
        }
        const uint32_t chunkSize = u32(chunk + 4);
        if (std::memcmp(chunk, "fmt ", 4) == 0)
        {
            uint8_t fmt[40] = {};
            const uint32_t n = std::min<uint32_t>(chunkSize, 40);
            if (n < 16 || !in.read(reinterpret_cast<char*>(fmt), n))
            {
                info.problems.emplace_back("fmt chunk too short");
                return info;
            }
            info.hasFmt = true;
            info.formatTag = u16(fmt);
            info.channels = u16(fmt + 2);
            info.sampleRate = u32(fmt + 4);
            info.blockAlign = u16(fmt + 12);
            info.bitsPerSample = u16(fmt + 14);
            if (info.formatTag == kWaveFormatIeeeFloat)
            {
                info.isFloat32 = info.bitsPerSample == 32;
            }
            else if (info.formatTag == kWaveFormatExtensible && n >= 40)
            {
                info.isFloat32 = info.bitsPerSample == 32 &&
                                  std::memcmp(fmt + 24, kSubtypeIeeeFloatGuid.data(), 16) == 0;
            }
        }
        else if (std::memcmp(chunk, "fact", 4) == 0 && chunkSize >= 4)
        {
            uint8_t v[4];
            if (in.read(reinterpret_cast<char*>(v), 4))
            {
                info.factFrames = u32(v);
            }
        }
        else if (std::memcmp(chunk, "data", 4) == 0)
        {
            info.hasData = true;
            info.dataOffset = pos + 8;
            info.dataBytesInHeader = chunkSize;
            info.dataBytesInFile = info.fileBytes - info.dataOffset;
            break;  // the data chunk is last in files we write
        }
        pos += 8 + chunkSize + (chunkSize & 1u);
    }

    if (!info.hasFmt)
    {
        info.problems.emplace_back("no fmt chunk");
    }
    if (!info.hasData)
    {
        info.problems.emplace_back("no data chunk");
        return info;
    }
    if (info.blockAlign == 0 || info.channels == 0)
    {
        info.problems.emplace_back("invalid block alignment");
        return info;
    }
    info.frames = info.dataBytesInFile / info.blockAlign;

    const bool dataMatches = info.dataBytesInHeader == info.dataBytesInFile;
    const bool riffMatches = riffSize == info.fileBytes - 8;
    const bool factMatches = info.factFrames == 0 || info.factFrames == info.frames;
    info.headerConsistent = dataMatches && riffMatches && factMatches;
    if (!dataMatches)
    {
        info.problems.emplace_back("data size in header (" + std::to_string(info.dataBytesInHeader) +
                                   " bytes) differs from bytes present (" +
                                   std::to_string(info.dataBytesInFile) + "): not finalised");
    }
    if (!riffMatches)
    {
        info.problems.emplace_back("RIFF size does not match file size");
    }
    if (!factMatches)
    {
        info.problems.emplace_back("fact frame count differs from data");
    }
    if (info.dataBytesInFile % info.blockAlign != 0)
    {
        info.problems.emplace_back("data ends with a partial frame");
    }
    if (!info.isFloat32)
    {
        info.problems.emplace_back("not 32-bit IEEE float (format tag " + std::to_string(info.formatTag) + ")");
    }
    return info;
}

RecoveryResult recoverPartial(const std::filesystem::path& partialPath)
{
    RecoveryResult result;
    const WavInfo info = inspectWav(partialPath);
    if (!info.hasFmt || !info.hasData || !info.isFloat32)
    {
        result.error = "cannot recover: header unreadable or not float32 (" +
                       (info.problems.empty() ? std::string("unknown") : info.problems.front()) + ")";
        return result;
    }
    WavFormat format;
    format.channels = info.channels;
    format.sampleRate = info.sampleRate;

    // "take01_producer_ab12cd34.wav.partial" -> "take01_producer_ab12cd34.recovered.wav"
    std::filesystem::path base = partialPath;
    base.replace_extension();  // drop ".partial"
    base.replace_extension();  // drop ".wav"
    std::filesystem::path target = base;
    target += ".recovered.wav";

    WavWriter writer;
    if (!writer.open(target, format))
    {
        result.error = writer.getError();
        return result;
    }
    std::ifstream in(partialPath, std::ios::binary);
    in.seekg(static_cast<std::streamoff>(info.dataOffset));
    std::vector<float> buffer(static_cast<size_t>(16384) * format.channels);
    uint64_t remaining = info.frames;
    while (remaining > 0 && in)
    {
        const uint64_t n = std::min<uint64_t>(remaining, 16384);
        in.read(reinterpret_cast<char*>(buffer.data()),
                static_cast<std::streamsize>(n * format.blockAlign()));
        const auto got = static_cast<uint64_t>(in.gcount()) / format.blockAlign();
        if (got == 0 || !writer.writeFrames(buffer.data(), got))
        {
            break;
        }
        remaining -= got;
    }
    if (remaining != 0 || !writer.finalise())
    {
        result.error = writer.getError().empty() ? "read error while copying" : writer.getError();
        writer.abandon();
        return result;
    }
    result.ok = true;
    result.recoveredPath = target;
    result.frames = info.frames;
    result.trailingBytesDropped = info.dataBytesInFile % info.blockAlign;
    return result;
}

std::vector<std::filesystem::path> findPartialFiles(const std::filesystem::path& root)
{
    std::vector<std::filesystem::path> found;
    std::error_code ec;
    if (!std::filesystem::exists(root, ec))
    {
        return found;
    }
    for (auto it = std::filesystem::recursive_directory_iterator(
             root, std::filesystem::directory_options::skip_permission_denied, ec);
         !ec && it != std::filesystem::recursive_directory_iterator(); it.increment(ec)) {
        const std::string name = pathToUtf8(it->path().filename());
        const std::string suffix = ".wav.partial";
        if (it->is_regular_file(ec) && name.size() > suffix.size() &&
            name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0)
            {
            found.push_back(it->path());
        }
    }
    std::sort(found.begin(), found.end());
    return found;
}

