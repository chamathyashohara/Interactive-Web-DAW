#pragma once

// Structured logging (Stage 3 design).
//
// - Callers build a Record and hand it to Logger::log(). The call never touches a file or
//   console: it only appends to a bounded in-memory queue under a short lock. A dedicated
//   writer thread drains the queue to the sinks (JSON Lines file, in-memory recent list).
// - When the queue is full the record is dropped and counted (stats().droppedQueueFull),
//   so a slow disk can never stall the UI or control thread.
// - NOT for real-time audio threads: Record holds std::string/vector, so building one
//   allocates. On a thread marked with ScopedRealtimeThread, log() returns false
//   and counts stats().rejectedRealtime. Real-time code reports through atomic counters.

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

enum class Level : uint8_t { Trace, Debug, Info, Warn, Error };

std::string_view levelName(Level level) noexcept;  // "trace" ... "error"

struct Field
{
    std::string key;
    std::string value;
};

struct Record
{
    int64_t monoNs = 0;    // monotonicNs()
    int64_t utcMs = 0;     // utcNowMs()
    uint64_t threadId = 0;
    Level level = Level::Info;
    std::string component;       // e.g. "app", "ui", "qt"
    std::string event;           // short machine-readable name, e.g. "startup"
    std::string message;         // human-readable text
    std::vector<Field> fields;   // extra key/value pairs
};

/**
 * One JSON object, no trailing newline:
 * {"t_utc":"...","t_mono_ns":..,"lvl":"info","comp":"app","event":"startup","msg":"...","tid":..,"fields":{...}}
 */
std::string toJsonLine(const Record& record);

class Sink
{
public:
    virtual ~Sink() = default;
    virtual void write(const Record& record) = 0;  // called only from the writer thread
    virtual void flush() = 0;                      // called only from the writer thread
};

struct LoggerStats
{
    uint64_t accepted = 0;
    uint64_t written = 0;
    uint64_t droppedQueueFull = 0;
    uint64_t rejectedRealtime = 0;
    uint64_t rejectedStopped = 0;
    uint64_t sinkErrors = 0;
};

class Logger
{
public:
    explicit Logger(size_t queueCapacity = 4096);
    ~Logger();  // calls stop()

    Logger(const Logger&) = delete;
    Logger& operator=(const Logger&) = delete;

    /** Sinks must be added before start(); returns false afterwards. */
    bool addSink(std::shared_ptr<Sink> sink);

    /** Starts the writer thread. Records logged before start() wait in the queue. */
    void start();

    /** Rejects further records, writes everything queued, flushes, joins. Idempotent. */
    void stop() noexcept;

    /** Thread-safe; never blocks on I/O. Returns false if the record was not accepted. */
    bool log(Level level, std::string_view component, std::string_view event,
             std::string_view message, std::initializer_list<Field> fields = {});
    bool submit(Record record);

    LoggerStats getStats() const;

private:
    enum class State { Created, Running, Stopped };

    void writerLoop();

    const size_t capacity;
    mutable std::mutex mutex;
    std::condition_variable wake;
    std::deque<Record> queue;
    std::vector<std::shared_ptr<Sink>> sinks;
    State state = State::Created;
    bool writerShouldExit = false;
    LoggerStats stats;
    /** Counted without the mutex: the rejection path runs on real-time threads. */
    std::atomic<uint64_t> rejectedRealtime{0};
    std::thread writer;
};

