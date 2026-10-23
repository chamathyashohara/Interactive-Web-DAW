#include "rr/shared/LogSinks.h"

#include <system_error>
#include <utility>

JsonLinesFileSink::JsonLinesFileSink(std::filesystem::path path) : path(std::move(path))
{
    std::error_code ec;
    if (this->path.has_parent_path())
    {
        std::filesystem::create_directories(this->path.parent_path(), ec);
    }
    out.open(this->path, std::ios::out | std::ios::app | std::ios::binary);
    ok = out.is_open();
}

void JsonLinesFileSink::write(const Record& record)
{
    if (!ok)
    {
        return;
    }
    out << toJsonLine(record) << '\n';
    if (!out)
    {
        ok = false;  // e.g. disk full; stop trying, the diagnostics screen shows it
    }
}

void JsonLinesFileSink::flush()
{
    if (ok)
    {
        out.flush();
    }
}

MemorySink::MemorySink(size_t capacity) : capacity(capacity == 0 ? 1 : capacity) {}

void MemorySink::write(const Record& record)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (records.size() >= capacity)
    {
        records.pop_front();
    }
    records.push_back(record);
}

std::vector<Record> MemorySink::snapshot() const
{
    std::lock_guard<std::mutex> lock(mutex);
    return std::vector<Record>(records.begin(), records.end());
}

