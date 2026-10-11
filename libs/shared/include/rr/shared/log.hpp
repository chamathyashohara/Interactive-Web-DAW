#pragma once

// Structured logging (Stage 3 design).
//
// - Callers build a Record and hand it to Logger::log(). The call never touches a file or
//   console: it only appends to a bounded in-memory queue under a short lock. A dedicated
//   writer thread drains the queue to the sinks (JSON Lines file, in-memory recent list).
// - When the queue is full the record is dropped and counted (stats().dropped_queue_full),
//   so a slow disk can never stall the UI or control thread.
// - NOT for real-time audio threads: Record holds std::string/vector, so building one
//   allocates. On a thread marked with rr::rt::ScopedRealtimeThread, log() returns false
//   and counts stats().rejected_realtime. Real-time code reports through atomic counters.

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <initializer_list>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace rr::log {

enum class Level : std::uint8_t { Trace, Debug, Info, Warn, Error };

std::string_view level_name(Level level) noexcept;  // "trace" ... "error"

struct Field {
    std::string key;
    std::string value;
};

struct Record {
    std::int64_t mono_ns = 0;    // rr::time::monotonic_ns()
    std::int64_t utc_ms = 0;     // rr::time::utc_now_ms()
    std::uint64_t thread_id = 0;
    Level level = Level::Info;
    std::string component;       // e.g. "app", "ui", "qt"
    std::string event;           // short machine-readable name, e.g. "startup"
    std::string message;         // human-readable text
    std::vector<Field> fields;   // extra key/value pairs
};

// One JSON object, no trailing newline:
// {"t_utc":"...","t_mono_ns":..,"lvl":"info","comp":"app","event":"startup","msg":"...","tid":..,"fields":{...}}
std::string to_json_line(const Record& record);

class Sink {
public:
    virtual ~Sink() = default;
    virtual void write(const Record& record) = 0;  // called only from the writer thread
    virtual void flush() = 0;                      // called only from the writer thread
};

struct LoggerStats {
    std::uint64_t accepted = 0;
    std::uint64_t written = 0;
    std::uint64_t dropped_queue_full = 0;
    std::uint64_t rejected_realtime = 0;
    std::uint64_t rejected_stopped = 0;
    std::uint64_t sink_errors = 0;
};

class Logger {
public:
    explicit Logger(std::size_t queue_capacity = 4096);
    ~Logger();  // calls stop()

    Logger(const Logger&) = delete;
    Logger& operator=(const Logger&) = delete;

    // Sinks must be added before start(); returns false afterwards.
    bool add_sink(std::shared_ptr<Sink> sink);

    // Starts the writer thread. Records logged before start() wait in the queue.
    void start();

    // Rejects further records, writes everything queued, flushes, joins. Idempotent.
    void stop() noexcept;

    // Thread-safe; never blocks on I/O. Returns false if the record was not accepted.
    bool log(Level level, std::string_view component, std::string_view event,
             std::string_view message, std::initializer_list<Field> fields = {});
    bool submit(Record record);

    LoggerStats stats() const;

private:
    enum class State { Created, Running, Stopped };

    void writer_loop();

    const std::size_t capacity_;
    mutable std::mutex mutex_;
    std::condition_variable wake_;
    std::deque<Record> queue_;
    std::vector<std::shared_ptr<Sink>> sinks_;
    State state_ = State::Created;
    bool writer_should_exit_ = false;
    LoggerStats stats_;
    // Counted without the mutex: the rejection path runs on real-time threads.
    std::atomic<std::uint64_t> rejected_realtime_{0};
    std::thread writer_;
};

}  // namespace rr::log
