#include "rr/shared/realtime_guard.hpp"

namespace rr::rt {
namespace {
thread_local bool t_is_realtime = false;
}  // namespace

ScopedRealtimeThread::ScopedRealtimeThread() noexcept : previous_(t_is_realtime) {
    t_is_realtime = true;
}

ScopedRealtimeThread::~ScopedRealtimeThread() {
    t_is_realtime = previous_;
}

bool is_realtime_thread() noexcept {
    return t_is_realtime;
}

}  // namespace rr::rt
