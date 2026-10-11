#include "rr/audio/wav_inspect.hpp"

#include <algorithm>
#include <cstring>
#include <fstream>
#include <system_error>

#include "rr/audio/file_io.hpp"
#include "rr/audio/wav_format.hpp"
#include "rr/audio/wav_writer.hpp"

namespace rr::audio {
namespace {

std::uint16_t u16(const std::uint8_t* p) {
    return static_cast<std::uint16_t>(p[0] | (p[1] << 8));
}

std::uint32_t u32(const std::uint8_t* p) {
    return static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8) |
           (static_cast<std::uint32_t>(p[2]) << 16) | (static_cast<std::uint32_t>(p[3]) << 24);
}

}  // namespace

WavInfo inspect_wav(const std::filesystem::path& path) {
    WavInfo info;
    std::error_code ec;
    const auto size = std::filesystem::file_size(path, ec);
    std::ifstream in(path, std::ios::binary);
    if (ec || !in) {
        info.problems.emplace_back("cannot open file");
        return info;
    }
    info.readable = true;
    info.file_bytes = static_cast<std::uint64_t>(size);

    std::uint8_t riff[12];
    if (!in.read(reinterpret_cast<char*>(riff), 12) || std::memcmp(riff, "RIFF", 4) != 0 ||
        std::memcmp(riff + 8, "WAVE", 4) != 0) {
        info.problems.emplace_back("not a RIFF/WAVE file");
        return info;
    }
    info.riff_wave = true;
    const std::uint64_t riff_size = u32(riff + 4);

    std::uint64_t pos = 12;
    while (pos + 8 <= info.file_bytes) {
        std::uint8_t chunk[8];
        in.seekg(static_cast<std::streamoff>(pos));
        if (!in.read(reinterpret_cast<char*>(chunk), 8)) {
            break;
        }
        const std::uint32_t chunk_size = u32(chunk + 4);
        if (std::memcmp(chunk, "fmt ", 4) == 0) {
            std::uint8_t fmt[40] = {};
            const std::uint32_t n = std::min<std::uint32_t>(chunk_size, 40);
            if (n < 16 || !in.read(reinterpret_cast<char*>(fmt), n)) {
                info.problems.emplace_back("fmt chunk too short");
                return info;
            }
            info.has_fmt = true;
            info.format_tag = u16(fmt);
            info.channels = u16(fmt + 2);
            info.sample_rate = u32(fmt + 4);
            info.block_align = u16(fmt + 12);
            info.bits_per_sample = u16(fmt + 14);
            if (info.format_tag == kWaveFormatIeeeFloat) {
                info.is_float32 = info.bits_per_sample == 32;
            } else if (info.format_tag == kWaveFormatExtensible && n >= 40) {
                info.is_float32 = info.bits_per_sample == 32 &&
                                  std::memcmp(fmt + 24, kSubtypeIeeeFloatGuid.data(), 16) == 0;
            }
        } else if (std::memcmp(chunk, "fact", 4) == 0 && chunk_size >= 4) {
            std::uint8_t v[4];
            if (in.read(reinterpret_cast<char*>(v), 4)) {
                info.fact_frames = u32(v);
            }
        } else if (std::memcmp(chunk, "data", 4) == 0) {
            info.has_data = true;
            info.data_offset = pos + 8;
            info.data_bytes_in_header = chunk_size;
            info.data_bytes_in_file = info.file_bytes - info.data_offset;
            break;  // the data chunk is last in files we write
        }
        pos += 8 + chunk_size + (chunk_size & 1u);
    }

    if (!info.has_fmt) {
        info.problems.emplace_back("no fmt chunk");
    }
    if (!info.has_data) {
        info.problems.emplace_back("no data chunk");
        return info;
    }
    if (info.block_align == 0 || info.channels == 0) {
        info.problems.emplace_back("invalid block alignment");
        return info;
    }
    info.frames = info.data_bytes_in_file / info.block_align;

    const bool data_matches = info.data_bytes_in_header == info.data_bytes_in_file;
    const bool riff_matches = riff_size == info.file_bytes - 8;
    const bool fact_matches = info.fact_frames == 0 || info.fact_frames == info.frames;
    info.header_consistent = data_matches && riff_matches && fact_matches;
    if (!data_matches) {
        info.problems.emplace_back("data size in header (" + std::to_string(info.data_bytes_in_header) +
                                   " bytes) differs from bytes present (" +
                                   std::to_string(info.data_bytes_in_file) + "): not finalised");
    }
    if (!riff_matches) {
        info.problems.emplace_back("RIFF size does not match file size");
    }
    if (!fact_matches) {
        info.problems.emplace_back("fact frame count differs from data");
    }
    if (info.data_bytes_in_file % info.block_align != 0) {
        info.problems.emplace_back("data ends with a partial frame");
    }
    if (!info.is_float32) {
        info.problems.emplace_back("not 32-bit IEEE float (format tag " + std::to_string(info.format_tag) + ")");
    }
    return info;
}

RecoveryResult recover_partial(const std::filesystem::path& partial_path) {
    RecoveryResult result;
    const WavInfo info = inspect_wav(partial_path);
    if (!info.has_fmt || !info.has_data || !info.is_float32) {
        result.error = "cannot recover: header unreadable or not float32 (" +
                       (info.problems.empty() ? std::string("unknown") : info.problems.front()) + ")";
        return result;
    }
    WavFormat format;
    format.channels = info.channels;
    format.sample_rate = info.sample_rate;

    // "take01_producer_ab12cd34.wav.partial" -> "take01_producer_ab12cd34.recovered.wav"
    std::filesystem::path base = partial_path;
    base.replace_extension();  // drop ".partial"
    base.replace_extension();  // drop ".wav"
    std::filesystem::path target = base;
    target += ".recovered.wav";

    WavWriter writer;
    if (!writer.open(target, format)) {
        result.error = writer.error();
        return result;
    }
    std::ifstream in(partial_path, std::ios::binary);
    in.seekg(static_cast<std::streamoff>(info.data_offset));
    std::vector<float> buffer(static_cast<std::size_t>(16384) * format.channels);
    std::uint64_t remaining = info.frames;
    while (remaining > 0 && in) {
        const std::uint64_t n = std::min<std::uint64_t>(remaining, 16384);
        in.read(reinterpret_cast<char*>(buffer.data()),
                static_cast<std::streamsize>(n * format.block_align()));
        const auto got = static_cast<std::uint64_t>(in.gcount()) / format.block_align();
        if (got == 0 || !writer.write_frames(buffer.data(), got)) {
            break;
        }
        remaining -= got;
    }
    if (remaining != 0 || !writer.finalise()) {
        result.error = writer.error().empty() ? "read error while copying" : writer.error();
        writer.abandon();
        return result;
    }
    result.ok = true;
    result.recovered_path = target;
    result.frames = info.frames;
    result.trailing_bytes_dropped = info.data_bytes_in_file % info.block_align;
    return result;
}

std::vector<std::filesystem::path> find_partial_files(const std::filesystem::path& root) {
    std::vector<std::filesystem::path> found;
    std::error_code ec;
    if (!std::filesystem::exists(root, ec)) {
        return found;
    }
    for (auto it = std::filesystem::recursive_directory_iterator(
             root, std::filesystem::directory_options::skip_permission_denied, ec);
         !ec && it != std::filesystem::recursive_directory_iterator(); it.increment(ec)) {
        const std::string name = path_to_utf8(it->path().filename());
        const std::string suffix = ".wav.partial";
        if (it->is_regular_file(ec) && name.size() > suffix.size() &&
            name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0) {
            found.push_back(it->path());
        }
    }
    std::sort(found.begin(), found.end());
    return found;
}

}  // namespace rr::audio
