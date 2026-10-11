#include "rr/shared/log_sinks.hpp"

#include <system_error>
#include <utility>

namespace rr::log {

JsonLinesFileSink::JsonLinesFileSink(std::filesystem::path path) : path_(std::move(path)) {
    std::error_code ec;
    if (path_.has_parent_path()) {
        std::filesystem::create_directories(path_.parent_path(), ec);
    }
    out_.open(path_, std::ios::out | std::ios::app | std::ios::binary);
    ok_ = out_.is_open();
}

void JsonLinesFileSink::write(const Record& record) {
    if (!ok_) {
        return;
    }
    out_ << to_json_line(record) << '\n';
    if (!out_) {
        ok_ = false;  // e.g. disk full; stop trying, the diagnostics screen shows it
    }
}

void JsonLinesFileSink::flush() {
    if (ok_) {
        out_.flush();
    }
}

MemorySink::MemorySink(std::size_t capacity) : capacity_(capacity == 0 ? 1 : capacity) {}

void MemorySink::write(const Record& record) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (records_.size() >= capacity_) {
        records_.pop_front();
    }
    records_.push_back(record);
}

std::vector<Record> MemorySink::snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return std::vector<Record>(records_.begin(), records_.end());
}

}  // namespace rr::log
