#pragma once

#include <atomic>
#include <cstddef>
#include <cstring>
#include <type_traits>
#include <vector>

// Bounded single-producer / single-consumer ring buffer for trivially copyable items.
//
// - All memory is allocated in the constructor. tryWriteAll() and read() never allocate,
//   lock or wait, so the producer side may run on a real-time audio callback.
// - Exactly ONE thread may call the producer functions (writeAvailable, tryWriteAll)
//   and exactly ONE (other) thread the consumer functions (readAvailable, read).
// - head/tail count items ever written/read; they wrap naturally as unsigned integers.
template <typename T>
class SpscRing
{
    static_assert(std::is_trivially_copyable<T>::value, "SpscRing holds trivially copyable items only");

public:
    /** Capacity is rounded up to a power of two (at least 2). */
    explicit SpscRing(size_t minCapacity)
    {
        size_t capacity = 2;
        while (capacity < minCapacity)
        {
            capacity <<= 1;
        }
        buffer.resize(capacity);
        mask = capacity - 1;
    }

    SpscRing(const SpscRing&) = delete;
    SpscRing& operator=(const SpscRing&) = delete;

    size_t capacity() const noexcept { return buffer.size(); }

    /** Producer side ------------------------------------------------------------------------ */
    size_t writeAvailable() const noexcept
    {
        const size_t headPos = head.load(std::memory_order_relaxed);
        const size_t tailPos = tail.load(std::memory_order_acquire);
        return capacity() - (headPos - tailPos);
    }

    /** Writes all n items or none. Returns false (and writes nothing) if there is no room. */
    bool tryWriteAll(const T* items, size_t n) noexcept
    {
        const size_t headPos = head.load(std::memory_order_relaxed);
        const size_t tailPos = tail.load(std::memory_order_acquire);
        if (n > capacity() - (headPos - tailPos))
        {
            return false;
        }
        const size_t start = headPos & mask;
        const size_t first = (n < capacity() - start) ? n : capacity() - start;
        std::memcpy(&buffer[start], items, first * sizeof(T));
        if (n > first)
        {
            std::memcpy(&buffer[0], items + first, (n - first) * sizeof(T));
        }
        head.store(headPos + n, std::memory_order_release);
        return true;
    }

    /** Consumer side ------------------------------------------------------------------------ */
    size_t readAvailable() const noexcept
    {
        const size_t tailPos = tail.load(std::memory_order_relaxed);
        const size_t headPos = head.load(std::memory_order_acquire);
        return headPos - tailPos;
    }

    /** Reads up to maxItems; returns the number read. */
    size_t read(T* out, size_t maxItems) noexcept
    {
        const size_t tailPos = tail.load(std::memory_order_relaxed);
        const size_t headPos = head.load(std::memory_order_acquire);
        const size_t available = headPos - tailPos;
        const size_t n = maxItems < available ? maxItems : available;
        const size_t start = tailPos & mask;
        const size_t first = (n < capacity() - start) ? n : capacity() - start;
        std::memcpy(out, &buffer[start], first * sizeof(T));
        if (n > first)
        {
            std::memcpy(out + first, &buffer[0], (n - first) * sizeof(T));
        }
        tail.store(tailPos + n, std::memory_order_release);
        return n;
    }

private:
    std::vector<T> buffer;
    size_t mask = 0;
    /**
     * Producer and consumer indices on separate cache lines (explicit padding rather than
     * alignas, which MSVC reports as warning C4324 inside a class template).
     */
    std::atomic<size_t> head{0};
    char padHead[64 - sizeof(std::atomic<size_t>)] = {};
    std::atomic<size_t> tail{0};
    char padTail[64 - sizeof(std::atomic<size_t>)] = {};
};

