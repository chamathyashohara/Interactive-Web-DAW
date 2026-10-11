// Producer + performer controllers over real loopback TCP, with the TEST RECORDER (no audio).
#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <optional>
#include <thread>
#include <vector>

#include "rr/control/readiness.hpp"
#include "rr/audio/take_naming.hpp"
#include "rr/audio/wav_writer.hpp"
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
    c.received_root = std::filesystem::temp_directory_path() / "rr_tests" / "ctrl_received";  // Stage 11
    c.transfer_resume_wait_ms = 3000;
    c.transfer_sender.retry_interval_ms = 100;
    c.transfer_sender.give_up_after_ms = 3000;
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
    // Both sides mark the take cancelled, so no panel can show a stale "SCHEDULED" row (D-76).
    CHECK(p.performer.snapshot().take.cancelled);
    REQUIRE(p.run_until([&] { return p.producer.snapshot().take.cancelled; }, 2000ms));
    CHECK_FALSE(p.producer.snapshot().take.local_started);
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

TEST_CASE("after a refused join the performer can join again with the right code", "[control]") {
    Pair p;
    std::string error;
    REQUIRE(p.producer.create_session("127.0.0.1", p.port, error));
    const std::string right = p.producer.snapshot().pairing_code;
    const std::string wrong = right == "000000" ? "111111" : "000000";
    REQUIRE(p.performer.join("127.0.0.1", p.port, wrong, error));
    CHECK(p.performer.snapshot().link == LinkState::Connecting);  // never "Disconnected" right after join()
    CHECK_FALSE(p.performer.join("127.0.0.1", p.port, right, error));  // the first attempt is still running
    REQUIRE(p.run_until([&] { return p.performer.snapshot().link == LinkState::Disconnected; }));
    INFO("last_error: " << p.performer.snapshot().last_error);
    CHECK(p.performer.snapshot().last_error.find("pairing") != std::string::npos);
    REQUIRE(p.performer.join("127.0.0.1", p.port, right, error));
    p.producer.set_consent(true);
    p.performer.set_consent(true);
    REQUIRE(p.run_until([&] {
        return p.producer.snapshot().session == SessionState::Ready && p.performer.snapshot().session == SessionState::Ready;
    }));
}

// ---------------------------------------------------------------------------------------------
// Stage 9: coordinated recording state and scheduled start/stop

namespace {

bool has_check(const std::vector<ReadinessCheck>& checks, ReadyItem item, bool ok) {
    for (const auto& c : checks) {
        if (c.item == item) {
            return c.ok == ok;
        }
    }
    return false;
}

rr::net::Frame raw(rr::net::MsgType type, std::uint32_t take) {
    rr::net::Frame f;
    f.type = type;
    f.set_u32(rr::net::Tag::TakeId, take);
    return f;
}

}  // namespace

TEST_CASE("Stage 9: both readiness checklists are complete and the producer sees the performer's", "[control][stage9]") {
    Pair p;
    p.connect_and_ready();
    const auto prod = p.producer.snapshot();
    for (const auto item : {ReadyItem::InputDevice, ReadyItem::EngineHealthy, ReadyItem::FolderWritable,
                            ReadyItem::DiskSpace, ReadyItem::NoActiveRecording, ReadyItem::Consent, ReadyItem::Connected}) {
        INFO(ready_item_id(item));
        CHECK(has_check(prod.local_checks, item, true));
    }
    REQUIRE(p.run_until([&] { return has_check(p.producer.snapshot().peer_checks, ReadyItem::ClockOffset, true); }));
    CHECK(has_check(p.producer.snapshot().peer_checks, ReadyItem::Consent, true));
    CHECK(encode_checks(p.performer.snapshot().local_checks).size() < 256);  // fits one TLV string

    // The performer withdraws consent: the producer sees the item fail and Record is refused.
    p.performer.set_consent(false);
    REQUIRE(p.run_until([&] { return has_check(p.producer.snapshot().peer_checks, ReadyItem::Consent, false); }));
    std::string error;
    CHECK_FALSE(p.producer.start_take(error));
    CHECK(error.find("performer has not consented") != std::string::npos);
    // A local device problem is an item too.
    p.performer.set_consent(true);
    p.performer_port.set_ready(false, "test: input device unplugged");
    REQUIRE(p.run_until([&] { return has_check(p.producer.snapshot().peer_checks, ReadyItem::InputDevice, false); }));
    CHECK_FALSE(p.producer.start_take(error));
}

TEST_CASE("Stage 9: the checklist encoding round-trips and skips unknown items", "[control][stage9]") {
    std::vector<ReadinessCheck> c{{ReadyItem::InputDevice, true, true, ""}, {ReadyItem::DiskSpace, false, true, ""},
                                  {ReadyItem::ClockOffset, true, true, ""}};
    const std::string text = encode_checks(c);
    CHECK(text == "input=1,disk=0,clock=1");
    const auto back = decode_checks(text + ",future_item=1");
    REQUIRE(back.size() == 3);
    CHECK(back[1].item == ReadyItem::DiskSpace);
    CHECK_FALSE(back[1].ok);
    CHECK_FALSE(all_mandatory_ok(back));
}

TEST_CASE("Stage 9: Stop before the start cancels the take on both PCs; nothing is recorded", "[control][stage9]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] {
        return p.producer.snapshot().session == SessionState::Scheduled &&
               p.performer.snapshot().session == SessionState::Scheduled;
    }));
    REQUIRE(p.producer.stop_take(error));  // about 350 ms before the start
    CHECK(p.producer.snapshot().take.cancelled);
    REQUIRE(p.run_until([&] {
        return p.producer.snapshot().session == SessionState::Ready && p.performer.snapshot().session == SessionState::Ready &&
               p.performer.snapshot().take.cancelled;
    }));
    p.run_until([] { return false; }, 600ms);  // past the original start time
    CHECK_FALSE(p.producer.snapshot().take.local_started);
    CHECK_FALSE(p.performer.snapshot().take.local_started);
    // A new take works afterwards.
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] { return p.producer.snapshot().take.peer_started; }));
}

TEST_CASE("Stage 9: Stop during stopping/finalisation is refused and changes nothing", "[control][stage9]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] { return p.producer.snapshot().take.peer_started; }));
    REQUIRE(p.producer.stop_take(error));
    CHECK(p.producer.snapshot().session == SessionState::Stopping);
    std::string again;
    CHECK_FALSE(p.producer.stop_take(again));
    CHECK(again.find("already stopping") != std::string::npos);
    REQUIRE(p.run_until([&] {
        auto a = p.producer.snapshot();
        return a.session == SessionState::Ready && a.take.peer_finalised;
    }));
    CHECK(p.producer.snapshot().take.local_status == rr::TakeStatus::Complete);
    CHECK(p.producer.snapshot().take.peer_status == rr::TakeStatus::Complete);
}

TEST_CASE("Stage 9: a late SCHEDULE_START (start already past) is refused; nothing records", "[control][stage9]") {
    Pair p;
    p.connect_and_ready();
    auto arm = raw(rr::net::MsgType::Arm, 40);
    arm.set_u32(rr::net::Tag::MaxTakeSeconds, 60);
    REQUIRE(p.producer.link()->send(arm));
    REQUIRE(p.run_until([&] { return p.performer.snapshot().session == SessionState::Armed; }));
    auto late = raw(rr::net::MsgType::ScheduleStart, 40);
    late.set_i64(rr::net::Tag::StartAtNs, rr::time::monotonic_ns() - 200'000'000);  // in the past
    REQUIRE(p.producer.link()->send(late));
    REQUIRE(p.run_until([&] { return p.performer.snapshot().session == SessionState::Ready; }));
    p.run_until([] { return false; }, 300ms);
    CHECK_FALSE(p.performer.snapshot().take.local_started);
    CHECK(p.performer.snapshot().refused_messages >= 1);
}

TEST_CASE("Stage 9: a command carrying another session id is refused", "[control][stage9]") {
    Pair p;
    p.connect_and_ready();
    auto arm = raw(rr::net::MsgType::Arm, 41);
    arm.set_u32(rr::net::Tag::MaxTakeSeconds, 60);
    arm.set_str(rr::net::Tag::SessionId, "deadbeef");
    REQUIRE(p.producer.link()->send(arm));
    REQUIRE(p.run_until([&] { return p.performer.snapshot().refused_messages >= 1; }));
    CHECK(p.performer.snapshot().session == SessionState::Ready);
    // The same command with the right session id is accepted.
    arm.set_str(rr::net::Tag::SessionId, p.producer.snapshot().session_id);
    REQUIRE(p.producer.link()->send(arm));
    REQUIRE(p.run_until([&] { return p.performer.snapshot().session == SessionState::Armed; }));
}

TEST_CASE("Stage 9: replayed commands after a completed take start nothing", "[control][stage9]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] { return p.producer.snapshot().take.peer_started; }));
    REQUIRE(p.producer.stop_take(error));
    REQUIRE(p.run_until([&] {
        return p.producer.snapshot().session == SessionState::Ready && p.performer.snapshot().session == SessionState::Ready;
    }));
    const std::uint32_t take = p.producer.snapshot().take.take_id;
    const auto before = p.performer.snapshot();
    auto arm = raw(rr::net::MsgType::Arm, take);
    arm.set_u32(rr::net::Tag::MaxTakeSeconds, 60);
    auto sched = raw(rr::net::MsgType::ScheduleStart, take);
    sched.set_i64(rr::net::Tag::StartAtNs, rr::time::monotonic_ns() + 500'000'000);
    REQUIRE(p.producer.link()->send(arm));
    REQUIRE(p.producer.link()->send(sched));
    REQUIRE(p.run_until([&] {
        auto s = p.performer.snapshot();
        return s.refused_messages >= before.refused_messages + 2;
    }));
    p.run_until([] { return false; }, 700ms);
    CHECK(p.performer.snapshot().session == SessionState::Ready);
    CHECK(p.performer.snapshot().take.take_id == take);  // still the old, completed take
}

TEST_CASE("Stage 9: a CANCEL that crosses the start stops and saves the performer's take", "[control][stage9]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] { return p.performer.snapshot().session == SessionState::Recording; }));
    auto cancel = raw(rr::net::MsgType::Cancel, p.producer.snapshot().take.take_id);
    cancel.set_u16(rr::net::Tag::ErrorCode, static_cast<std::uint16_t>(rr::ErrorCode::Cancelled));
    REQUIRE(p.producer.link()->send(cancel));
    REQUIRE(p.run_until([&] { return p.producer.snapshot().take.peer_finalised; }));
    CHECK(p.producer.snapshot().take.peer_status == rr::TakeStatus::Complete);
    REQUIRE(p.producer.stop_take(error));
    REQUIRE(p.run_until([&] { return p.producer.snapshot().session == SessionState::Ready; }));
}

TEST_CASE("Stage 9: the scheduling lead has a measured minimum", "[control][stage9]") {
    Pair p;
    p.connect_and_ready();
    REQUIRE(p.run_until([&] { return p.producer.snapshot().link_stats.control_rtt_ns > 0; }));
    p.producer.set_start_lead_ms(100);  // clamped to 300, still below 100 + 200 + 2 RTT + 2 u
    CHECK(p.producer.snapshot().start_lead_ms == 300);
    CHECK(p.producer.min_start_lead_ms() > 300);
    std::string error;
    CHECK_FALSE(p.producer.start_take(error));
    CHECK(error.find("start lead") != std::string::npos);
    CHECK(p.producer.snapshot().session == SessionState::Ready);
    p.producer.set_start_lead_ms(600);
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] { return p.producer.snapshot().take.peer_started; }));
}

TEST_CASE("Stage 9: the timing record is complete and ordered on both PCs", "[control][stage9]") {
    Pair p;
    p.connect_and_ready();
    std::string error;
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] { return p.producer.snapshot().take.peer_started; }));
    REQUIRE(p.producer.stop_take(error));
    REQUIRE(p.run_until([&] {
        return p.producer.snapshot().session == SessionState::Ready && p.performer.snapshot().session == SessionState::Ready;
    }));
    const TakeView a = p.producer.snapshot().take;
    CHECK(a.arm_sent_ns > 0);
    CHECK(a.arm_sent_ns <= a.arm_ack_rx_ns);
    CHECK(a.arm_ack_rx_ns <= a.schedule_sent_ns);
    CHECK(a.schedule_sent_ns <= a.start_ack_rx_ns);
    CHECK(a.start_ack_rx_ns < a.start_at_local_ns);  // acknowledged before the start
    CHECK(a.local_first_sample_ns >= a.start_at_local_ns);
    CHECK(a.peer_started_rx_ns >= a.start_at_local_ns);
    CHECK(a.stop_cmd_ns <= a.stop_at_local_ns);
    CHECK(a.stop_at_local_ns <= a.local_finalised_ns);
    CHECK(a.peer_finalised_rx_ns > 0);
    CHECK(a.start_lead_ms == 400);
    CHECK(a.offset_samples > 0);
    const TakeView b = p.performer.snapshot().take;
    CHECK(b.arm_rx_ns > 0);
    CHECK(b.arm_rx_ns <= b.schedule_rx_ns);
    CHECK(b.schedule_rx_ns <= b.start_ack_sent_ns);
    CHECK(b.start_ack_sent_ns < b.start_at_local_ns);
    CHECK(b.stop_cmd_ns > b.start_at_local_ns);
    CHECK(b.local_finalised_ns >= b.stop_at_local_ns);
}

// ---------------------------------------------------------------------------------------------
// Stage 11: take transfer through the session controllers (control link + transfer connection).
// The TEST RECORDER writes nothing; test_report_file() writes a real WAV (synthetic, silent-free
// counter signal) with exactly the frames the test recorder reports, as the performer's "take".

namespace {

std::atomic<std::uint16_t> g_xfer_port{53611};

std::vector<char> bytes_of(const std::filesystem::path& p) {
    std::ifstream in(p, std::ios::binary);
    return std::vector<char>((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

struct XferPair : Pair {
    std::filesystem::path perf_dir = std::filesystem::temp_directory_path() / "rr_tests" /
                                     ("ctrl_perf_" + rr::audio::make_session_id());
    std::filesystem::path last_file;

    XferPair() {
        port = static_cast<std::uint16_t>(g_xfer_port.fetch_add(3));  // control, media, transfer
        std::filesystem::create_directories(perf_dir);
        performer_port.test_report_file([this](std::uint32_t take, std::uint64_t frames) {
            rr::audio::WavWriter w;
            rr::audio::WavFormat fmt;
            last_file = perf_dir / ("take" + std::to_string(take) + "_test.wav");
            if (w.open(last_file, fmt)) {
                std::vector<float> v(static_cast<std::size_t>(frames));
                for (std::size_t i = 0; i < v.size(); ++i) {
                    v[i] = 0.001f + static_cast<float>(i % 997) / 1000.0f;
                }
                w.write_frames(v.data(), frames);
                w.finalise();
            }
            return last_file;
        });
    }

    void record_one_take() {
        std::string error;
        REQUIRE(producer.start_take(error));
        REQUIRE(run_until([&] { return performer.snapshot().session == SessionState::Recording; }));
        run_until([] { return false; }, 300ms);
        REQUIRE(producer.stop_take(error));
        REQUIRE(run_until([&] {
            auto a = producer.snapshot();
            return a.session == SessionState::Ready && a.take.peer_finalised &&
                   performer.snapshot().session == SessionState::Ready;
        }));
    }

    static std::optional<rr::xfer::TransferView> view(const ControllerSnapshot& s, std::uint32_t take) {
        for (const auto& v : s.transfers) {
            if (v.take_id == take) {
                return v;
            }
        }
        return std::nullopt;
    }

    bool ended(SessionController& c, std::uint32_t take) {
        const auto v = view(c.snapshot(), take);
        return v && rr::xfer::transfer_state_final(v->state);
    }
};

}  // namespace

TEST_CASE("Stage 11: one producer request gives a VERIFIED copy; the performer's original is unchanged", "[control][stage11]") {
    XferPair p;
    p.connect_and_ready();
    p.performer.set_delivery_consent(true);
    REQUIRE(p.run_until([&] { return p.producer.snapshot().peer_delivery_consent; }));
    p.record_one_take();
    const auto original = bytes_of(p.last_file);
    REQUIRE(original.size() > 44);
    std::string error;
    REQUIRE(p.producer.request_transfer(1, error));
    CHECK(p.producer.snapshot().protocol_minor == 2);
    REQUIRE(p.run_until([&] { return p.ended(p.producer, 1) && p.ended(p.performer, 1); }, 10000ms));
    const auto prod = *XferPair::view(p.producer.snapshot(), 1);
    const auto perf = *XferPair::view(p.performer.snapshot(), 1);
    CHECK(prod.state == rr::xfer::TransferState::Verified);
    CHECK(perf.state == rr::xfer::TransferState::Verified);
    CHECK(prod.frames == p.producer.snapshot().take.peer_frames);
    CHECK(prod.frames_vs_report == "match");
    CHECK(perf.source_unchanged);
    CHECK(bytes_of(std::filesystem::u8path(prod.file)) == original);
    CHECK(bytes_of(p.last_file) == original);
    // Record works again once the transfer has ended.
    REQUIRE(p.run_until([&] { return p.producer.snapshot().session == SessionState::Ready; }));
}

TEST_CASE("Stage 11: without the performer's delivery consent the request is refused", "[control][stage11]") {
    XferPair p;
    p.connect_and_ready();
    p.record_one_take();
    std::string error;
    REQUIRE(p.producer.request_transfer(1, error));
    REQUIRE(p.run_until([&] { return p.ended(p.producer, 1); }));
    const auto prod = *XferPair::view(p.producer.snapshot(), 1);
    CHECK(prod.state == rr::xfer::TransferState::Failed);
    CHECK(prod.detail.find("performer refused") != std::string::npos);
    CHECK(p.performer.snapshot().transfers.empty());
}

TEST_CASE("Stage 11: requests are refused before TAKE_FINALISED and while recording; a transfer blocks Record", "[control][stage11]") {
    XferPair p;
    p.connect_and_ready();
    p.performer.set_delivery_consent(true);
    std::string error;
    CHECK_FALSE(p.producer.request_transfer(1, error));  // no take yet
    CHECK(error.find("not been reported finalised") != std::string::npos);
    REQUIRE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] { return p.producer.snapshot().session == SessionState::Recording; }));
    CHECK_FALSE(p.producer.request_transfer(1, error));
    CHECK(error.find("being recorded") != std::string::npos);
    REQUIRE(p.producer.stop_take(error));
    REQUIRE(p.run_until([&] {
        return p.producer.snapshot().session == SessionState::Ready && p.producer.snapshot().take.peer_finalised;
    }));
    REQUIRE(p.producer.request_transfer(1, error));
    CHECK_FALSE(p.producer.request_transfer(1, error));  // duplicate while queued
    p.producer.poll();  // the performer has not seen the request yet: the transfer is QUEUED
    CHECK(p.producer.snapshot().session == SessionState::NotReady);
    CHECK_FALSE(p.producer.start_take(error));
    REQUIRE(p.run_until([&] { return p.ended(p.producer, 1); }, 10000ms));
    REQUIRE(p.run_until([&] { return p.producer.snapshot().session == SessionState::Ready; }));
}

TEST_CASE("Stage 11: automatic transfer after each take", "[control][stage11]") {
    XferPair p;
    p.producer.set_auto_transfer(true);
    p.connect_and_ready();
    p.performer.set_delivery_consent(true);
    p.record_one_take();
    REQUIRE(p.run_until([&] { return p.ended(p.producer, 1); }, 10000ms));
    CHECK(XferPair::view(p.producer.snapshot(), 1)->state == rr::xfer::TransferState::Verified);
    REQUIRE(p.run_until([&] { return p.producer.snapshot().session == SessionState::Ready; }));
    p.record_one_take();
    REQUIRE(p.run_until([&] { return p.ended(p.producer, 2); }, 10000ms));
    CHECK(XferPair::view(p.producer.snapshot(), 2)->state == rr::xfer::TransferState::Verified);
}
