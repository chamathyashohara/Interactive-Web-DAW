#pragma once

namespace rr::rt {

// Marks the current thread as a real-time audio thread for the lifetime of the object.
// Functions that may block or allocate (for example rr::log::Logger::log) check this and
// refuse to run, counting the violation instead (THREADING_AND_AUDIO_CALLBACKS.md §5).
// Audio callbacks create one of these on entry once audio exists (later increment).
class ScopedRealtimeThread {
public:
    ScopedRealtimeThread() noexcept;
    ~ScopedRealtimeThread();
    ScopedRealtimeThread(const ScopedRealtimeThread&) = delete;
    ScopedRealtimeThread& operator=(const ScopedRealtimeThread&) = delete;

private:
    bool previous_;
};

bool is_realtime_thread() noexcept;

}  // namespace rr::rt
