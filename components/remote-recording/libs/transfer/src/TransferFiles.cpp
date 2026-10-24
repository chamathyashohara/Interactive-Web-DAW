#include "rr/transfer/TransferFiles.h"

#include <cerrno>
#include <cstring>
#include <fstream>
#include <sstream>
#include <system_error>

#include "rr/audio/TakeNaming.h"

#ifdef _WIN32
#include <io.h>
#include <share.h>
#else
#include <unistd.h>
#endif

namespace
{

std::string errnoText(const char* what)
{
    const int err = errno;
    char text[256] = {};
#ifdef _WIN32
    strerror_s(text, sizeof text, err);
#else
    std::strncpy(text, std::strerror(err), sizeof text - 1);
#endif
    return std::string(what) + ": " + text;
}

bool seek(std::FILE* f, uint64_t offset)
{
#ifdef _WIN32
    return _fseeki64(f, static_cast<__int64>(offset), SEEK_SET) == 0;
#else
    return fseeko(f, static_cast<off_t>(offset), SEEK_SET) == 0;
#endif
}

bool isHex8(const std::string& s)
{
    if (s.size() != 8)
    {
        return false;
    }
    for (const char c : s)
    {
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
        {
            return false;
        }
    }
    return true;
}

}  // namespace

// ---------------------------------------------------------------------------------------------
ReadOnlyFile::~ReadOnlyFile()
{
    close();
}

bool ReadOnlyFile::open(const std::filesystem::path& path, std::string& error)
{
    close();
#ifdef _WIN32
    // _SH_DENYWR: others may read, nobody may write while we hold it (the recorder has finished).
    f = _wfsopen(path.c_str(), L"rb", _SH_DENYWR);
#else
    f = std::fopen(path.c_str(), "rb");
#endif
    if (f == nullptr)
    {
        error = errnoText("cannot open the take read-only");
        return false;
    }
    std::error_code ec;
    size = std::filesystem::file_size(path, ec);
    if (ec)
    {
        error = "cannot read the file size: " + ec.message();
        close();
        return false;
    }
    return true;
}

bool ReadOnlyFile::readAt(uint64_t offset, void* buffer, size_t count, size_t& got, std::string& error)
{
    got = 0;
    if (f == nullptr)
    {
        error = "file not open";
        return false;
    }
    if (offset >= size)
    {
        return true;
    }
    if (!seek(f, offset))
    {
        error = errnoText("seek failed");
        return false;
    }
    got = std::fread(buffer, 1, count, f);
    if (got < count && std::ferror(f))
    {
        error = errnoText("read failed");
        return false;
    }
    return true;
}

void ReadOnlyFile::close() noexcept
{
    if (f != nullptr)
    {
        std::fclose(f);
        f = nullptr;
    }
}

// ---------------------------------------------------------------------------------------------
PartialFile::~PartialFile()
{
    close();
}

bool PartialFile::open(const std::filesystem::path& path, uint64_t keepBytes, std::string& error)
{
    close();
    std::error_code ec;
    const bool exists = std::filesystem::exists(path, ec);
    if (exists)
    {
        const uint64_t have = std::filesystem::file_size(path, ec);
        if (ec)
        {
            error = "cannot read the partial file size: " + ec.message();
            return false;
        }
        if (have != keepBytes)
        {
            std::filesystem::resize_file(path, keepBytes < have ? keepBytes : have, ec);
            if (ec)
            {
                error = "cannot cut back the partial file: " + ec.message();
                return false;
            }
        }
#ifdef _WIN32
        f = _wfsopen(path.c_str(), L"r+b", _SH_DENYWR);
#else
        f = std::fopen(path.c_str(), "r+b");
#endif
    }
    else
    {
#ifdef _WIN32
        f = _wfsopen(path.c_str(), L"wbx", _SH_DENYWR);  // never replaces an existing file
#else
        f = std::fopen(path.c_str(), "wbx");
#endif
    }
    if (f == nullptr)
    {
        error = errnoText("cannot open the partial file");
        return false;
    }
    return true;
}

bool PartialFile::writeAt(uint64_t offset, const void* data, size_t size, std::string& error)
{
    if (f == nullptr)
    {
        error = "partial file not open";
        return false;
    }
    if (!seek(f, offset) || std::fwrite(data, 1, size, f) != size)
    {
        error = errnoText("write failed");
        return false;
    }
    return true;
}

bool PartialFile::flushToDisk(std::string& error)
{
    if (f == nullptr)
    {
        return true;
    }
    if (std::fflush(f) != 0)
    {
        error = errnoText("flush failed");
        return false;
    }
#ifdef _WIN32
    if (_commit(_fileno(f)) != 0)
    {
#else
    if (fsync(fileno(f)) != 0)
    {
#endif
        error = errnoText("commit to disk failed");
        return false;
    }
    return true;
}

void PartialFile::close() noexcept
{
    if (f != nullptr)
    {
        std::fclose(f);
        f = nullptr;
    }
}

// ---------------------------------------------------------------------------------------------
bool makeReceivePaths(const std::filesystem::path& dir, const std::string& sessionId, uint32_t takeId,
                        ReceivePaths& out, std::string& error)
                        {
    if (!isHex8(sessionId))
    {
        error = "invalid session id";
        return false;
    }
    if (takeId < 1 || takeId > 999)
    {
        error = "take id outside 1..999";
        return false;
    }
    if (dir.empty())
    {
        error = "no folder for received takes";
        return false;
    }
    out.dir = dir;
    const std::string stem = takeStem(takeId, Role::Performer, sessionId);
    out.finalWav = dir / (stem + ".wav");
    out.partial = dir / (stem + ".wav.xfer.partial");
    out.journal = dir / (stem + ".wav.xfer.journal");
    out.record = dir / (stem + ".wav.transfer.json");
    for (const auto* p : {&out.finalWav, &out.partial, &out.journal, &out.record})
    {
        if (!pathIsInside(dir, *p))
        {
            error = "internal: received-take path escapes its folder";
            return false;
        }
    }
    return true;
}

bool pathIsInside(const std::filesystem::path& dir, const std::filesystem::path& p)
{
    const std::filesystem::path d = dir.lexically_normal();
    const std::filesystem::path n = p.lexically_normal();
    const std::filesystem::path rel = n.lexically_relative(d);
    if (rel.empty() || rel.is_absolute())
    {
        return false;
    }
    for (const auto& part : rel)
    {
        if (part == "..")
        {
            return false;
        }
    }
    return rel != std::filesystem::path(".");  // the folder itself is not "inside" it
}

std::string displaySafeName(const std::string& untrusted)
{
    // Last component only: everything after the final '/' or '\'.
    size_t start = untrusted.find_last_of("/\\");
    start = start == std::string::npos ? 0 : start + 1;
    std::string out;
    for (size_t i = start; i < untrusted.size() && out.size() < 80; ++i)
    {
        const char c = untrusted[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')
        {
            out.push_back(c);
        }
        else
        {
            out.push_back('_');
        }
    }
    while (!out.empty() && out.front() == '.')
    {
        out.front() = '_';  // no ".", "..", or hidden names
    }
    return out.empty() ? std::string("(unnamed)") : out;
}

// ---------------------------------------------------------------------------------------------
std::string journalText(const Journal& j)
{
    std::ostringstream o;
    o << "rr-transfer-journal 1\n"
      << "session " << j.sessionId << "\n"
      << "take " << j.takeId << "\n"
      << "bytes " << j.fileBytes << "\n"
      << "sha256 " << j.sha256Hex << "\n"
      << "chunk_bytes " << j.chunkBytes << "\n"
      << "chunks_done " << j.chunksDone << "\n"
      << "end\n";
    return o.str();
}

std::optional<Journal> parseJournal(const std::string& text)
{
    std::istringstream in(text);
    std::string key;
    Journal j;
    std::string magic;
    int version = 0;
    if (!(in >> magic >> version) || magic != "rr-transfer-journal" || version != 1)
    {
        return std::nullopt;
    }
    if (!(in >> key >> j.sessionId) || key != "session" || !isHex8(j.sessionId)) return std::nullopt;
    if (!(in >> key >> j.takeId) || key != "take") return std::nullopt;
    if (!(in >> key >> j.fileBytes) || key != "bytes") return std::nullopt;
    if (!(in >> key >> j.sha256Hex) || key != "sha256" || j.sha256Hex.size() != 64) return std::nullopt;
    if (!(in >> key >> j.chunkBytes) || key != "chunk_bytes" || j.chunkBytes == 0) return std::nullopt;
    if (!(in >> key >> j.chunksDone) || key != "chunks_done") return std::nullopt;
    if (!(in >> key) || key != "end") return std::nullopt;
    return j;
}

bool writeJournal(const std::filesystem::path& path, const Journal& j, std::string& error)
{
    // Overwritten in place: a torn write fails parseJournal(), which means "start again" (safe).
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out << journalText(j);
    out.flush();
    if (!out)
    {
        error = "cannot write the transfer journal";
        return false;
    }
    return true;
}

std::optional<Journal> readJournal(const std::filesystem::path& path)
{
    std::ifstream in(path, std::ios::binary);
    if (!in)
    {
        return std::nullopt;
    }
    std::ostringstream s;
    s << in.rdbuf();
    if (s.str().size() > 4096)
    {
        return std::nullopt;
    }
    return parseJournal(s.str());
}

