#include <exception>
#include <functional>
#include <utility>

#include "rr/shared/Clock.h"
#include "rr/shared/Log.h"
#include "rr/shared/RealtimeGuard.h"

namespace
{

uint64_t currentThreadId()
{
    return static_cast<uint64_t>(std::hash<std::thread::id>{}(std::this_thread::get_id()));
}

}  // namespace

Logger::Logger(size_t queueCapacity) : capacity(queueCapacity == 0 ? 1 : queueCapacity) {}

Logger::~Logger()
{
    stop();
}

bool Logger::addSink(std::shared_ptr<Sink> sink)
{
    if (!sink)
    {
        return false;
    }
    std::lock_guard<std::mutex> lock(mutex);
    if (state != State::Created)
    {
        return false;
    }
    sinks.push_back(std::move(sink));
    return true;
}

void Logger::start()
{
    std::lock_guard<std::mutex> lock(mutex);
    if (state != State::Created)
    {
        return;
    }
    state = State::Running;
    writer = std::thread([this] { writerLoop(); });
}

void Logger::stop() noexcept
{
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (state == State::Stopped)
        {
            return;
        }
        const bool wasRunning = (state == State::Running);
        state = State::Stopped;
        writerShouldExit = true;
        if (!wasRunning)
        {
            // Never started: nothing will drain the queue; discard what is there.
            queue.clear();
            return;
        }
    }
    wake.notify_one();
    if (writer.joinable())
    {
        writer.join();
    }
}

bool Logger::log(Level level, std::string_view component, std::string_view event,
                 std::string_view message, std::initializer_list<Field> fields)
                 {
    if (isRealtimeThread())
    {
        // Do not even build the Record: that would allocate on an audio thread.
        rejectedRealtime.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    Record r;
    r.monoNs = monotonicNs();
    r.utcMs = utcNowMs();
    r.threadId = currentThreadId();
    r.level = level;
    r.component = std::string(component);
    r.event = std::string(event);
    r.message = std::string(message);
    r.fields.assign(fields.begin(), fields.end());
    return submit(std::move(r));
}

bool Logger::submit(Record record)
{
    if (isRealtimeThread())
    {
        rejectedRealtime.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (state == State::Stopped)
        {
            ++stats.rejectedStopped;
            return false;
        }
        if (queue.size() >= capacity)
        {
            ++stats.droppedQueueFull;
            return false;
        }
        queue.push_back(std::move(record));
        ++stats.accepted;
    }
    wake.notify_one();
    return true;
}

LoggerStats Logger::getStats() const
{
    std::lock_guard<std::mutex> lock(mutex);
    LoggerStats copy = stats;
    copy.rejectedRealtime = rejectedRealtime.load(std::memory_order_relaxed);
    return copy;
}

void Logger::writerLoop()
{
    std::deque<Record> batch;
    for (;;)
    {
        bool exitAfterBatch = false;
        {
            std::unique_lock<std::mutex> lock(mutex);
            wake.wait(lock, [this] { return writerShouldExit || !queue.empty(); });
            batch.swap(queue);
            exitAfterBatch = writerShouldExit;
        }
        // Sinks run outside the lock so producers never wait for file I/O.
        uint64_t written = 0;
        uint64_t errors = 0;
        for (const Record& r : batch)
        {
            for (const auto& sink : sinks)
            {
                try
                {
                    sink->write(r);
                } catch (const std::exception&) {
                    ++errors;
                }
            }
            ++written;
        }
        batch.clear();
        for (const auto& sink : sinks)
        {
            try
            {
                sink->flush();
            } catch (const std::exception&) {
                ++errors;
            }
        }
        {
            std::lock_guard<std::mutex> lock(mutex);
            stats.written += written;
            stats.sinkErrors += errors;
            // stop() sets writerShouldExit only after it stopped accepting records, so
            // once the queue is empty here nothing else can arrive.
            if (exitAfterBatch && queue.empty())
            {
                return;
            }
        }
    }
}

