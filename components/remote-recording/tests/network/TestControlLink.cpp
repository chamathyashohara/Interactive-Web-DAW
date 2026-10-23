// Control-link tests over real TCP on 127.0.0.1 (two links in one process).
#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <functional>
#include <thread>

#include "rr/network/ControlLink.h"

using namespace std::chrono_literals;

namespace
{

std::atomic<uint16_t> gPort{52731};

LinkTimings fastTimings()
{
    LinkTimings t;
    t.heartbeatIntervalMs = 50;
    t.linkLostAfterMs = 300;
    t.connectTimeoutMs = 1000;
    t.handshakeTimeoutMs = 1000;
    t.reconnectIntervalMs = 100;
    t.reconnectGiveUpMs = 5000;
    return t;
}

ServerParams serverParams(uint16_t port)
{
    ServerParams p;
    p.bindAddress = "127.0.0.1";
    p.port = port;
    p.sessionId = "ab12cd34";
    p.producerName = "Producer";
    p.appVersion = "test";
    p.timings = fastTimings();
    return p;
}

ClientParams clientParams(uint16_t port, const std::string& code)
{
    ClientParams p;
    p.hostAddress = "127.0.0.1";
    p.port = port;
    p.pairingCode = code;
    p.performerName = "Performer";
    p.appVersion = "test";
    p.timings = fastTimings();
    return p;
}

bool wait_until(const std::function<bool()>& pred, std::chrono::milliseconds timeout = 3000ms)
{
    const auto end = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < end)
    {
        if (pred())
        {
            return true;
        }
        std::this_thread::sleep_for(5ms);
    }
    return pred();
}

bool hasEvent(std::vector<LinkEvent>& sink, ControlLink& link, LinkEventKind kind)
{
    auto events = link.pollEvents();
    sink.insert(sink.end(), events.begin(), events.end());
    for (const auto& e : sink)
    {
        if (e.kind == kind)
        {
            return true;
        }
    }
    return false;
}

}  // namespace

TEST_CASE("a performer joins with the right code; frames flow; offset is estimated", "[network][link]")
{
    const uint16_t port = gPort++;
    auto server = ControlLink::server(serverParams(port));
    std::string error;
    REQUIRE(server->start(error));
    CHECK(server->getState() == LinkState::Listening);
    auto client = ControlLink::client(clientParams(port, server->getPairingCode()));
    REQUIRE(client->start(error));
    REQUIRE(wait_until([&] { return client->getState() == LinkState::Connected && server->getState() == LinkState::Connected; }));
    CHECK(client->joinInfo().sessionId == "ab12cd34");
    CHECK(server->joinInfo().peerName == "Performer");

    Frame f;
    f.type = MsgType::ReadyStatus;
    f.setU8(Tag::Ready, 1);
    f.setU8(Tag::Consent, 1);
    f.setU8(Tag::State, 1);
    REQUIRE(client->send(f));
    std::vector<LinkEvent> events;
    REQUIRE(wait_until([&] { return hasEvent(events, *server, LinkEventKind::FrameReceived); }));
    REQUIRE(wait_until([&] { return client->getStats().offsetSamples >= 3 && server->getStats().offsetSamples >= 3; }));
    // Same PC, same clock: the offset is within its own uncertainty of zero.
    const auto s = client->getStats();
    CHECK((s.thetaNs <= s.thetaUncertaintyNs + 1'000'000 && s.thetaNs >= -s.thetaUncertaintyNs - 1'000'000));
    CHECK(s.controlRttNs > 0);
    // The code is single-use.
    auto second = ControlLink::client(clientParams(port, server->getPairingCode()));
    REQUIRE(second->start(error));
    std::vector<LinkEvent> secondEvents;
    REQUIRE(wait_until([&] { return hasEvent(secondEvents, *second, LinkEventKind::JoinRejected); }));
    CHECK(server->getState() == LinkState::Connected);  // first performer unaffected
}

TEST_CASE("a wrong pairing code is refused with no retry, and never leaks into events", "[network][link]")
{
    const uint16_t port = gPort++;
    auto server = ControlLink::server(serverParams(port));
    std::string error;
    REQUIRE(server->start(error));
    const std::string real = server->getPairingCode();
    const std::string wrong = real == "000000" ? "111111" : "000000";
    auto client = ControlLink::client(clientParams(port, wrong));
    REQUIRE(client->start(error));
    std::vector<LinkEvent> events;
    REQUIRE(wait_until([&] { return hasEvent(events, *client, LinkEventKind::JoinRejected); }));
    REQUIRE(wait_until([&] { return client->getState() == LinkState::Disconnected; }));
    bool rejectedCode = false;
    for (const auto& e : events)
    {
        CHECK(e.text.find(real) == std::string::npos);
        rejectedCode = rejectedCode || e.code == ErrorCode::BadPairingCode;
    }
    CHECK(rejectedCode);
    for (const auto& e : server->pollEvents())
    {
        CHECK(e.text.find(real) == std::string::npos);
    }
    std::this_thread::sleep_for(300ms);
    CHECK(client->getStats().reconnectAttempts == 0);
    CHECK(server->getStats().failedJoins == 1);
}

TEST_CASE("an unsupported protocol major version fails safely", "[network][link]")
{
    const uint16_t port = gPort++;
    auto server = ControlLink::server(serverParams(port));
    std::string error;
    REQUIRE(server->start(error));
    auto client = ControlLink::client(clientParams(port, server->getPairingCode()));
    client->testSetProtocolMajor(2);
    REQUIRE(client->start(error));
    std::vector<LinkEvent> events;
    REQUIRE(wait_until([&] { return hasEvent(events, *client, LinkEventKind::JoinRejected); }));
    bool version = false;
    for (const auto& e : events)
    {
        if (e.kind == LinkEventKind::JoinRejected)
        {
            version = e.code == ErrorCode::VersionUnsupported && e.text.find("1.2") != std::string::npos;
        }
    }
    CHECK(version);
    CHECK(server->getState() == LinkState::Listening);
}

TEST_CASE("missing heartbeats are detected and the performer resumes with its token", "[network][link]")
{
    const uint16_t port = gPort++;
    auto server = ControlLink::server(serverParams(port));
    std::string error;
    REQUIRE(server->start(error));
    auto client = ControlLink::client(clientParams(port, server->getPairingCode()));
    REQUIRE(client->start(error));
    REQUIRE(wait_until([&] { return client->getState() == LinkState::Connected; }));

    client->testSuspendHeartbeats(true);  // the server stops hearing anything
    server->testSuspendHeartbeats(true);
    REQUIRE(wait_until([&] { return server->getState() == LinkState::LinkLost; }));
    client->testSuspendHeartbeats(false);
    server->testSuspendHeartbeats(false);
    // The client also lost the link (server closed), reconnects and resumes without a code.
    REQUIRE(wait_until([&] {
        return client->getState() == LinkState::Connected && server->getState() == LinkState::Connected &&
               client->getStats().connections >= 2;
    }));
    std::vector<LinkEvent> events;
    bool resumed = false;
    wait_until([&] {
        hasEvent(events, *server, LinkEventKind::Joined);
        for (const auto& e : events)
        {
            resumed = resumed || (e.kind == LinkEventKind::Joined && e.resumed);
        }
        return resumed;
    });
    CHECK(resumed);
}

TEST_CASE("a dropped connection is reported as LinkLost and recovered", "[network][link]")
{
    const uint16_t port = gPort++;
    auto server = ControlLink::server(serverParams(port));
    std::string error;
    REQUIRE(server->start(error));
    auto client = ControlLink::client(clientParams(port, server->getPairingCode()));
    REQUIRE(client->start(error));
    REQUIRE(wait_until([&] { return client->getState() == LinkState::Connected; }));
    client->testDropConnection();
    REQUIRE(wait_until([&] { return client->getState() == LinkState::LinkLost; }, 1000ms));
    REQUIRE(wait_until([&] { return client->getState() == LinkState::Connected && server->getState() == LinkState::Connected; }));
    CHECK(client->getStats().reconnectAttempts >= 1);
}

TEST_CASE("leaving closes the session on both sides without reconnecting", "[network][link]")
{
    const uint16_t port = gPort++;
    auto server = ControlLink::server(serverParams(port));
    std::string error;
    REQUIRE(server->start(error));
    auto client = ControlLink::client(clientParams(port, server->getPairingCode()));
    REQUIRE(client->start(error));
    REQUIRE(wait_until([&] { return server->getState() == LinkState::Connected; }));
    client->stop(ErrorCode::UserStop);
    CHECK(client->getState() == LinkState::Disconnected);
    std::vector<LinkEvent> events;
    REQUIRE(wait_until([&] { return hasEvent(events, *server, LinkEventKind::PeerClosed); }));
    CHECK(server->getState() == LinkState::Listening);
}

TEST_CASE("a second performer is refused while one is connected", "[network][link]")
{
    const uint16_t port = gPort++;
    auto server = ControlLink::server(serverParams(port));
    std::string error;
    REQUIRE(server->start(error));
    auto first = ControlLink::client(clientParams(port, server->getPairingCode()));
    REQUIRE(first->start(error));
    REQUIRE(wait_until([&] { return server->getState() == LinkState::Connected; }));
    const std::string code2 = server->newPairingCode();
    auto second = ControlLink::client(clientParams(port, code2));
    REQUIRE(second->start(error));
    std::vector<LinkEvent> events;
    REQUIRE(wait_until([&] { return hasEvent(events, *second, LinkEventKind::JoinRejected); }));
    bool full = false;
    for (const auto& e : events)
    {
        full = full || e.code == ErrorCode::SessionFull;
    }
    CHECK(full);
    CHECK(first->getState() == LinkState::Connected);
}

TEST_CASE("binding to an address that is not on this PC fails with a clear message", "[network][link]")
{
    auto p = serverParams(gPort++);
    p.bindAddress = "203.0.113.7";  // TEST-NET-3, never local
    auto server = ControlLink::server(p);
    std::string error;
    CHECK_FALSE(server->start(error));
    CHECK(error.find("cannot listen on 203.0.113.7") != std::string::npos);
}

TEST_CASE("listening on all interfaces (0.0.0.0) is refused", "[network][link]")
{
    auto p = serverParams(gPort++);
    p.bindAddress = "0.0.0.0";
    auto server = ControlLink::server(p);
    std::string error;
    CHECK_FALSE(server->start(error));
    CHECK(error.find("choose one network interface") != std::string::npos);
}
