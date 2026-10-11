// Control-link tests over real TCP on 127.0.0.1 (two links in one process).
#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <functional>
#include <thread>

#include "rr/network/control_link.hpp"

using namespace rr::net;
using rr::session::LinkState;
using namespace std::chrono_literals;

namespace {

std::atomic<std::uint16_t> g_port{52731};

LinkTimings fast_timings() {
    LinkTimings t;
    t.heartbeat_interval_ms = 50;
    t.link_lost_after_ms = 300;
    t.connect_timeout_ms = 1000;
    t.handshake_timeout_ms = 1000;
    t.reconnect_interval_ms = 100;
    t.reconnect_give_up_ms = 5000;
    return t;
}

ServerParams server_params(std::uint16_t port) {
    ServerParams p;
    p.bind_address = "127.0.0.1";
    p.port = port;
    p.session_id = "ab12cd34";
    p.producer_name = "Producer";
    p.app_version = "test";
    p.timings = fast_timings();
    return p;
}

ClientParams client_params(std::uint16_t port, const std::string& code) {
    ClientParams p;
    p.host_address = "127.0.0.1";
    p.port = port;
    p.pairing_code = code;
    p.performer_name = "Performer";
    p.app_version = "test";
    p.timings = fast_timings();
    return p;
}

bool wait_until(const std::function<bool()>& pred, std::chrono::milliseconds timeout = 3000ms) {
    const auto end = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < end) {
        if (pred()) {
            return true;
        }
        std::this_thread::sleep_for(5ms);
    }
    return pred();
}

bool has_event(std::vector<LinkEvent>& sink, ControlLink& link, LinkEventKind kind) {
    auto events = link.poll_events();
    sink.insert(sink.end(), events.begin(), events.end());
    for (const auto& e : sink) {
        if (e.kind == kind) {
            return true;
        }
    }
    return false;
}

}  // namespace

TEST_CASE("a performer joins with the right code; frames flow; offset is estimated", "[network][link]") {
    const std::uint16_t port = g_port++;
    auto server = ControlLink::server(server_params(port));
    std::string error;
    REQUIRE(server->start(error));
    CHECK(server->state() == LinkState::Listening);
    auto client = ControlLink::client(client_params(port, server->pairing_code()));
    REQUIRE(client->start(error));
    REQUIRE(wait_until([&] { return client->state() == LinkState::Connected && server->state() == LinkState::Connected; }));
    CHECK(client->join_info().session_id == "ab12cd34");
    CHECK(server->join_info().peer_name == "Performer");

    Frame f;
    f.type = MsgType::ReadyStatus;
    f.set_u8(Tag::Ready, 1);
    f.set_u8(Tag::Consent, 1);
    f.set_u8(Tag::State, 1);
    REQUIRE(client->send(f));
    std::vector<LinkEvent> events;
    REQUIRE(wait_until([&] { return has_event(events, *server, LinkEventKind::FrameReceived); }));
    REQUIRE(wait_until([&] { return client->stats().offset_samples >= 3 && server->stats().offset_samples >= 3; }));
    // Same PC, same clock: the offset is within its own uncertainty of zero.
    const auto s = client->stats();
    CHECK((s.theta_ns <= s.theta_uncertainty_ns + 1'000'000 && s.theta_ns >= -s.theta_uncertainty_ns - 1'000'000));
    CHECK(s.control_rtt_ns > 0);
    // The code is single-use.
    auto second = ControlLink::client(client_params(port, server->pairing_code()));
    REQUIRE(second->start(error));
    std::vector<LinkEvent> second_events;
    REQUIRE(wait_until([&] { return has_event(second_events, *second, LinkEventKind::JoinRejected); }));
    CHECK(server->state() == LinkState::Connected);  // first performer unaffected
}

TEST_CASE("a wrong pairing code is refused with no retry, and never leaks into events", "[network][link]") {
    const std::uint16_t port = g_port++;
    auto server = ControlLink::server(server_params(port));
    std::string error;
    REQUIRE(server->start(error));
    const std::string real = server->pairing_code();
    const std::string wrong = real == "000000" ? "111111" : "000000";
    auto client = ControlLink::client(client_params(port, wrong));
    REQUIRE(client->start(error));
    std::vector<LinkEvent> events;
    REQUIRE(wait_until([&] { return has_event(events, *client, LinkEventKind::JoinRejected); }));
    REQUIRE(wait_until([&] { return client->state() == LinkState::Disconnected; }));
    bool rejected_code = false;
    for (const auto& e : events) {
        CHECK(e.text.find(real) == std::string::npos);
        rejected_code = rejected_code || e.code == rr::ErrorCode::BadPairingCode;
    }
    CHECK(rejected_code);
    for (const auto& e : server->poll_events()) {
        CHECK(e.text.find(real) == std::string::npos);
    }
    std::this_thread::sleep_for(300ms);
    CHECK(client->stats().reconnect_attempts == 0);
    CHECK(server->stats().failed_joins == 1);
}

TEST_CASE("an unsupported protocol major version fails safely", "[network][link]") {
    const std::uint16_t port = g_port++;
    auto server = ControlLink::server(server_params(port));
    std::string error;
    REQUIRE(server->start(error));
    auto client = ControlLink::client(client_params(port, server->pairing_code()));
    client->test_set_protocol_major(2);
    REQUIRE(client->start(error));
    std::vector<LinkEvent> events;
    REQUIRE(wait_until([&] { return has_event(events, *client, LinkEventKind::JoinRejected); }));
    bool version = false;
    for (const auto& e : events) {
        if (e.kind == LinkEventKind::JoinRejected) {
            version = e.code == rr::ErrorCode::VersionUnsupported && e.text.find("1.2") != std::string::npos;
        }
    }
    CHECK(version);
    CHECK(server->state() == LinkState::Listening);
}

TEST_CASE("missing heartbeats are detected and the performer resumes with its token", "[network][link]") {
    const std::uint16_t port = g_port++;
    auto server = ControlLink::server(server_params(port));
    std::string error;
    REQUIRE(server->start(error));
    auto client = ControlLink::client(client_params(port, server->pairing_code()));
    REQUIRE(client->start(error));
    REQUIRE(wait_until([&] { return client->state() == LinkState::Connected; }));

    client->test_suspend_heartbeats(true);  // the server stops hearing anything
    server->test_suspend_heartbeats(true);
    REQUIRE(wait_until([&] { return server->state() == LinkState::LinkLost; }));
    client->test_suspend_heartbeats(false);
    server->test_suspend_heartbeats(false);
    // The client also lost the link (server closed), reconnects and resumes without a code.
    REQUIRE(wait_until([&] {
        return client->state() == LinkState::Connected && server->state() == LinkState::Connected &&
               client->stats().connections >= 2;
    }));
    std::vector<LinkEvent> events;
    bool resumed = false;
    wait_until([&] {
        has_event(events, *server, LinkEventKind::Joined);
        for (const auto& e : events) {
            resumed = resumed || (e.kind == LinkEventKind::Joined && e.resumed);
        }
        return resumed;
    });
    CHECK(resumed);
}

TEST_CASE("a dropped connection is reported as LinkLost and recovered", "[network][link]") {
    const std::uint16_t port = g_port++;
    auto server = ControlLink::server(server_params(port));
    std::string error;
    REQUIRE(server->start(error));
    auto client = ControlLink::client(client_params(port, server->pairing_code()));
    REQUIRE(client->start(error));
    REQUIRE(wait_until([&] { return client->state() == LinkState::Connected; }));
    client->test_drop_connection();
    REQUIRE(wait_until([&] { return client->state() == LinkState::LinkLost; }, 1000ms));
    REQUIRE(wait_until([&] { return client->state() == LinkState::Connected && server->state() == LinkState::Connected; }));
    CHECK(client->stats().reconnect_attempts >= 1);
}

TEST_CASE("leaving closes the session on both sides without reconnecting", "[network][link]") {
    const std::uint16_t port = g_port++;
    auto server = ControlLink::server(server_params(port));
    std::string error;
    REQUIRE(server->start(error));
    auto client = ControlLink::client(client_params(port, server->pairing_code()));
    REQUIRE(client->start(error));
    REQUIRE(wait_until([&] { return server->state() == LinkState::Connected; }));
    client->stop(rr::ErrorCode::UserStop);
    CHECK(client->state() == LinkState::Disconnected);
    std::vector<LinkEvent> events;
    REQUIRE(wait_until([&] { return has_event(events, *server, LinkEventKind::PeerClosed); }));
    CHECK(server->state() == LinkState::Listening);
}

TEST_CASE("a second performer is refused while one is connected", "[network][link]") {
    const std::uint16_t port = g_port++;
    auto server = ControlLink::server(server_params(port));
    std::string error;
    REQUIRE(server->start(error));
    auto first = ControlLink::client(client_params(port, server->pairing_code()));
    REQUIRE(first->start(error));
    REQUIRE(wait_until([&] { return server->state() == LinkState::Connected; }));
    const std::string code2 = server->new_pairing_code();
    auto second = ControlLink::client(client_params(port, code2));
    REQUIRE(second->start(error));
    std::vector<LinkEvent> events;
    REQUIRE(wait_until([&] { return has_event(events, *second, LinkEventKind::JoinRejected); }));
    bool full = false;
    for (const auto& e : events) {
        full = full || e.code == rr::ErrorCode::SessionFull;
    }
    CHECK(full);
    CHECK(first->state() == LinkState::Connected);
}

TEST_CASE("binding to an address that is not on this PC fails with a clear message", "[network][link]") {
    auto p = server_params(g_port++);
    p.bind_address = "203.0.113.7";  // TEST-NET-3, never local
    auto server = ControlLink::server(p);
    std::string error;
    CHECK_FALSE(server->start(error));
    CHECK(error.find("cannot listen on 203.0.113.7") != std::string::npos);
}

TEST_CASE("listening on all interfaces (0.0.0.0) is refused", "[network][link]") {
    auto p = server_params(g_port++);
    p.bind_address = "0.0.0.0";
    auto server = ControlLink::server(p);
    std::string error;
    CHECK_FALSE(server->start(error));
    CHECK(error.find("choose one network interface") != std::string::npos);
}
