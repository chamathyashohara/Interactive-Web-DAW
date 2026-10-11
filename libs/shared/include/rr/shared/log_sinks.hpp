#pragma once

#include <cstddef>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <vector>

#include "rr/shared/log.hpp"

namespace rr::log {

// Appends one JSON object per line (JSON Lines) to a file. Creates the parent folder.
// If the file cannot be opened, ok() is false and writes are ignored; the app keeps running
// and reports the failure on its diagnostics screen.
class JsonLinesFileSink final : public Sink {
public:
    explicit JsonLinesFileSink(std::filesystem::path path);
    void write(const Record& record) override;
    void flush() override;
    bool ok() const noexcept { return ok_; }
    const std::filesystem::path& path() const noexcept { return path_; }

private:
    std::filesystem::path path_;
    std::ofstream out_;
    bool ok_ = false;
};

// Keeps the most recent records in memory (for the diagnostics screen and tests).
// snapshot() is safe to call from any thread.
class MemorySink final : public Sink {
public:
    explicit MemorySink(std::size_t capacity);
    void write(const Record& record) override;
    void flush() override {}
    std::vector<Record> snapshot() const;

private:
    const std::size_t capacity_;
    mutable std::mutex mutex_;
    std::deque<Record> records_;
};

}  // namespace rr::log
