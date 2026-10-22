#include "rr/transfer/Sha256.h"

#include <cstdio>
#include <vector>

#include "rr/transfer/TransferFiles.h"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <bcrypt.h>
#endif

#ifdef _WIN32
namespace
{
std::string ntError(const char* what, long status)
{
    char b[96];
    std::snprintf(b, sizeof b, "%s failed (NTSTATUS 0x%08lX)", what, static_cast<unsigned long>(status));
    return b;
}
bool ok(NTSTATUS s)
{
    return s >= 0;
}
}  // namespace
#endif

Sha256::Sha256() = default;

Sha256::~Sha256()
{
    release();
}

void Sha256::release() noexcept
{
#ifdef _WIN32
    if (hash != nullptr)
    {
        BCryptDestroyHash(static_cast<BCRYPT_HASH_HANDLE>(hash));
        hash = nullptr;
    }
    if (alg != nullptr)
    {
        BCryptCloseAlgorithmProvider(static_cast<BCRYPT_ALG_HANDLE>(alg), 0);
        alg = nullptr;
    }
#endif
}

bool Sha256::init(std::string& error)
{
    release();
#ifdef _WIN32
    BCRYPT_ALG_HANDLE algHandle = nullptr;
    NTSTATUS s = BCryptOpenAlgorithmProvider(&algHandle, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
    if (!ok(s))
    {
        error = ntError("BCryptOpenAlgorithmProvider(SHA256)", s);
        return false;
    }
    alg = algHandle;
    BCRYPT_HASH_HANDLE h = nullptr;
    // No hash-object buffer: CNG allocates it (Windows 7 and later).
    s = BCryptCreateHash(algHandle, &h, nullptr, 0, nullptr, 0, 0);
    if (!ok(s))
    {
        error = ntError("BCryptCreateHash", s);
        release();
        return false;
    }
    hash = h;
    return true;
#else
    error = "SHA-256 is only available through Windows CNG in this build";
    return false;
#endif
}

bool Sha256::update(const void* data, size_t size, std::string& error)
{
#ifdef _WIN32
    if (hash == nullptr)
    {
        error = "SHA-256 not initialised";
        return false;
    }
    const auto* p = static_cast<const uint8_t*>(data);
    while (size > 0)
    {
        const ULONG n = size > 0x40000000u ? 0x40000000u : static_cast<ULONG>(size);
        const NTSTATUS s = BCryptHashData(static_cast<BCRYPT_HASH_HANDLE>(hash), const_cast<PUCHAR>(p), n, 0);
        if (!ok(s))
        {
            error = ntError("BCryptHashData", s);
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

bool Sha256::finish(Digest& out, std::string& error)
{
#ifdef _WIN32
    if (hash == nullptr)
    {
        error = "SHA-256 not initialised";
        return false;
    }
    const NTSTATUS s = BCryptFinishHash(static_cast<BCRYPT_HASH_HANDLE>(hash), out.data(), static_cast<ULONG>(out.size()), 0);
    release();
    if (!ok(s))
    {
        error = ntError("BCryptFinishHash", s);
        return false;
    }
    return true;
#else
    (void)out;
    error = "SHA-256 not available";
    return false;
#endif
}

bool sha256(const void* data, size_t size, Digest& out, std::string& error)
{
    Sha256 h;
    return h.init(error) && h.update(data, size, error) && h.finish(out, error);
}

bool sha256File(const std::filesystem::path& path, Digest& out, uint64_t& bytes, std::string& error)
{
    ReadOnlyFile f;
    if (!f.open(path, error))
    {
        return false;
    }
    Sha256 h;
    if (!h.init(error))
    {
        return false;
    }
    std::vector<uint8_t> buf(1 << 20);
    bytes = 0;
    for (;;)
    {
        size_t got = 0;
        if (!f.readAt(bytes, buf.data(), buf.size(), got, error))
        {
            return false;
        }
        if (got == 0)
        {
            break;
        }
        if (!h.update(buf.data(), got, error))
        {
            return false;
        }
        bytes += got;
    }
    return h.finish(out, error);
}

std::string toHex(const Digest& d)
{
    static const char* k = "0123456789abcdef";
    std::string s;
    s.reserve(64);
    for (const uint8_t b : d)
    {
        s.push_back(k[b >> 4]);
        s.push_back(k[b & 15]);
    }
    return s;
}

bool fromHex(const std::string& hex, Digest& out) noexcept
{
    if (hex.size() != 64)
    {
        return false;
    }
    auto nib = [](char c) -> int
    {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    for (size_t i = 0; i < 32; ++i)
    {
        const int hi = nib(hex[2 * i]);
        const int lo = nib(hex[2 * i + 1]);
        if (hi < 0 || lo < 0)
        {
            return false;
        }
        out[i] = static_cast<uint8_t>(hi * 16 + lo);
    }
    return true;
}

