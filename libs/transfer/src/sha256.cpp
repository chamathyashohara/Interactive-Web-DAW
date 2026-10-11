#include "rr/transfer/sha256.hpp"

#include <cstdio>
#include <vector>

#include "rr/transfer/transfer_files.hpp"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <bcrypt.h>
#endif

namespace rr::xfer {

#ifdef _WIN32
namespace {
std::string nt_error(const char* what, long status) {
    char b[96];
    std::snprintf(b, sizeof b, "%s failed (NTSTATUS 0x%08lX)", what, static_cast<unsigned long>(status));
    return b;
}
bool ok(NTSTATUS s) {
    return s >= 0;
}
}  // namespace
#endif

Sha256::Sha256() = default;

Sha256::~Sha256() {
    release();
}

void Sha256::release() noexcept {
#ifdef _WIN32
    if (hash_ != nullptr) {
        BCryptDestroyHash(static_cast<BCRYPT_HASH_HANDLE>(hash_));
        hash_ = nullptr;
    }
    if (alg_ != nullptr) {
        BCryptCloseAlgorithmProvider(static_cast<BCRYPT_ALG_HANDLE>(alg_), 0);
        alg_ = nullptr;
    }
#endif
}

bool Sha256::init(std::string& error) {
    release();
#ifdef _WIN32
    BCRYPT_ALG_HANDLE alg = nullptr;
    NTSTATUS s = BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
    if (!ok(s)) {
        error = nt_error("BCryptOpenAlgorithmProvider(SHA256)", s);
        return false;
    }
    alg_ = alg;
    BCRYPT_HASH_HANDLE h = nullptr;
    // No hash-object buffer: CNG allocates it (Windows 7 and later).
    s = BCryptCreateHash(alg, &h, nullptr, 0, nullptr, 0, 0);
    if (!ok(s)) {
        error = nt_error("BCryptCreateHash", s);
        release();
        return false;
    }
    hash_ = h;
    return true;
#else
    error = "SHA-256 is only available through Windows CNG in this build";
    return false;
#endif
}

bool Sha256::update(const void* data, std::size_t size, std::string& error) {
#ifdef _WIN32
    if (hash_ == nullptr) {
        error = "SHA-256 not initialised";
        return false;
    }
    const auto* p = static_cast<const std::uint8_t*>(data);
    while (size > 0) {
        const ULONG n = size > 0x40000000u ? 0x40000000u : static_cast<ULONG>(size);
        const NTSTATUS s = BCryptHashData(static_cast<BCRYPT_HASH_HANDLE>(hash_), const_cast<PUCHAR>(p), n, 0);
        if (!ok(s)) {
            error = nt_error("BCryptHashData", s);
            return false;
        }
        p += n;
        size -= n;
    }
    return true;
#else
    (void)data;
    (void)size;
    error = "SHA-256 not available";
    return false;
#endif
}

bool Sha256::finish(Digest& out, std::string& error) {
#ifdef _WIN32
    if (hash_ == nullptr) {
        error = "SHA-256 not initialised";
        return false;
    }
    const NTSTATUS s = BCryptFinishHash(static_cast<BCRYPT_HASH_HANDLE>(hash_), out.data(), static_cast<ULONG>(out.size()), 0);
    release();
    if (!ok(s)) {
        error = nt_error("BCryptFinishHash", s);
        return false;
    }
    return true;
#else
    (void)out;
    error = "SHA-256 not available";
    return false;
#endif
}

bool sha256(const void* data, std::size_t size, Digest& out, std::string& error) {
    Sha256 h;
    return h.init(error) && h.update(data, size, error) && h.finish(out, error);
}

bool sha256_file(const std::filesystem::path& path, Digest& out, std::uint64_t& bytes, std::string& error) {
    ReadOnlyFile f;
    if (!f.open(path, error)) {
        return false;
    }
    Sha256 h;
    if (!h.init(error)) {
        return false;
    }
    std::vector<std::uint8_t> buf(1 << 20);
    bytes = 0;
    for (;;) {
        std::size_t got = 0;
        if (!f.read_at(bytes, buf.data(), buf.size(), got, error)) {
            return false;
        }
        if (got == 0) {
            break;
        }
        if (!h.update(buf.data(), got, error)) {
            return false;
        }
        bytes += got;
    }
    return h.finish(out, error);
}

std::string to_hex(const Digest& d) {
    static const char* k = "0123456789abcdef";
    std::string s;
    s.reserve(64);
    for (const std::uint8_t b : d) {
        s.push_back(k[b >> 4]);
        s.push_back(k[b & 15]);
    }
    return s;
}

bool from_hex(const std::string& hex, Digest& out) noexcept {
    if (hex.size() != 64) {
        return false;
    }
    auto nib = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    for (std::size_t i = 0; i < 32; ++i) {
        const int hi = nib(hex[2 * i]);
        const int lo = nib(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) {
            return false;
        }
        out[i] = static_cast<std::uint8_t>(hi * 16 + lo);
    }
    return true;
}

}  // namespace rr::xfer
