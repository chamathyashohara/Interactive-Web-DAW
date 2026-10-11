#include "rr/transfer/transfer_files.hpp"

#include <cerrno>
#include <cstring>
#include <fstream>
#include <sstream>
#include <system_error>

#include "rr/audio/take_naming.hpp"

#ifdef _WIN32
#include <io.h>
#include <share.h>
#else
#include <unistd.h>
#endif

namespace rr::xfer {
namespace {

std::string errno_text(const char* what) {
    const int err = errno;
    char text[256] = {};
#ifdef _WIN32
    strerror_s(text, sizeof text, err);
#else
    std::strncpy(text, std::strerror(err), sizeof text - 1);
#endif
    return std::string(what) + ": " + text;
}

bool seek(std::FILE* f, std::uint64_t offset) {
#ifdef _WIN32
    return _fseeki64(f, static_cast<__int64>(offset), SEEK_SET) == 0;
#else
    return fseeko(f, static_cast<off_t>(offset), SEEK_SET) == 0;
#endif
}

bool is_hex8(const std::string& s) {
    if (s.size() != 8) {
        return false;
    }
    for (const char c : s) {
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
            return false;
        }
    }
    return true;
}

}  // namespace

// ---------------------------------------------------------------------------------------------
ReadOnlyFile::~ReadOnlyFile() {
    close();
}

bool ReadOnlyFile::open(const std::filesystem::path& path, std::string& error) {
    close();
#ifdef _WIN32
    // _SH_DENYWR: others may read, nobody may write while we hold it (the recorder has finished).
    f_ = _wfsopen(path.c_str(), L"rb", _SH_DENYWR);
#else
    f_ = std::fopen(path.c_str(), "rb");
#endif
    if (f_ == nullptr) {
        error = errno_text("cannot open the take read-only");
        return false;
    }
    std::error_code ec;
    size_ = std::filesystem::file_size(path, ec);
    if (ec) {
        error = "cannot read the file size: " + ec.message();
        close();
        return false;
    }
    return true;
}

bool ReadOnlyFile::read_at(std::uint64_t offset, void* buffer, std::size_t size, std::size_t& got, std::string& error) {
    got = 0;
    if (f_ == nullptr) {
        error = "file not open";
        return false;
    }
    if (offset >= size_) {
        return true;
    }
    if (!seek(f_, offset)) {
        error = errno_text("seek failed");
        return false;
    }
    got = std::fread(buffer, 1, size, f_);
    if (got < size && std::ferror(f_)) {
        error = errno_text("read failed");
        return false;
    }
    return true;
}

void ReadOnlyFile::close() noexcept {
    if (f_ != nullptr) {
        std::fclose(f_);
        f_ = nullptr;
    }
}

// ---------------------------------------------------------------------------------------------
PartialFile::~PartialFile() {
    close();
}

bool PartialFile::open(const std::filesystem::path& path, std::uint64_t keep_bytes, std::string& error) {
    close();
    std::error_code ec;
    const bool exists = std::filesystem::exists(path, ec);
    if (exists) {
        const std::uint64_t have = std::filesystem::file_size(path, ec);
        if (ec) {
            error = "cannot read the partial file size: " + ec.message();
            return false;
        }
        if (have != keep_bytes) {
            std::filesystem::resize_file(path, keep_bytes < have ? keep_bytes : have, ec);
            if (ec) {
                error = "cannot cut back the partial file: " + ec.message();
                return false;
            }
        }
#ifdef _WIN32
        f_ = _wfsopen(path.c_str(), L"r+b", _SH_DENYWR);
#else
        f_ = std::fopen(path.c_str(), "r+b");
#endif
    } else {
#ifdef _WIN32
        f_ = _wfsopen(path.c_str(), L"wbx", _SH_DENYWR);  // never replaces an existing file
#else
        f_ = std::fopen(path.c_str(), "wbx");
#endif
    }
    if (f_ == nullptr) {
        error = errno_text("cannot open the partial file");
        return false;
    }
    return true;
}

bool PartialFile::write_at(std::uint64_t offset, const void* data, std::size_t size, std::string& error) {
    if (f_ == nullptr) {
        error = "partial file not open";
        return false;
    }
    if (!seek(f_, offset) || std::fwrite(data, 1, size, f_) != size) {
        error = errno_text("write failed");
        return false;
    }
    return true;
}

bool PartialFile::flush_to_disk(std::string& error) {
    if (f_ == nullptr) {
        return true;
    }
    if (std::fflush(f_) != 0) {
        error = errno_text("flush failed");
        return false;
    }
#ifdef _WIN32
    if (_commit(_fileno(f_)) != 0) {
#else
    if (fsync(fileno(f_)) != 0) {
#endif
        error = errno_text("commit to disk failed");
        return false;
    }
    return true;
}

void PartialFile::close() noexcept {
    if (f_ != nullptr) {
        std::fclose(f_);
        f_ = nullptr;
    }
}

// ---------------------------------------------------------------------------------------------
bool make_receive_paths(const std::filesystem::path& dir, const std::string& session_id, std::uint32_t take_id,
                        ReceivePaths& out, std::string& error) {
    if (!is_hex8(session_id)) {
        error = "invalid session id";
        return false;
    }
    if (take_id < 1 || take_id > 999) {
        error = "take id outside 1..999";
        return false;
    }
    if (dir.empty()) {
        error = "no folder for received takes";
        return false;
    }
    out.dir = dir;
    const std::string stem = audio::take_stem(take_id, Role::Performer, session_id);
    out.final_wav = dir / (stem + ".wav");
    out.partial = dir / (stem + ".wav.xfer.partial");
    out.journal = dir / (stem + ".wav.xfer.journal");
    out.record = dir / (stem + ".wav.transfer.json");
    for (const auto* p : {&out.final_wav, &out.partial, &out.journal, &out.record}) {
        if (!path_is_inside(dir, *p)) {
            error = "internal: received-take path escapes its folder";
            return false;
        }
    }
    return true;
}

bool path_is_inside(const std::filesystem::path& dir, const std::filesystem::path& p) {
    const std::filesystem::path d = dir.lexically_normal();
    const std::filesystem::path n = p.lexically_normal();
    const std::filesystem::path rel = n.lexically_relative(d);
    if (rel.empty() || rel.is_absolute()) {
        return false;
    }
    for (const auto& part : rel) {
        if (part == "..") {
            return false;
        }
    }
    return rel != std::filesystem::path(".");  // the folder itself is not "inside" it
}

std::string display_safe_name(const std::string& untrusted) {
    // Last component only: everything after the final '/' or '\'.
    std::size_t start = untrusted.find_last_of("/\\");
    start = start == std::string::npos ? 0 : start + 1;
    std::string out;
    for (std::size_t i = start; i < untrusted.size() && out.size() < 80; ++i) {
        const char c = untrusted[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-') {
            out.push_back(c);
        } else {
            out.push_back('_');
        }
    }
    while (!out.empty() && out.front() == '.') {
        out.front() = '_';  // no ".", "..", or hidden names
    }
    return out.empty() ? std::string("(unnamed)") : out;
}

// ---------------------------------------------------------------------------------------------
std::string journal_text(const Journal& j) {
    std::ostringstream o;
    o << "rr-transfer-journal 1\n"
      << "session " << j.session_id << "\n"
      << "take " << j.take_id << "\n"
      << "bytes " << j.file_bytes << "\n"
      << "sha256 " << j.sha256_hex << "\n"
      << "chunk_bytes " << j.chunk_bytes << "\n"
      << "chunks_done " << j.chunks_done << "\n"
      << "end\n";
    return o.str();
}

std::optional<Journal> parse_journal(const std::string& text) {
    std::istringstream in(text);
    std::string key;
    Journal j;
    std::string magic;
    int version = 0;
    if (!(in >> magic >> version) || magic != "rr-transfer-journal" || version != 1) {
        return std::nullopt;
    }
    if (!(in >> key >> j.session_id) || key != "session" || !is_hex8(j.session_id)) return std::nullopt;
    if (!(in >> key >> j.take_id) || key != "take") return std::nullopt;
    if (!(in >> key >> j.file_bytes) || key != "bytes") return std::nullopt;
    if (!(in >> key >> j.sha256_hex) || key != "sha256" || j.sha256_hex.size() != 64) return std::nullopt;
    if (!(in >> key >> j.chunk_bytes) || key != "chunk_bytes" || j.chunk_bytes == 0) return std::nullopt;
    if (!(in >> key >> j.chunks_done) || key != "chunks_done") return std::nullopt;
    if (!(in >> key) || key != "end") return std::nullopt;
    return j;
}

bool write_journal(const std::filesystem::path& path, const Journal& j, std::string& error) {
    // Overwritten in place: a torn write fails parse_journal(), which means "start again" (safe).
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out << journal_text(j);
    out.flush();
    if (!out) {
        error = "cannot write the transfer journal";
        return false;
    }
    return true;
}

std::optional<Journal> read_journal(const std::filesystem::path& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        return std::nullopt;
    }
    std::ostringstream s;
    s << in.rdbuf();
    if (s.str().size() > 4096) {
        return std::nullopt;
    }
    return parse_journal(s.str());
}

}  // namespace rr::xfer
