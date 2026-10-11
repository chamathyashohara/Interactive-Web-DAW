#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "rr/shared/log.hpp"
#include "rr/shared/log_sinks.hpp"
#include "rr/shared/realtime_guard.hpp"

using rr::log::Level;
using rr::log::Logger;
using rr::log::MemorySink;

TEST_CASE("records reach the sinks in order and stop() flushes", "[shared][log]") {
    auto sink = std::make_shared<MemorySink>(100);
    Logger logger;
    REQUIRE(logger.add_sink(sink));
    logger.start();
    CHECK(logger.log(Level::Info, "test", "first", "one"));
    CHECK(logger.log(Level::Warn, "test", "second", "two", {{"k", "v"}}));
    logger.stop();

    const auto records = sink->snapshot();
    REQUIRE(records.size() == 2);
    CHECK(records[0].event == "first");
    CHECK(records[1].event == "second");
    CHECK(records[1].level == Level::Warn);
    REQUIRE(records[1].fields.size() == 1);
    CHECK(records[1].fields[0].value == "v");
    CHECK(logger.stats().written == 2);
}

TEST_CASE("a full queue drops and counts instead of blocking", "[shared][log]") {
    auto sink = std::make_shared<MemorySink>(100);
    Logger logger(2);  // writer not started yet, so the queue cannot drain
    REQUIRE(logger.add_sink(sink));
    int accepted = 0;
    for (int i = 0; i < 5; ++i) {
        accepted += logger.log(Level::Info, "test", "e", "m") ? 1 : 0;
    }
    CHECK(accepted == 2);
    CHECK(logger.stats().dropped_queue_full == 3);
    logger.start();
    logger.stop();
    CHECK(sink->snapshot().size() == 2);
}

TEST_CASE("logging from a real-time thread is refused and counted", "[shared][log][rt]") {
    auto sink = std::make_shared<MemorySink>(10);
    Logger logger;
    REQUIRE(logger.add_sink(sink));
    logger.start();
    bool accepted = true;
    std::thread audio_like([&] {
        rr::rt::ScopedRealtimeThread guard;
        accepted = logger.log(Level::Error, "audio", "should_not_log", "x");
    });
    audio_like.join();
    CHECK_FALSE(rr::rt::is_realtime_thread());  // the guard is per thread
    logger.stop();
    CHECK_FALSE(accepted);
    CHECK(logger.stats().rejected_realtime == 1);
    CHECK(sink->snapshot().empty());
}

TEST_CASE("records after stop() are rejected; sinks cannot be added after start()", "[shared][log]") {
    Logger logger;
    logger.start();
    CHECK_FALSE(logger.add_sink(std::make_shared<MemorySink>(1)));
    logger.stop();
    logger.stop();  // idempotent
    CHECK_FALSE(logger.log(Level::Info, "test", "late", "after stop"));
    CHECK(logger.stats().rejected_stopped == 1);
}

TEST_CASE("many threads can log concurrently", "[shared][log]") {
    auto sink = std::make_shared<MemorySink>(10000);
    Logger logger(10000);
    REQUIRE(logger.add_sink(sink));
    logger.start();
    std::vector<std::thread> threads;
    for (int t = 0; t < 4; ++t) {
        threads.emplace_back([&logger] {
            for (int i = 0; i < 500; ++i) {
                logger.log(Level::Debug, "test", "burst", "x");
            }
        });
    }
    for (auto& th : threads) {
        th.join();
    }
    logger.stop();
    const auto stats = logger.stats();
    CHECK(stats.accepted + stats.dropped_queue_full == 2000);
    CHECK(sink->snapshot().size() == stats.accepted);
}

TEST_CASE("JSON Lines file sink writes one parsable-looking object per line", "[shared][log]") {
    const auto path = std::filesystem::temp_directory_path() / "rr_test_logs" / "log_test.jsonl";
    std::filesystem::remove(path);
    {
        auto file = std::make_shared<rr::log::JsonLinesFileSink>(path);
        REQUIRE(file->ok());
        Logger logger;
        REQUIRE(logger.add_sink(file));
        logger.start();
        logger.log(Level::Info, "app", "startup", "quote \" and backslash \\", {{"role", "producer"}});
        logger.stop();
    }
    std::ifstream in(path);
    std::string line;
    REQUIRE(std::getline(in, line));
    CHECK(line.front() == '{');
    CHECK(line.back() == '}');
    CHECK(line.find("\"event\":\"startup\"") != std::string::npos);
    CHECK(line.find("\"lvl\":\"info\"") != std::string::npos);
    CHECK(line.find("quote \\\" and backslash \\\\") != std::string::npos);
    CHECK(line.find("\"fields\":{\"role\":\"producer\"}") != std::string::npos);
    CHECK_FALSE(std::getline(in, line));
}
