#include "rr/audio/TakeNaming.h"

#include <cstdio>
#include <random>
#include <system_error>

#include "rr/audio/FileIo.h"
#include "rr/shared/Clock.h"

std::string makeSessionId()
{
    std::random_device rd;
    uint32_t value = 0;
    while (value == 0)
    {
        value = (static_cast<uint32_t>(rd()) << 1) ^ static_cast<uint32_t>(rd());
    }
    char text[9];
    std::snprintf(text, sizeof text, "%08x", value);
    return text;
}

bool isValidSessionId(const std::string& id) noexcept
{
    if (id.size() != 8 || id == "00000000")
    {
        return false;
    }
    for (const char c : id)
    {
        const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        if (!hex)
        {
            return false;
        }
    }
    return true;
}

std::string sessionFolderName(int64_t utcMs, const std::string& sessionId)
{
    // "2026-10-11T04:05:06.789Z" -> "20261011-040506"
    const std::string iso = formatUtcIso8601Ms(utcMs);
    std::string compact;
    compact += iso.substr(0, 4);
    compact += iso.substr(5, 2);
    compact += iso.substr(8, 2);
    compact += '-';
    compact += iso.substr(11, 2);
    compact += iso.substr(14, 2);
    compact += iso.substr(17, 2);
    return compact + "_" + sessionId;
}

std::string takeStem(uint32_t takeNumber, Role role, const std::string& sessionId)
{
    char number[8];
    std::snprintf(number, sizeof number, "%02u", static_cast<unsigned>(takeNumber));
    return std::string("take") + number + "_" + std::string(roleId(role)) + "_" + sessionId;
}

uint32_t nextFreeTakeNumber(const std::filesystem::path& sessionDir, Role role,
                                    const std::string& sessionId)
                                    {
    for (uint32_t n = 1; n < 1000; ++n)
    {
        const std::string stem = takeStem(n, role, sessionId);
        bool used = false;
        std::error_code ec;
        if (std::filesystem::exists(sessionDir, ec))
        {
            for (const auto& entry : std::filesystem::directory_iterator(sessionDir, ec))
            {
                const std::string name = pathToUtf8(entry.path().filename());
                if (name.compare(0, stem.size(), stem) == 0 &&
                    (name.size() == stem.size() || name[stem.size()] == '.')) {
                    used = true;
                    break;
                }
            }
        }
        if (!used)
        {
            return n;
        }
    }
    return 0;  // 999 takes in one session: caller reports "no free take number"
}

