// Producer + performer controllers over real loopback TCP, with the TEST RECORDER (no audio).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <functional>
#include <optional>
#include <thread>
#include <vector>

#include "rr/control/Readiness.h"
#include "rr/audio/TakeNaming.h"
#include "rr/audio/WavWriter.h"
#include "rr/control/SessionController.h"
#include "rr/shared/Clock.h"

using namespace std::chrono_literals;

namespace
{

std::atomic<uint16_t> gPort{52811};

ControllerConfig config(Role role)
{
    ControllerConfig c;
    c.role = role;
    c.appVersion = "test";
    c.displayName = role == Role::Producer ? "Producer" : "Performer";
    c.timing.startLeadMs = 400;
    // Stage 12: the existing timing tests assert exact leads, so they pin it by hand. The
    // automatic choice has tests of its own below.
    c.timing.autoStartLead = false;
    c.timing.armAckMarginMs = 100;
    c.timing.stopLeadMs = 100;
    c.timing.finaliseReportWaitMs = 1500;
    c.link.heartbeatIntervalMs = 50;
    c.link.linkLostAfterMs = 400;
    c.link.reconnectIntervalMs = 100;
    c.link.connectTimeoutMs = 1000;
    c.link.handshakeTimeoutMs = 1000;
    c.armToScheduleTimeoutMs = 1500;
    c.statusIntervalMs = 200;
    c.receivedRoot = std::filesystem::temp_directory_path() / "rr_tests" / "ctrl_received";  // Stage 11
    c.transferResumeWaitMs = 3000;
    c.transferSender.retryIntervalMs = 100;
    c.transferSender.giveUpAfterMs = 3000;
    return c;
}

struct Pair
{
    Logger log{100000};
    TestRecorderPort producerPort;
    TestRecorderPort performerPort;
    SessionController producer{config(Role::Producer), producerPort, log};
    SessionController performer{config(Role::Performer), performerPort, log};
    uint16_t port = gPort++;

    bool runUntil(const std::function<bool()>& pred, std::chrono::milliseconds timeout = 4000ms)
    {
        const auto end = std::chrono::steady_clock::now() + timeout;
        while (std::chrono::steady_clock::now() < end)
        {
            producer.poll();
            performer.poll();
            if (pred())
            {
                return true;
            }
            std::this_thread::sleep_for(5ms);
        }
        return pred();
    }

    void connectAndReady(bool performerConsent = true)
    {
        std::string error;
        REQUIRE(producer.createSession("127.0.0.1", port, error));
        REQUIRE(performer.join("127.0.0.1", port, producer.snapshot().pairingCode, error));
        producer.setConsent(true);
        performer.setConsent(performerConsent);
        REQUIRE(runUntil([&] {
            return producer.snapshot().link == LinkState::Connected && performer.snapshot().link == LinkState::Connected;
        }));
        if (performerConsent)
        {
            REQUIRE(runUntil([&] {
                return producer.snapshot().session == SessionState::Ready && performer.snapshot().session == SessionState::Ready;
            }));
        }
    }
};

}  // namespace

TEST_CASE("a full take: every performer step is visible only after its own message", "[control]")
{
    Pair p;
    p.connectAndReady();
    CHECK(p.performer.snapshot().sessionId == p.producer.snapshot().sessionId);
    std::string error;
    REQUIRE(p.producer.startTake(error));
    auto s = p.producer.snapshot();
    CHECK(s.session == SessionState::Armed);
    CHECK(s.take.armSent);
    CHECK_FALSE(s.take.peerArmAck);  // sending ARM proves nothing
    CHECK_FALSE(s.take.peerStarted);

    REQUIRE(p.runUntil([&] {
        return p.producer.snapshot().session == SessionState::Recording &&
               p.performer.snapshot().session == SessionState::Recording && p.producer.snapshot().take.peerStarted;
    }));
    s = p.producer.snapshot();
    CHECK(s.take.peerArmAck);
    CHECK(s.take.peerStartAck);
    CHECK(s.take.localStarted);
    CHECK(s.take.hasStartOffset);
    CHECK(std::abs(s.take.startOffsetMs) < 20.0);  // same PC, test recorder: start times agree

    REQUIRE(p.producer.stopTake(error));
    REQUIRE(p.runUntil([&] {
        auto a = p.producer.snapshot();
        return a.session == SessionState::Ready && a.take.peerFinalised && a.take.localFinalised &&
               p.performer.snapshot().session == SessionState::Ready;
    }));
    s = p.producer.snapshot();
    CHECK(s.take.peerStopAck);
    CHECK(s.take.peerStatus == TakeStatus::Complete);
    CHECK(s.take.localStatus == TakeStatus::Complete);
    CHECK(s.invalidEvents == 0);
}

TEST_CASE("a performer without consent refuses ARM and nothing records", "[control]")
{
    Pair p;
    p.connectAndReady(/*performerConsent=*/false);
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().notReadyReasons.size() > 0; }));
    std::string error;
    CHECK_FALSE(p.producer.startTake(error));  // the producer already knows the performer is not ready
    CHECK(error.find("performer has not consented") != std::string::npos);
    // Bypass the producer's own check: a raw ARM straight onto the wire is refused by the performer.
    Frame arm;
    arm.type = MsgType::Arm;
    arm.setU32(Tag::TakeId, 7);
    arm.setU32(Tag::MaxTakeSeconds, 60);
    REQUIRE(p.producer.getLink()->send(arm));
    REQUIRE(p.runUntil([&] { return p.performer.snapshot().refusedMessages >= 1; }));
    CHECK(p.performer.snapshot().session == SessionState::NotReady);
    CHECK_FALSE(p.performer.snapshot().take.localStarted);
}

TEST_CASE("duplicate, stale and unknown-take messages never start or stop a second recording", "[control]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] { return p.performer.snapshot().session == SessionState::Recording; }));
    const uint32_t take = p.producer.snapshot().take.takeId;

    // Duplicate SCHEDULE_START for the running take, stale ARM with the same id, STOP for a take
    // that does not exist.
    Frame dup;
    dup.type = MsgType::ScheduleStart;
    dup.setU32(Tag::TakeId, take);
    dup.setI64(Tag::StartAtNs, monotonicNs() + 500'000'000);
    Frame staleArm;
    staleArm.type = MsgType::Arm;
    staleArm.setU32(Tag::TakeId, take);
    staleArm.setU32(Tag::MaxTakeSeconds, 60);
    Frame badStop;
    badStop.type = MsgType::StopSchedule;
    badStop.setU32(Tag::TakeId, take + 50);
    badStop.setI64(Tag::StopAtNs, monotonicNs());
    REQUIRE(p.producer.getLink()->send(dup));
    REQUIRE(p.producer.getLink()->send(staleArm));
    REQUIRE(p.producer.getLink()->send(badStop));
    REQUIRE(p.runUntil([&] {
        auto s = p.performer.snapshot();
        return s.duplicateMessages >= 2 && s.refusedMessages >= 2;
    }));
    CHECK(p.performer.snapshot().session == SessionState::Recording);  // unaffected
    CHECK(p.producer.snapshot().session == SessionState::Recording);

    // Duplicate STOP after the real one is answered idempotently and changes nothing.
    REQUIRE(p.producer.stopTake(error));
    Frame dupStop;
    dupStop.type = MsgType::StopSchedule;
    dupStop.setU32(Tag::TakeId, take);
    dupStop.setI64(Tag::StopAtNs, monotonicNs());
    REQUIRE(p.producer.getLink()->send(dupStop));
    REQUIRE(p.runUntil([&] {
        return p.producer.snapshot().session == SessionState::Ready && p.performer.snapshot().session == SessionState::Ready;
    }));
    CHECK(p.producer.snapshot().take.peerStatus == TakeStatus::Complete);
}

TEST_CASE("losing the link while recording keeps both recordings going; stop works after reconnecting", "[control]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] {
        return p.producer.snapshot().session == SessionState::Recording &&
               p.performer.snapshot().session == SessionState::Recording;
    }));
    p.performer.getLink()->testDropConnection();
    REQUIRE(p.runUntil([&] { return p.performer.snapshot().link == LinkState::LinkLost; }, 2000ms));
    CHECK(p.performer.snapshot().session == SessionState::Recording);
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().link == LinkState::Connected && p.performer.snapshot().link == LinkState::Connected; }));
    CHECK(p.producer.snapshot().session == SessionState::Recording);
    REQUIRE(p.producer.stopTake(error));
    REQUIRE(p.runUntil([&] {
        auto a = p.producer.snapshot();
        return a.session == SessionState::Ready && a.take.peerFinalised;
    }));
    CHECK(p.producer.snapshot().take.peerStatus == TakeStatus::Complete);
}

TEST_CASE("losing the link before the scheduled start cancels the take on both sides", "[control]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] {
        return p.producer.snapshot().session == SessionState::Scheduled &&
               p.performer.snapshot().session == SessionState::Scheduled;
    }));
    p.performer.getLink()->testDropConnection();
    REQUIRE(p.runUntil([&] {
        return p.performer.snapshot().session == SessionState::NotReady ||
               p.performer.snapshot().session == SessionState::Ready;
    }, 2000ms));
    // Give the original start time a chance to pass: no recording may start.
    p.runUntil([] { return false; }, 700ms);
    CHECK_FALSE(p.performer.snapshot().take.localStarted);
    CHECK(p.performer.snapshot().session != SessionState::Recording);
    // Both sides mark the take cancelled, so no panel can show a stale "SCHEDULED" row (D-76).
    CHECK(p.performer.snapshot().take.cancelled);
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().take.cancelled; }, 2000ms));
    CHECK_FALSE(p.producer.snapshot().take.localStarted);
}

TEST_CASE("the performer's own Stop & save is reported to the producer", "[control]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] { return p.performer.snapshot().session == SessionState::Recording; }));
    REQUIRE(p.performer.stopAndSave(error));
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().take.peerFinalised; }));
    CHECK(p.producer.snapshot().session == SessionState::Recording);  // the producer keeps recording
    REQUIRE(p.producer.stopTake(error));
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().session == SessionState::Ready; }));
}

TEST_CASE("invalid user actions are refused without changing state", "[control]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    CHECK_FALSE(p.performer.startTake(error));  // SES-08
    CHECK_FALSE(p.producer.stopTake(error));    // nothing recording
    CHECK_FALSE(p.performer.stopAndSave(error));
    CHECK(p.producer.snapshot().session == SessionState::Ready);
    CHECK(p.performer.snapshot().session == SessionState::Ready);
}

TEST_CASE("a local recorder fault on the producer ends the performer's take too", "[control]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] {
        return p.producer.snapshot().session == SessionState::Recording &&
               p.performer.snapshot().session == SessionState::Recording;
    }));
    p.producerPort.simulateFault();
    REQUIRE(p.runUntil([&] {
        auto a = p.producer.snapshot();
        return a.session == SessionState::Ready && a.take.peerFinalised;
    }));
    CHECK(p.producer.snapshot().take.localStatus == TakeStatus::IncompleteDevice);
    CHECK(p.producer.snapshot().take.peerStatus == TakeStatus::Complete);
}

TEST_CASE("a Stop pressed while the link is down is re-sent when the performer reconnects", "[control]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] {
        return p.producer.snapshot().session == SessionState::Recording &&
               p.performer.snapshot().session == SessionState::Recording;
    }));
    p.performer.getLink()->testDropConnection();
    // Press Stop the moment the producer sees the link go down (before the performer is back).
    bool stopped = false;
    REQUIRE(p.runUntil([&] {
        if (!stopped && p.producer.snapshot().link != LinkState::Connected)
        {
            stopped = p.producer.stopTake(error);
        }
        return stopped;
    }, 2000ms));
    REQUIRE(p.runUntil([&] {
        auto a = p.producer.snapshot();
        return a.take.peerFinalised && a.take.localFinalised && p.performer.snapshot().take.localFinalised;
    }, 6000ms));
    CHECK(p.performer.snapshot().session != SessionState::Recording);
    CHECK(p.producer.snapshot().take.peerStatus == TakeStatus::Complete);
    CHECK_FALSE(p.producer.snapshot().take.peerReportTimedOut);
}

TEST_CASE("the performer stops and saves its take when the producer closes the session mid-take", "[control]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] { return p.performer.snapshot().session == SessionState::Recording; }));
    p.producer.shutdown();
    const bool ended = p.runUntil([&] {
        auto s = p.performer.snapshot();
        return s.link == LinkState::Disconnected && s.take.localFinalised;
    });
    if (!ended)
    {
        for (const auto& line : p.performer.takeHistory())
        {
            UNSCOPED_INFO(line);
        }
    }
    REQUIRE(ended);
    CHECK(p.performer.snapshot().session != SessionState::Recording);
    CHECK(p.performer.snapshot().take.localStatus == TakeStatus::Complete);
}

TEST_CASE("after a refused join the performer can join again with the right code", "[control]")
{
    Pair p;
    std::string error;
    REQUIRE(p.producer.createSession("127.0.0.1", p.port, error));
    const std::string right = p.producer.snapshot().pairingCode;
    const std::string wrong = right == "000000" ? "111111" : "000000";
    REQUIRE(p.performer.join("127.0.0.1", p.port, wrong, error));
    CHECK(p.performer.snapshot().link == LinkState::Connecting);  // never "Disconnected" right after join()
    CHECK_FALSE(p.performer.join("127.0.0.1", p.port, right, error));  // the first attempt is still running
    REQUIRE(p.runUntil([&] { return p.performer.snapshot().link == LinkState::Disconnected; }));
    INFO("last_error: " << p.performer.snapshot().lastError);
    CHECK(p.performer.snapshot().lastError.find("pairing") != std::string::npos);
    REQUIRE(p.performer.join("127.0.0.1", p.port, right, error));
    p.producer.setConsent(true);
    p.performer.setConsent(true);
    REQUIRE(p.runUntil([&] {
        return p.producer.snapshot().session == SessionState::Ready && p.performer.snapshot().session == SessionState::Ready;
    }));
}

// ---------------------------------------------------------------------------------------------
// Stage 9: coordinated recording state and scheduled start/stop

namespace
{

bool hasCheck(const std::vector<ReadinessCheck>& checks, ReadyItem item, bool ok)
{
    for (const auto& c : checks)
    {
        if (c.item == item)
        {
            return c.ok == ok;
        }
    }
    return false;
}

Frame raw(MsgType type, uint32_t take)
{
    Frame f;
    f.type = type;
    f.setU32(Tag::TakeId, take);
    return f;
}

}  // namespace

TEST_CASE("Stage 9: both readiness checklists are complete and the producer sees the performer's", "[control][stage9]")
{
    Pair p;
    p.connectAndReady();
    const auto prod = p.producer.snapshot();
    for (const auto item : {ReadyItem::InputDevice, ReadyItem::EngineHealthy, ReadyItem::FolderWritable,
                            ReadyItem::DiskSpace, ReadyItem::NoActiveRecording, ReadyItem::Consent, ReadyItem::Connected})
                            {
        INFO(readyItemId(item));
        CHECK(hasCheck(prod.localChecks, item, true));
    }
    REQUIRE(p.runUntil([&] { return hasCheck(p.producer.snapshot().peerChecks, ReadyItem::ClockOffset, true); }));
    CHECK(hasCheck(p.producer.snapshot().peerChecks, ReadyItem::Consent, true));
    CHECK(encodeChecks(p.performer.snapshot().localChecks).size() < 256);  // fits one TLV string

    // The performer withdraws consent: the producer sees the item fail and Record is refused.
    p.performer.setConsent(false);
    REQUIRE(p.runUntil([&] { return hasCheck(p.producer.snapshot().peerChecks, ReadyItem::Consent, false); }));
    std::string error;
    CHECK_FALSE(p.producer.startTake(error));
    CHECK(error.find("performer has not consented") != std::string::npos);
    // A local device problem is an item too.
    p.performer.setConsent(true);
    p.performerPort.setReady(false, "test: input device unplugged");
    REQUIRE(p.runUntil([&] { return hasCheck(p.producer.snapshot().peerChecks, ReadyItem::InputDevice, false); }));
    CHECK_FALSE(p.producer.startTake(error));
}

TEST_CASE("Stage 9: the checklist encoding round-trips and skips unknown items", "[control][stage9]")
{
    std::vector<ReadinessCheck> c{{ReadyItem::InputDevice, true, true, ""}, {ReadyItem::DiskSpace, false, true, ""},
                                  {ReadyItem::ClockOffset, true, true, ""}};
    const std::string text = encodeChecks(c);
    CHECK(text == "input=1,disk=0,clock=1");
    const auto back = decodeChecks(text + ",future_item=1");
    REQUIRE(back.size() == 3);
    CHECK(back[1].item == ReadyItem::DiskSpace);
    CHECK_FALSE(back[1].ok);
    CHECK_FALSE(allMandatoryOk(back));
}

TEST_CASE("Stage 9: Stop before the start cancels the take on both PCs; nothing is recorded", "[control][stage9]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] {
        return p.producer.snapshot().session == SessionState::Scheduled &&
               p.performer.snapshot().session == SessionState::Scheduled;
    }));
    REQUIRE(p.producer.stopTake(error));  // about 350 ms before the start
    CHECK(p.producer.snapshot().take.cancelled);
    REQUIRE(p.runUntil([&] {
        return p.producer.snapshot().session == SessionState::Ready && p.performer.snapshot().session == SessionState::Ready &&
               p.performer.snapshot().take.cancelled;
    }));
    p.runUntil([] { return false; }, 600ms);  // past the original start time
    CHECK_FALSE(p.producer.snapshot().take.localStarted);
    CHECK_FALSE(p.performer.snapshot().take.localStarted);
    // A new take works afterwards.
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().take.peerStarted; }));
}

TEST_CASE("Stage 9: Stop during stopping/finalisation is refused and changes nothing", "[control][stage9]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().take.peerStarted; }));
    REQUIRE(p.producer.stopTake(error));
    CHECK(p.producer.snapshot().session == SessionState::Stopping);
    std::string again;
    CHECK_FALSE(p.producer.stopTake(again));
    CHECK(again.find("already stopping") != std::string::npos);
    REQUIRE(p.runUntil([&] {
        auto a = p.producer.snapshot();
        return a.session == SessionState::Ready && a.take.peerFinalised;
    }));
    CHECK(p.producer.snapshot().take.localStatus == TakeStatus::Complete);
    CHECK(p.producer.snapshot().take.peerStatus == TakeStatus::Complete);
}

TEST_CASE("Stage 9: a late SCHEDULE_START (start already past) is refused; nothing records", "[control][stage9]")
{
    Pair p;
    p.connectAndReady();
    auto arm = raw(MsgType::Arm, 40);
    arm.setU32(Tag::MaxTakeSeconds, 60);
    REQUIRE(p.producer.getLink()->send(arm));
    REQUIRE(p.runUntil([&] { return p.performer.snapshot().session == SessionState::Armed; }));
    auto late = raw(MsgType::ScheduleStart, 40);
    late.setI64(Tag::StartAtNs, monotonicNs() - 200'000'000);  // in the past
    REQUIRE(p.producer.getLink()->send(late));
    REQUIRE(p.runUntil([&] { return p.performer.snapshot().session == SessionState::Ready; }));
    p.runUntil([] { return false; }, 300ms);
    CHECK_FALSE(p.performer.snapshot().take.localStarted);
    CHECK(p.performer.snapshot().refusedMessages >= 1);
}

TEST_CASE("Stage 9: a command carrying another session id is refused", "[control][stage9]")
{
    Pair p;
    p.connectAndReady();
    auto arm = raw(MsgType::Arm, 41);
    arm.setU32(Tag::MaxTakeSeconds, 60);
    arm.setStr(Tag::SessionId, "deadbeef");
    REQUIRE(p.producer.getLink()->send(arm));
    REQUIRE(p.runUntil([&] { return p.performer.snapshot().refusedMessages >= 1; }));
    CHECK(p.performer.snapshot().session == SessionState::Ready);
    // The same command with the right session id is accepted.
    arm.setStr(Tag::SessionId, p.producer.snapshot().sessionId);
    REQUIRE(p.producer.getLink()->send(arm));
    REQUIRE(p.runUntil([&] { return p.performer.snapshot().session == SessionState::Armed; }));
}

TEST_CASE("Stage 9: replayed commands after a completed take start nothing", "[control][stage9]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().take.peerStarted; }));
    REQUIRE(p.producer.stopTake(error));
    REQUIRE(p.runUntil([&] {
        return p.producer.snapshot().session == SessionState::Ready && p.performer.snapshot().session == SessionState::Ready;
    }));
    const uint32_t take = p.producer.snapshot().take.takeId;
    const auto before = p.performer.snapshot();
    auto arm = raw(MsgType::Arm, take);
    arm.setU32(Tag::MaxTakeSeconds, 60);
    auto sched = raw(MsgType::ScheduleStart, take);
    sched.setI64(Tag::StartAtNs, monotonicNs() + 500'000'000);
    REQUIRE(p.producer.getLink()->send(arm));
    REQUIRE(p.producer.getLink()->send(sched));
    REQUIRE(p.runUntil([&] {
        auto s = p.performer.snapshot();
        return s.refusedMessages >= before.refusedMessages + 2;
    }));
    p.runUntil([] { return false; }, 700ms);
    CHECK(p.performer.snapshot().session == SessionState::Ready);
    CHECK(p.performer.snapshot().take.takeId == take);  // still the old, completed take
}

TEST_CASE("Stage 9: a CANCEL that crosses the start stops and saves the performer's take", "[control][stage9]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] { return p.performer.snapshot().session == SessionState::Recording; }));
    auto cancel = raw(MsgType::Cancel, p.producer.snapshot().take.takeId);
    cancel.setU16(Tag::ErrorCode, static_cast<uint16_t>(ErrorCode::Cancelled));
    REQUIRE(p.producer.getLink()->send(cancel));
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().take.peerFinalised; }));
    CHECK(p.producer.snapshot().take.peerStatus == TakeStatus::Complete);
    REQUIRE(p.producer.stopTake(error));
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().session == SessionState::Ready; }));
}

TEST_CASE("Stage 9: the scheduling lead has a measured minimum", "[control][stage9]")
{
    Pair p;
    p.connectAndReady();
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().linkStats.controlRttNs > 0; }));
    p.producer.setStartLeadMs(100);  // clamped to 300, still below 100 + 200 + 2 RTT + 2 u
    CHECK(p.producer.snapshot().startLeadMs == 300);
    CHECK(p.producer.minStartLeadMs() > 300);
    std::string error;
    CHECK_FALSE(p.producer.startTake(error));
    CHECK(error.find("start lead") != std::string::npos);
    CHECK(p.producer.snapshot().session == SessionState::Ready);
    p.producer.setStartLeadMs(600);
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().take.peerStarted; }));
}

TEST_CASE("Stage 12: the automatic lead covers the measured link and respects the floor",
          "[control][stage12]") {
    Pair p;
    p.connectAndReady();
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().linkStats.controlRttBestNs > 0; }));

    // Pinned by hand: a lead below the measured minimum is still refused, so the honesty of the
    // check is unchanged.
    p.producer.setAutoStartLead(false);
    p.producer.setStartLeadMs(300);
    REQUIRE(p.producer.minStartLeadMs() > 300);
    std::string error;
    CHECK_FALSE(p.producer.startTake(error));
    CHECK(error.find("start lead") != std::string::npos);

    // Automatic: the same unusable setting now produces a lead that clears the minimum, so the
    // take is accepted without the user touching anything.
    p.producer.setAutoStartLead(true);
    const ControllerSnapshot s = p.producer.snapshot();
    CHECK(s.autoStartLead);
    CHECK(s.effectiveStartLeadMs >= s.minStartLeadMs + SessionController::kAutoStartLeadHeadroomMs);
    CHECK(s.effectiveStartLeadMs >= 300);
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().take.peerStarted; }));
    CHECK(p.producer.snapshot().take.startLeadMs == s.effectiveStartLeadMs);
    REQUIRE(p.producer.stopTake(error));

    // A lead set by hand above what the link needs is never lowered by the automatic choice.
    p.producer.setStartLeadMs(4000);
    CHECK(p.producer.effectiveStartLeadMs() == 4000);
}

TEST_CASE("Stage 12: the link reports a best round trip, and it is never the worst",
          "[control][stage12]") {
    Pair p;
    p.connectAndReady();
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().linkStats.offsetSamples >= 4; }));
    const LinkStats ls = p.producer.snapshot().linkStats;
    CHECK(ls.controlRttBestNs > 0);
    CHECK(ls.controlRttBestNs <= ls.controlRttNs);
    // The minimum lead is built from the best round trip, so it cannot exceed the figure the
    // latest round trip would have given.
    const auto fromLatest = static_cast<uint32_t>(
        300 + std::ceil((2.0 * static_cast<double>(ls.controlRttNs) +
                         2.0 * static_cast<double>(ls.thetaUncertaintyNs)) / 1e6));
    CHECK(p.producer.minStartLeadMs() <= fromLatest);
}

TEST_CASE("Stage 9: the timing record is complete and ordered on both PCs", "[control][stage9]")
{
    Pair p;
    p.connectAndReady();
    std::string error;
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().take.peerStarted; }));
    REQUIRE(p.producer.stopTake(error));
    REQUIRE(p.runUntil([&] {
        return p.producer.snapshot().session == SessionState::Ready && p.performer.snapshot().session == SessionState::Ready;
    }));
    const TakeView a = p.producer.snapshot().take;
    CHECK(a.armSentNs > 0);
    CHECK(a.armSentNs <= a.armAckRxNs);
    CHECK(a.armAckRxNs <= a.scheduleSentNs);
    CHECK(a.scheduleSentNs <= a.startAckRxNs);
    CHECK(a.startAckRxNs < a.startAtLocalNs);  // acknowledged before the start
    CHECK(a.localFirstSampleNs >= a.startAtLocalNs);
    CHECK(a.peerStartedRxNs >= a.startAtLocalNs);
    CHECK(a.stopCmdNs <= a.stopAtLocalNs);
    CHECK(a.stopAtLocalNs <= a.localFinalisedNs);
    CHECK(a.peerFinalisedRxNs > 0);
    CHECK(a.startLeadMs == 400);
    CHECK(a.offsetSamples > 0);
    const TakeView b = p.performer.snapshot().take;
    CHECK(b.armRxNs > 0);
    CHECK(b.armRxNs <= b.scheduleRxNs);
    CHECK(b.scheduleRxNs <= b.startAckSentNs);
    CHECK(b.startAckSentNs < b.startAtLocalNs);
    CHECK(b.stopCmdNs > b.startAtLocalNs);
    CHECK(b.localFinalisedNs >= b.stopAtLocalNs);
}

// ---------------------------------------------------------------------------------------------
// Stage 11: take transfer through the session controllers (control link + transfer connection).
// The TEST RECORDER writes nothing; testReportFile() writes a real WAV (synthetic, silent-free
// counter signal) with exactly the frames the test recorder reports, as the performer's "take".

namespace
{

std::atomic<uint16_t> gXferPort{53611};

std::vector<char> bytesOf(const std::filesystem::path& p)
{
    std::ifstream in(p, std::ios::binary);
    return std::vector<char>((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

struct XferPair : Pair
{
    std::filesystem::path perfDir = std::filesystem::temp_directory_path() / "rr_tests" /
                                     ("ctrl_perf_" + makeSessionId());
    std::filesystem::path lastFile;

    XferPair()
    {
        port = static_cast<uint16_t>(gXferPort.fetch_add(3));  // control, media, transfer
        std::filesystem::create_directories(perfDir);
        performerPort.testReportFile([this](uint32_t take, uint64_t frames)
        {
            WavWriter w;
            WavFormat fmt;
            lastFile = perfDir / ("take" + std::to_string(take) + "_test.wav");
            if (w.open(lastFile, fmt))
            {
                std::vector<float> v(static_cast<size_t>(frames));
                for (size_t i = 0; i < v.size(); ++i)
                {
                    v[i] = 0.001f + static_cast<float>(i % 997) / 1000.0f;
                }
                w.writeFrames(v.data(), frames);
                w.finalise();
            }
            return lastFile;
        });
    }

    void recordOneTake()
    {
        std::string error;
        REQUIRE(producer.startTake(error));
        REQUIRE(runUntil([&] { return performer.snapshot().session == SessionState::Recording; }));
        runUntil([] { return false; }, 300ms);
        REQUIRE(producer.stopTake(error));
        REQUIRE(runUntil([&] {
            auto a = producer.snapshot();
            return a.session == SessionState::Ready && a.take.peerFinalised &&
                   performer.snapshot().session == SessionState::Ready;
        }));
    }

    static std::optional<TransferView> view(const ControllerSnapshot& s, uint32_t take)
    {
        for (const auto& v : s.transfers)
        {
            if (v.takeId == take)
            {
                return v;
            }
        }
        return std::nullopt;
    }

    bool ended(SessionController& c, uint32_t take)
    {
        const auto v = view(c.snapshot(), take);
        return v && transferStateFinal(v->state);
    }
};

}  // namespace

TEST_CASE("Stage 11: one producer request gives a VERIFIED copy; the performer's original is unchanged", "[control][stage11]")
{
    XferPair p;
    p.connectAndReady();
    p.performer.setDeliveryConsent(true);
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().peerDeliveryConsent; }));
    p.recordOneTake();
    const auto original = bytesOf(p.lastFile);
    REQUIRE(original.size() > 44);
    std::string error;
    REQUIRE(p.producer.requestTransfer(1, error));
    CHECK(p.producer.snapshot().protocolMinor == 2);
    REQUIRE(p.runUntil([&] { return p.ended(p.producer, 1) && p.ended(p.performer, 1); }, 10000ms));
    const auto prod = *XferPair::view(p.producer.snapshot(), 1);
    const auto perf = *XferPair::view(p.performer.snapshot(), 1);
    CHECK(prod.state == TransferState::Verified);
    CHECK(perf.state == TransferState::Verified);
    CHECK(prod.frames == p.producer.snapshot().take.peerFrames);
    CHECK(prod.framesVsReport == "match");
    CHECK(perf.sourceUnchanged);
    CHECK(bytesOf(std::filesystem::u8path(prod.file)) == original);
    CHECK(bytesOf(p.lastFile) == original);
    // Record works again once the transfer has ended.
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().session == SessionState::Ready; }));
}

TEST_CASE("Stage 11: without the performer's delivery consent the request is refused", "[control][stage11]")
{
    XferPair p;
    p.connectAndReady();
    p.recordOneTake();
    std::string error;
    REQUIRE(p.producer.requestTransfer(1, error));
    REQUIRE(p.runUntil([&] { return p.ended(p.producer, 1); }));
    const auto prod = *XferPair::view(p.producer.snapshot(), 1);
    CHECK(prod.state == TransferState::Failed);
    CHECK(prod.detail.find("performer refused") != std::string::npos);
    CHECK(p.performer.snapshot().transfers.empty());
}

TEST_CASE("Stage 11: requests are refused before TAKE_FINALISED and while recording; a transfer blocks Record", "[control][stage11]")
{
    XferPair p;
    p.connectAndReady();
    p.performer.setDeliveryConsent(true);
    std::string error;
    CHECK_FALSE(p.producer.requestTransfer(1, error));  // no take yet
    CHECK(error.find("not been reported finalised") != std::string::npos);
    REQUIRE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().session == SessionState::Recording; }));
    CHECK_FALSE(p.producer.requestTransfer(1, error));
    CHECK(error.find("being recorded") != std::string::npos);
    REQUIRE(p.producer.stopTake(error));
    REQUIRE(p.runUntil([&] {
        return p.producer.snapshot().session == SessionState::Ready && p.producer.snapshot().take.peerFinalised;
    }));
    REQUIRE(p.producer.requestTransfer(1, error));
    CHECK_FALSE(p.producer.requestTransfer(1, error));  // duplicate while queued
    p.producer.poll();  // the performer has not seen the request yet: the transfer is QUEUED
    CHECK(p.producer.snapshot().session == SessionState::NotReady);
    CHECK_FALSE(p.producer.startTake(error));
    REQUIRE(p.runUntil([&] { return p.ended(p.producer, 1); }, 10000ms));
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().session == SessionState::Ready; }));
}

TEST_CASE("Stage 11: automatic transfer after each take", "[control][stage11]")
{
    XferPair p;
    p.producer.setAutoTransfer(true);
    p.connectAndReady();
    p.performer.setDeliveryConsent(true);
    p.recordOneTake();
    REQUIRE(p.runUntil([&] { return p.ended(p.producer, 1); }, 10000ms));
    CHECK(XferPair::view(p.producer.snapshot(), 1)->state == TransferState::Verified);
    REQUIRE(p.runUntil([&] { return p.producer.snapshot().session == SessionState::Ready; }));
    p.recordOneTake();
    REQUIRE(p.runUntil([&] { return p.ended(p.producer, 2); }, 10000ms));
    CHECK(XferPair::view(p.producer.snapshot(), 2)->state == TransferState::Verified);
}
