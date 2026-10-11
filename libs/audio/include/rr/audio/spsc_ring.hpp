#pragma once

#include <atomic>
#include <cstddef>
#include <cstring>
#include <type_traits>
#include <vector>

namespace rr::audio {

// Bounded single-producer / single-consumer ring buffer for trivially copyable items.
//
// - All memory is allocated in the constructor. try_write_all() and read() never allocate,
//   lock or wait, so the producer side may run on a real-time audio callback.
// - Exactly ONE thread may call the producer functions (write_available, try_write_all)
//   and exactly ONE (other) thread the consumer functions (read_available, read).
// - head_/tail_ count items ever written/read; they wrap naturally as unsigned integers.
template <typename T>
class SpscRing {
    static_assert(std::is_trivially_copyable<T>::value, "SpscRing holds trivially copyable items only");

public:
    // Capacity is rounded up to a power of two (at least 2).
    explicit SpscRing(std::size_t min_capacity) {
        std::size_t capacity = 2;
        while (capacity < min_capacity) {
            capacity <<= 1;
        }
        buffer_.resize(capacity);
        mask_ = capacity - 1;
    }

    SpscRing(const SpscRing&) = delete;
    SpscRing& operator=(const SpscRing&) = delete;

    std::size_t capacity() const noexcept { return buffer_.size(); }

    // Producer side ------------------------------------------------------------------------
    std::size_t write_available() const noexcept {
        const std::size_t head = head_.load(std::memory_order_relaxed);
        const std::size_t tail = tail_.load(std::memory_order_acquire);
        return capacity() - (head - tail);
    }

    // Writes all n items or none. Returns false (and writes nothing) if there is no room.
    bool try_write_all(const T* items, std::size_t n) noexcept {
        const std::size_t head = head_.load(std::memory_order_relaxed);
        const std::size_t tail = tail_.load(std::memory_order_acquire);
        if (n > capacity() - (head - tail)) {
            return false;
        }
        const std::size_t start = head & mask_;
        const std::size_t first = (n < capacity() - start) ? n : capacity() - start;
        std::memcpy(&buffer_[start], items, first * sizeof(T));
        if (n > first) {
            std::memcpy(&buffer_[0], items + first, (n - first) * sizeof(T));
        }
        head_.store(head + n, std::memory_order_release);
        return true;
    }

    // Consumer side ------------------------------------------------------------------------
    std::size_t read_available() const noexcept {
        const std::size_t tail = tail_.load(std::memory_order_relaxed);
        const std::size_t head = head_.load(std::memory_order_acquire);
        return head - tail;
    }

    // Reads up to max_items; returns the number read.
    std::size_t read(T* out, std::size_t max_items) noexcept {
        const std::size_t tail = tail_.load(std::memory_order_relaxed);
        const std::size_t head = head_.load(std::memory_order_acquire);
        const std::size_t available = head - tail;
        const std::size_t n = max_items < available ? max_items : available;
        const std::size_t start = tail & mask_;
        const std::size_t first = (n < capacity() - start) ? n : capacity() - start;
        std::memcpy(out, &buffer_[start], first * sizeof(T));
        if (n > first) {
            std::memcpy(out + first, &buffer_[0], (n - first) * sizeof(T));
        }
        tail_.store(tail + n, std::memory_order_release);
        return n;
    }

private:
    std::vector<T> buffer_;
    std::size_t mask_ = 0;
    // Producer and consumer indices on separate cache lines (explicit padding rather than
    // alignas, which MSVC reports as warning C4324 inside a class template).
    std::atomic<std::size_t> head_{0};
    char pad_head_[64 - sizeof(std::atomic<std::size_t>)] = {};
    std::atomic<std::size_t> tail_{0};
    char pad_tail_[64 - sizeof(std::atomic<std::size_t>)] = {};
};

}  // namespace rr::audio
