#include "rr/shared/RealtimeGuard.h"

namespace
{
thread_local bool tIsRealtime = false;
}  // namespace

ScopedRealtimeThread::ScopedRealtimeThread() noexcept : previous(tIsRealtime)
{
    tIsRealtime = true;
}

ScopedRealtimeThread::~ScopedRealtimeThread()
{
    tIsRealtime = previous;
}

bool isRealtimeThread() noexcept
{
    return tIsRealtime;
}

