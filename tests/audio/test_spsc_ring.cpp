#include <catch2/catch_test_macros.hpp>

#include <thread>
#include <vector>

#include "rr/audio/spsc_ring.hpp"

using rr::audio::SpscRing;

TEST_CASE("ring capacity rounds up to a power of two", "[audio][ring]") {
    CHECK(SpscRing<int>(1).capacity() == 2);
    CHECK(SpscRing<int>(1000).capacity() == 1024);
    CHECK(SpscRing<int>(1024).capacity() == 1024);
}

TEST_CASE("writes are all-or-nothing and wrap correctly", "[audio][ring]") {
    SpscRing<int> ring(8);
    const int a[6] = {1, 2, 3, 4, 5, 6};
    REQUIRE(ring.try_write_all(a, 6));
    CHECK_FALSE(ring.try_write_all(a, 3));  // only 2 free: nothing written
    CHECK(ring.read_available() == 6);
    int out[8] = {};
    CHECK(ring.read(out, 4) == 4);
    CHECK(out[3] == 4);
    REQUIRE(ring.try_write_all(a, 6));  // wraps around the end
    CHECK(ring.read(out, 8) == 8);
    const int expected[8] = {5, 6, 1, 2, 3, 4, 5, 6};
    for (int i = 0; i < 8; ++i) {
        CHECK(out[i] == expected[i]);
    }
    CHECK(ring.read(out, 8) == 0);
}

TEST_CASE("one producer and one consumer thread transfer every item in order", "[audio][ring]") {
    SpscRing<std::uint32_t> ring(256);
    constexpr std::uint32_t kTotal = 200000;
    std::thread producer([&] {
        std::uint32_t next = 0;
        std::uint32_t block[17];
        while (next < kTotal) {
            const std::uint32_t n = (kTotal - next) < 17 ? (kTotal - next) : 17;
            for (std::uint32_t i = 0; i < n; ++i) {
                block[i] = next + i;
            }
            if (ring.try_write_all(block, n)) {
                next += n;
            } else {
                std::this_thread::yield();
            }
        }
    });
    std::uint32_t expected = 0;
    bool in_order = true;
    std::vector<std::uint32_t> out(64);
    while (expected < kTotal) {
        const std::size_t n = ring.read(out.data(), out.size());
        for (std::size_t i = 0; i < n; ++i) {
            in_order = in_order && (out[i] == expected);
            ++expected;
        }
        if (n == 0) {
            std::this_thread::yield();
        }
    }
    producer.join();
    CHECK(in_order);
    CHECK(expected == kTotal);
}
