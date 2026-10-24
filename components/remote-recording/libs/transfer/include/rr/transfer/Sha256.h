#pragma once

// SHA-256 through the operating system's crypto library (ADR-014, ADR-012: no custom cryptography).
// Windows: CNG (BCryptOpenAlgorithmProvider with BCRYPT_SHA256_ALGORITHM, bcrypt.dll).
// Other platforms: not available; init() fails with a clear error (the product is Windows-only).

#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>

using Digest = std::array<uint8_t, 32>;

class Sha256
{
public:
    Sha256();
    ~Sha256();
    Sha256(const Sha256&) = delete;
    Sha256& operator=(const Sha256&) = delete;

    /** Starts a new hash (also after finish()). False if no provider is available. */
    bool init(std::string& error);
    bool update(const void* data, size_t size, std::string& error);
    bool finish(Digest& out, std::string& error);

private:
    void release() noexcept;
    void* alg = nullptr;   // BCRYPT_ALG_HANDLE
    void* hash = nullptr;  // BCRYPT_HASH_HANDLE
};

/** One-shot hash of a buffer. */
bool sha256(const void* data, size_t size, Digest& out, std::string& error);

/** Hash of a whole file, read in 1 MiB blocks (opened read-only). */
bool sha256File(const std::filesystem::path& path, Digest& out, uint64_t& bytes, std::string& error);

std::string toHex(const Digest& d);                         // 64 lower-case hex digits
bool fromHex(const std::string& hex, Digest& out) noexcept;  // exactly 64 hex digits

