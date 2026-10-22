#pragma once

#include <cstddef>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <vector>

#include "rr/shared/Log.h"

/**
 * Appends one JSON object per line (JSON Lines) to a file. Creates the parent folder.
 * If the file cannot be opened, ok() is false and writes are ignored; the app keeps running
 * and reports the failure on its diagnostics screen.
 */
class JsonLinesFileSink final : public Sink
{
public:
    explicit JsonLinesFileSink(std::filesystem::path path);
    void write(const Record& record) override;
    void flush() override;
    bool isOk() const noexcept { return ok; }
    const std::filesystem::path& getPath() const noexcept { return path; }

private:
    std::filesystem::path path;
    std::ofstream out;
    bool ok = false;
};

/**
 * Keeps the most recent records in memory (for the diagnostics screen and tests).
 * snapshot() is safe to call from any thread.
 */
class MemorySink final : public Sink
{
public:
    explicit MemorySink(size_t capacity);
    void write(const Record& record) override;
    void flush() override {}
    std::vector<Record> snapshot() const;

private:
    const size_t capacity;
    mutable std::mutex mutex;
    std::deque<Record> records;
};

