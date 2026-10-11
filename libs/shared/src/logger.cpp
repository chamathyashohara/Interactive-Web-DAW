#include <exception>
#include <functional>
#include <utility>

#include "rr/shared/clock.hpp"
#include "rr/shared/log.hpp"
#include "rr/shared/realtime_guard.hpp"

namespace rr::log {
namespace {

std::uint64_t current_thread_id() {
    return static_cast<std::uint64_t>(std::hash<std::thread::id>{}(std::this_thread::get_id()));
}

}  // namespace

Logger::Logger(std::size_t queue_capacity) : capacity_(queue_capacity == 0 ? 1 : queue_capacity) {}

Logger::~Logger() {
    stop();
}

bool Logger::add_sink(std::shared_ptr<Sink> sink) {
    if (!sink) {
        return false;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ != State::Created) {
        return false;
    }
    sinks_.push_back(std::move(sink));
    return true;
}

void Logger::start() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ != State::Created) {
        return;
    }
    state_ = State::Running;
    writer_ = std::thread([this] { writer_loop(); });
}

void Logger::stop() noexcept {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ == State::Stopped) {
            return;
        }
        const bool was_running = (state_ == State::Running);
        state_ = State::Stopped;
        writer_should_exit_ = true;
        if (!was_running) {
            // Never started: nothing will drain the queue; discard what is there.
            queue_.clear();
            return;
        }
    }
    wake_.notify_one();
    if (writer_.joinable()) {
        writer_.join();
    }
}

bool Logger::log(Level level, std::string_view component, std::string_view event,
                 std::string_view message, std::initializer_list<Field> fields) {
    if (rt::is_realtime_thread()) {
        // Do not even build the Record: that would allocate on an audio thread.
        rejected_realtime_.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    Record r;
    r.mono_ns = time::monotonic_ns();
    r.utc_ms = time::utc_now_ms();
    r.thread_id = current_thread_id();
    r.level = level;
    r.component = std::string(component);
    r.event = std::string(event);
    r.message = std::string(message);
    r.fields.assign(fields.begin(), fields.end());
    return submit(std::move(r));
}

bool Logger::submit(Record record) {
    if (rt::is_realtime_thread()) {
        rejected_realtime_.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ == State::Stopped) {
            ++stats_.rejected_stopped;
            return false;
        }
        if (queue_.size() >= capacity_) {
            ++stats_.dropped_queue_full;
            return false;
        }
        queue_.push_back(std::move(record));
        ++stats_.accepted;
    }
    wake_.notify_one();
    return true;
}

LoggerStats Logger::stats() const {
    std::lock_guard<std::mutex> lock(mutex_);
    LoggerStats copy = stats_;
    copy.rejected_realtime = rejected_realtime_.load(std::memory_order_relaxed);
    return copy;
}

void Logger::writer_loop() {
    std::deque<Record> batch;
    for (;;) {
        bool exit_after_batch = false;
        {
            std::unique_lock<std::mutex> lock(mutex_);
            wake_.wait(lock, [this] { return writer_should_exit_ || !queue_.empty(); });
            batch.swap(queue_);
            exit_after_batch = writer_should_exit_;
        }
        // Sinks run outside the lock so producers never wait for file I/O.
        std::uint64_t written = 0;
        std::uint64_t errors = 0;
        for (const Record& r : batch) {
            for (const auto& sink : sinks_) {
                try {
                    sink->write(r);
                } catch (const std::exception&) {
                    ++errors;
                }
            }
            ++written;
        }
        batch.clear();
        for (const auto& sink : sinks_) {
            try {
                sink->flush();
            } catch (const std::exception&) {
                ++errors;
            }
        }
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stats_.written += written;
            stats_.sink_errors += errors;
            // stop() sets writer_should_exit_ only after it stopped accepting records, so
            // once the queue is empty here nothing else can arrive.
            if (exit_after_batch && queue_.empty()) {
                return;
            }
        }
    }
}

}  // namespace rr::log
