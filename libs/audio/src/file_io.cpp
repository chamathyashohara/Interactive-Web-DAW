#include "rr/audio/file_io.hpp"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <system_error>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <io.h>
#include <windows.h>
#endif

namespace rr::audio {
namespace {

#ifdef _WIN32
std::string win32_error_text(DWORD code) {
    char buffer[256] = {};
    const DWORD n = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr,
                                   code, 0, buffer, sizeof buffer, nullptr);
    std::string text(buffer, n);
    while (!text.empty() && (text.back() == '\r' || text.back() == '\n' || text.back() == ' ')) {
        text.pop_back();
    }
    return text + " (Win32 error " + std::to_string(code) + ")";
}
#endif

std::string errno_text(int err) {
    return std::string(std::strerror(err)) + " (errno " + std::to_string(err) + ")";
}

// stdio-based file with a large buffer. Used only from non-real-time threads.
class StdioFile final : public WritableFile {
public:
    explicit StdioFile(std::FILE* f) : file_(f) {
        buffer_.resize(1 << 20);
        std::setvbuf(file_, buffer_.data(), _IOFBF, buffer_.size());
    }
    ~StdioFile() override { close(); }

    bool write(const void* data, std::size_t bytes) override {
        if (!file_) {
            error_ = "file is closed";
            return false;
        }
        if (bytes == 0) {
            return true;
        }
        if (std::fwrite(data, 1, bytes, file_) != bytes) {
            error_ = "write failed: " + errno_text(errno);
            return false;
        }
        return true;
    }

    bool write_at(std::uint64_t offset, const void* data, std::size_t bytes) override {
        if (!file_) {
            error_ = "file is closed";
            return false;
        }
        if (seek(offset, SEEK_SET) != 0) {
            error_ = "seek failed: " + errno_text(errno);
            return false;
        }
        const bool ok = std::fwrite(data, 1, bytes, file_) == bytes;
        if (!ok) {
            error_ = "header write failed: " + errno_text(errno);
        }
        if (seek(0, SEEK_END) != 0 && ok) {
            error_ = "seek to end failed: " + errno_text(errno);
            return false;
        }
        return ok;
    }

    bool flush_to_disk() override {
        if (!file_) {
            return false;
        }
        if (std::fflush(file_) != 0) {
            error_ = "flush failed: " + errno_text(errno);
            return false;
        }
#ifdef _WIN32
        const auto handle = reinterpret_cast<HANDLE>(_get_osfhandle(_fileno(file_)));
        if (handle == INVALID_HANDLE_VALUE || !FlushFileBuffers(handle)) {
            error_ = "FlushFileBuffers failed: " + win32_error_text(GetLastError());
            return false;
        }
#endif
        return true;
    }

    bool close() override {
        if (!file_) {
            return true;
        }
        const bool ok = std::fclose(file_) == 0;
        if (!ok) {
            error_ = "close failed: " + errno_text(errno);
        }
        file_ = nullptr;
        return ok;
    }

    std::string last_error() const override { return error_; }

private:
    int seek(std::uint64_t offset, int origin) {
#ifdef _WIN32
        return _fseeki64(file_, static_cast<long long>(offset), origin);
#else
        return fseeko(file_, static_cast<off_t>(offset), origin);
#endif
    }

    std::FILE* file_ = nullptr;
    std::vector<char> buffer_;
    std::string error_;
};

}  // namespace

FileOpener default_file_opener() {
    return [](const std::filesystem::path& path, std::string& error) -> std::unique_ptr<WritableFile> {
#ifdef _WIN32
        std::FILE* f = _wfopen(path.c_str(), L"wbx");
#else
        std::FILE* f = std::fopen(path.c_str(), "wbx");
#endif
        if (!f) {
            error = "cannot create " + path_to_utf8(path) + ": " + errno_text(errno) +
                    (errno == EEXIST ? " (file already exists; never overwritten)" : "");
            return nullptr;
        }
        return std::make_unique<StdioFile>(f);
    };
}

bool rename_no_replace(const std::filesystem::path& from, const std::filesystem::path& to, std::string& error) {
#ifdef _WIN32
    if (!MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_WRITE_THROUGH)) {
        error = "rename " + path_to_utf8(from) + " -> " + path_to_utf8(to) + " failed: " +
                win32_error_text(GetLastError());
        return false;
    }
    return true;
#else
    std::error_code ec;
    if (std::filesystem::exists(to, ec)) {
        error = "rename target already exists: " + path_to_utf8(to);
        return false;
    }
    std::filesystem::rename(from, to, ec);
    if (ec) {
        error = "rename failed: " + ec.message();
        return false;
    }
    return true;
#endif
}

bool write_text_file_atomically(const std::filesystem::path& path, const std::string& text, std::string& error) {
    std::filesystem::path temp = path;
    temp += ".tmp";
    {
        std::error_code ec;
        std::filesystem::remove(temp, ec);  // leftover from an earlier crash; ours by name
    }
    auto file = default_file_opener()(temp, error);
    if (!file) {
        return false;
    }
    if (!file->write(text.data(), text.size()) || !file->flush_to_disk()) {
        error = file->last_error();
        file->close();
        return false;
    }
    if (!file->close()) {
        error = file->last_error();
        return false;
    }
    return rename_no_replace(temp, path, error);
}

std::uint64_t available_disk_bytes(const std::filesystem::path& dir) noexcept {
    std::error_code ec;
    const std::filesystem::space_info info = std::filesystem::space(dir, ec);
    return ec ? 0 : static_cast<std::uint64_t>(info.available);
}

std::string path_to_utf8(const std::filesystem::path& path) {
#if defined(__cpp_char8_t)
    const auto u8 = path.u8string();
    return std::string(u8.begin(), u8.end());
#else
    return path.u8string();
#endif
}

}  // namespace rr::audio
