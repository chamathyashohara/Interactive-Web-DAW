#include "rr/audio/FileIo.h"

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
#include <share.h>
#include <windows.h>
#endif

namespace
{

#ifdef _WIN32
std::string win32ErrorText(DWORD code)
{
    char buffer[256] = {};
    const DWORD n = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr,
                                   code, 0, buffer, sizeof buffer, nullptr);
    std::string text(buffer, n);
    while (!text.empty() && (text.back() == '\r' || text.back() == '\n' || text.back() == ' '))
    {
        text.pop_back();
    }
    return text + " (Win32 error " + std::to_string(code) + ")";
}
#endif

std::string errnoText(int err)
{
    char text[256] = {};
#ifdef _WIN32
    strerror_s(text, sizeof text, err);
#else
    std::strncpy(text, std::strerror(err), sizeof text - 1);
#endif
    return std::string(text) + " (errno " + std::to_string(err) + ")";
}

// stdio-based file with a large buffer. Used only from non-real-time threads.
class StdioFile final : public WritableFile
{
public:
    explicit StdioFile(std::FILE* f) : file(f)
    {
        buffer.resize(1 << 20);
        std::setvbuf(file, buffer.data(), _IOFBF, buffer.size());
    }
    ~StdioFile() override { close(); }

    bool write(const void* data, size_t bytes) override
    {
        if (!file)
        {
            error = "file is closed";
            return false;
        }
        if (bytes == 0)
        {
            return true;
        }
        if (std::fwrite(data, 1, bytes, file) != bytes)
        {
            error = "write failed: " + errnoText(errno);
            return false;
        }
        return true;
    }

    bool writeAt(uint64_t offset, const void* data, size_t bytes) override
    {
        if (!file)
        {
            error = "file is closed";
            return false;
        }
        if (seek(offset, SEEK_SET) != 0)
        {
            error = "seek failed: " + errnoText(errno);
            return false;
        }
        const bool ok = std::fwrite(data, 1, bytes, file) == bytes;
        if (!ok)
        {
            error = "header write failed: " + errnoText(errno);
        }
        if (seek(0, SEEK_END) != 0 && ok)
        {
            error = "seek to end failed: " + errnoText(errno);
            return false;
        }
        return ok;
    }

    bool flushToDisk() override
    {
        if (!file)
        {
            return false;
        }
        if (std::fflush(file) != 0)
        {
            error = "flush failed: " + errnoText(errno);
            return false;
        }
#ifdef _WIN32
        const auto handle = reinterpret_cast<HANDLE>(_get_osfhandle(_fileno(file)));
        if (handle == INVALID_HANDLE_VALUE || !FlushFileBuffers(handle))
        {
            error = "FlushFileBuffers failed: " + win32ErrorText(GetLastError());
            return false;
        }
#endif
        return true;
    }

    bool close() override
    {
        if (!file)
        {
            return true;
        }
        const bool ok = std::fclose(file) == 0;
        if (!ok)
        {
            error = "close failed: " + errnoText(errno);
        }
        file = nullptr;
        return ok;
    }

    std::string lastError() const override { return error; }

private:
    int seek(uint64_t offset, int origin)
    {
#ifdef _WIN32
        return _fseeki64(file, static_cast<long long>(offset), origin);
#else
        return fseeko(file, static_cast<off_t>(offset), origin);
#endif
    }

    std::FILE* file = nullptr;
    std::vector<char> buffer;
    std::string error;
};

}  // namespace

FileOpener defaultFileOpener()
{
    return [](const std::filesystem::path& path, std::string& error) -> std::unique_ptr<WritableFile> {
#ifdef _WIN32
        std::FILE* f = _wfsopen(path.c_str(), L"wbx", _SH_DENYNO);  // same sharing as _wfopen
#else
        std::FILE* f = std::fopen(path.c_str(), "wbx");
#endif
        if (!f)
        {
            error = "cannot create " + pathToUtf8(path) + ": " + errnoText(errno) +
                    (errno == EEXIST ? " (file already exists; never overwritten)" : "");
            return nullptr;
        }
        return std::make_unique<StdioFile>(f);
    };
}

bool renameNoReplace(const std::filesystem::path& from, const std::filesystem::path& to, std::string& error)
{
#ifdef _WIN32
    if (!MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_WRITE_THROUGH))
    {
        error = "rename " + pathToUtf8(from) + " -> " + pathToUtf8(to) + " failed: " +
                win32ErrorText(GetLastError());
        return false;
    }
    return true;
#else
    std::error_code ec;
    if (std::filesystem::exists(to, ec))
    {
        error = "rename target already exists: " + pathToUtf8(to);
        return false;
    }
    std::filesystem::rename(from, to, ec);
    if (ec)
    {
        error = "rename failed: " + ec.message();
        return false;
    }
    return true;
#endif
}

bool writeTextFileAtomically(const std::filesystem::path& path, const std::string& text, std::string& error)
{
    std::filesystem::path temp = path;
    temp += ".tmp";
    {
        std::error_code ec;
        std::filesystem::remove(temp, ec);  // leftover from an earlier crash; ours by name
    }
    auto file = defaultFileOpener()(temp, error);
    if (!file)
    {
        return false;
    }
    if (!file->write(text.data(), text.size()) || !file->flushToDisk())
    {
        error = file->lastError();
        file->close();
        return false;
    }
    if (!file->close())
    {
        error = file->lastError();
        return false;
    }
    return renameNoReplace(temp, path, error);
}

uint64_t availableDiskBytes(const std::filesystem::path& dir) noexcept
{
    std::error_code ec;
    const std::filesystem::space_info info = std::filesystem::space(dir, ec);
    return ec ? 0 : static_cast<uint64_t>(info.available);
}

std::string pathToUtf8(const std::filesystem::path& path)
{
#if defined(__cpp_char8_t)
    const auto u8 = path.u8string();
    return std::string(u8.begin(), u8.end());
#else
    return path.u8string();
#endif
}

