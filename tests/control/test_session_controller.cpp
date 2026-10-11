// Producer + performer controllers over real loopback TCP, with the TEST RECORDER (no audio).
#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <functional>
#include <thread>

#include "rr/control/session_controller.hpp"
#include "rr/shared/clock.hpp"

using namespace rr::control;
using rr::session::LinkState;
using rr::session::SessionState;
using namespace std::chrono_literals;

namespace {

std::atomic<std::uint16_t> g_port{52811};

ControllerConfig config(rr::Role role) {
    ControllerConfig c;
    c.role = role;
    c.app_version = "test";
    c.display_name = role == rr::Role::Producer ? "Producer" : "Performer";
    c.timing.start_lead_ms = 400;
    c.timing.arm_ack_margin_ms = 100;
    c.timing.stop_lead_ms = 100;
    c.timing.finalise_report_wait_ms = 1500;
    c.link.heartbeat_interval_ms = 50;
    c.link.link_lost_after_ms = 400;
    c.link.reconnect_interval_ms = 100;
    c.link.connect_timeout_ms = 1000;
    c.link.handshake_timeout_ms = 1000;
    c.arm_to_schedule_timeout_ms = 1500;
    c.status_interval_ms = 200;
    return c;
}

struct Pair {
    rr::log::Logger log{100000};
    TestRecorderPort producer_port;
    TestRecorderPort performer_port;
    SessionController producer{config(rr::Role::Producer), producer_port, log};
    SessionController performer{config(rr::Role::Performer), performer_port, log};
    std::uint16_t port = g_port++;

    bool run_until(const std::function<bool()>& pred, std::chrono::milliseconds timeout = 4000ms) {
        const auto end = std::chrono::steady_clock::now() + timeout;
        while (std::chrono::steady_clock::now() < end) {
            producer.poll();
            performer.poll();
            if (pred()) {
                return true;
            }
            std::this_thread::sleep_for(5ms);
        }
        return pred();
    }

    void connect_and_ready(bool performer_consent = true) {
        std::string error;
        REQUIRE(producer.create_session("127.0.0.1", port, error));
        REQUIRE(performer.join("127.0.0.1", port, producer.snapshot().pairing_code, error));
        producer.set_consent(true);
        performer.set_consent(performer_consent);
        REQUIRE(run_until([&] {
            return producer.snapshot().link == LinkState::Connected && performer.snapshot().link == LinkState::Connected;
        }));
        if (performer_consent) {
            REQUIRE(run_until([&] {
                return producer.snapshot().session == SessionState::Ready && performer.snapshot().session == SessionState::Ready;
            }));
        }
    }
};

}  // namespace

TEST_CASE("a full take: every performer step is visible only after its own message", "[control]") {
    Pair p;
    p.connect_and_ready();
    CHECK(p.performer.snapshot().session_id == p.producer.snapshot().session_id);
    std::string error;
    REQUIRE(p.producer.start_take(error));
    auto s = p.producer.snapshot();
    CHECK(s.session == SessionState::Armed);
    CHECK(s.take.arm_sent);
    CHECK_FALSE(s.take.peer_arm_ack);  // sending ARM proves nothing
    CHECK_FALSE(s.take.peer_started);

    REQUIRE(p.run_until([&] {
        return p.producer.snapshot().session == SessionState::Recording &&
               p.performer.snapshot().session == SessionState::Recording && p.producer.snapshot().take.peer_started;
    }));
    s = p.producer.snapshot();
    CHECK(s.take.peer_arm_ack);
    CHECK(s.take.peer_start_ack);
    CHECK(s.take.local_started);
    CHECK(s.take.has_start_offset);
    CHECK(std::abs(s.take.start_offset_ms) < 20.0);  // same PC, test recorder: start times agree

    REQUIRE(p.producer.stop_take(error));
    REQUIRE(p.run_until([&] {
        auto a = p.producer.snapshot();
        return a.session == SessionState::Ready && a.take.peer_finalised && a.take.local_finalised &&
               p.performer.snapshot().session == SessionState::Ready;
    }));
    s = p.producer.snapshot();
    CHECK(s.take.peer_stop_ack);
    CHECK(s.take.peer_status == rr::TakeStatus::Complete);
    CHECK(s.take.local_status == rr::TakeStatus::Complete);
    CHECK(s.invalid_events == 0);
}

TEST_CASE("a performer without consent refuses ARM and nothing records", "[control]") {
    Pair p;
    p.connect_and_ready(/*performer_consent=*/false);
    REQUIRE(p.run_until([&] { return p.producer.snapshot().not_ready_reasons.size() > 0; }));
    std::string error;
    CHECK_FALSE(p.producer.start_take(error));  // the producer already knows the performer is not ready
    CHECK(error.find("performer has not consented") != std::string::npos);
    // Bypass the producer's own check: a raw ARM straight onto the wire is refused by the performer.
    rr::net::Frame arm;
    arm.type = rr::net::MsgType::Arm;
    arm.set_u32(rr::net::Tag::TakeId, 7);
    arm.set_u32(rr::net::Tag::MaxTakeSeconds, 60);
    REQUIRE(p.producer.link()->send(arm));
    REQUIRE(p.run_until([&] { return p.performer.snapshot().refused_messages >= 1; }));
    CHECK(p.performer.snapshot().session == SessionState::NotReady);
    CHECK_FALSE(p.performer.snapshot().take.local_started);
}

TEST_CASE("duplicate, stale and unknown-take messages never start or stop a second recording", "[control]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] { return p.performer.snapshot().session == SessionState::Recording; }));
    const std::uint32_t take = p.producer.snapshot().take.take_id;

    // Duplicate SCHEDULE_START for the running take, stale ARM with the same id, STOP for a take
    // that does not exist.
    rr::net::Frame dup;
    dup.type = rr::net::MsgType::ScheduleStart;
    dup.set_u32(rr::net::Tag::TakeId, take);
    dup.set_i64(rr::net::Tag::StartAtNs, rr::time::monotonic_ns() + 500'000'000);
    rr::net::Frame stale_arm;
    stale_arm.type = rr::net::MsgType::Arm;
    stale_arm.set_u32(rr::net::Tag::TakeId, take);
    stale_arm.set_u32(rr::net::Tag::MaxTakeSeconds, 60);
    rr::net::Frame bad_stop;
    bad_stop.type = rr::net::MsgType::StopSchedule;
    bad_stop.set_u32(rr::net::Tag::TakeId, take + 50);
    bad_stop.set_i64(rr::net::Tag::StopAtNs, rr::time::monotonic_ns());
    REQUIRE(p.producer.link()->send(dup));
    REQUIRE(p.producer.link()->send(stale_arm));
    REQUIRE(p.producer.link()->send(bad_stop));
    REQUIRE(p.run_until([&] {
        auto s = p.performer.snapshot();
        return s.duplicate_messages >= 2 && s.refused_messages >= 2;
    }));
    CHECK(p.performer.snapshot().session == SessionState::Recording);  // unaffected
    CHECK(p.producer.snapshot().session == SessionState::Recording);

    // Duplicate STOP after the real one is answered idempotently and changes nothing.
    REQUIRE(p.producer.stop_take(error));
    rr::net::Frame dup_stop;
    dup_stop.type = rr::net::MsgType::StopSchedule;
    dup_stop.set_u32(rr::net::Tag::TakeId, take);
    dup_stop.set_i64(rr::net::Tag::StopAtNs, rr::time::monotonic_ns());
    REQUIRE(p.producer.link()->send(dup_stop));
    REQUIRE(p.run_until([&] {
        return p.producer.snapshot().session == SessionState::Ready && p.performer.snapshot().session == SessionState::Ready;
    }));
    CHECK(p.producer.snapshot().take.peer_status == rr::TakeStatus::Complete);
}

TEST_CASE("losing the link while recording keeps both recordings going; stop works after reconnecting", "[control]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] {
        return p.producer.snapshot().session == SessionState::Recording &&
               p.performer.snapshot().session == SessionState::Recording;
    }));
    p.performer.link()->test_drop_connection();
    REQUIRE(p.run_until([&] { return p.performer.snapshot().link == LinkState::LinkLost; }, 2000ms));
    CHECK(p.performer.snapshot().session == SessionState::Recording);
    REQUIRE(p.run_until([&] { return p.producer.snapshot().link == LinkState::Connected && p.performer.snapshot().link == LinkState::Connected; }));
    CHECK(p.producer.snapshot().session == SessionState::Recording);
    REQUIRE(p.producer.stop_take(error));
    REQUIRE(p.run_until([&] {
        auto a = p.producer.snapshot();
        return a.session == SessionState::Ready && a.take.peer_finalised;
    }));
    CHECK(p.producer.snapshot().take.peer_status == rr::TakeStatus::Complete);
}

TEST_CASE("losing the link before the scheduled start cancels the take on both sides", "[control]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] {
        return p.producer.snapshot().session == SessionState::Scheduled &&
               p.performer.snapshot().session == SessionState::Scheduled;
    }));
    p.performer.link()->test_drop_connection();
    REQUIRE(p.run_until([&] {
        return p.performer.snapshot().session == SessionState::NotReady ||
               p.performer.snapshot().session == SessionState::Ready;
    }, 2000ms));
    // Give the original start time a chance to pass: no recording may start.
    p.run_until([] { return false; }, 700ms);
    CHECK_FALSE(p.performer.snapshot().take.local_started);
    CHECK(p.performer.snapshot().session != SessionState::Recording);
}

TEST_CASE("the performer's own Stop & save is reported to the producer", "[control]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] { return p.performer.snapshot().session == SessionState::Recording; }));
    REQUIRE(p.performer.stop_and_save(error));
    REQUIRE(p.run_until([&] { return p.producer.snapshot().take.peer_finalised; }));
    CHECK(p.producer.snapshot().session == SessionState::Recording);  // the producer keeps recording
    REQUIRE(p.producer.stop_take(error));
    REQUIRE(p.run_until([&] { return p.producer.snapshot().session == SessionState::Ready; }));
}

TEST_CASE("invalid user actions are refused without changing state", "[control]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    CHECK_FALSE(p.performer.start_take(error));  // SES-08
    CHECK_FALSE(p.producer.stop_take(error));    // nothing recording
    CHECK_FALSE(p.performer.stop_and_save(error));
    CHECK(p.producer.snapshot().session == SessionState::Ready);
    CHECK(p.performer.snapshot().session == SessionState::Ready);
}

TEST_CASE("a local recorder fault on the producer ends the performer's take too", "[control]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] {
        return p.producer.snapshot().session == SessionState::Recording &&
               p.performer.snapshot().session == SessionState::Recording;
    }));
    p.producer_port.simulate_fault();
    REQUIRE(p.run_until([&] {
        auto a = p.producer.snapshot();
        return a.session == SessionState::Ready && a.take.peer_finalised;
    }));
    CHECK(p.producer.snapshot().take.local_status == rr::TakeStatus::IncompleteDevice);
    CHECK(p.producer.snapshot().take.peer_status == rr::TakeStatus::Complete);
}

TEST_CASE("a Stop pressed while the link is down is re-sent when the performer reconnects", "[control]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] {
        return p.producer.snapshot().session == SessionState::Recording &&
               p.performer.snapshot().session == SessionState::Recording;
    }));
    p.performer.link()->test_drop_connection();
    // Press Stop the moment the producer sees the link go down (before the performer is back).
    bool stopped = false;
    REQUIRE(p.run_until([&] {
        if (!stopped && p.producer.snapshot().link != LinkState::Connected) {
            stopped = p.producer.stop_take(error);
        }
        return stopped;
    }, 2000ms));
    REQUIRE(p.run_until([&] {
        auto a = p.producer.snapshot();
        return a.take.peer_finalised && a.take.local_finalised && p.performer.snapshot().take.local_finalised;
    }, 6000ms));
    CHECK(p.performer.snapshot().session != SessionState::Recording);
    CHECK(p.producer.snapshot().take.peer_status == rr::TakeStatus::Complete);
    CHECK_FALSE(p.producer.snapshot().take.peer_report_timed_out);
}

TEST_CASE("the performer stops and saves its take when the producer closes the session mid-take", "[control]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] { return p.performer.snapshot().session == SessionState::Recording; }));
    p.producer.shutdown();
    const bool ended = p.run_until([&] {
        auto s = p.performer.snapshot();
        return s.link == LinkState::Disconnected && s.take.local_finalised;
    });
    if (!ended) {
        for (const auto& line : p.performer.take_history()) {
            UNSCOPED_INFO(line);
        }
    }
    REQUIRE(ended);
    CHECK(p.performer.snapshot().session != SessionState::Recording);
    CHECK(p.performer.snapshot().take.local_status == rr::TakeStatus::Complete);
}
