// Live sender -> UDP (127.0.0.1) -> live receiver, end to end (ADR-017).
//
// TEST SIGNAL AND TEST CLOCK - a synthetic 440 Hz sine is pushed into a LiveTap every 10 ms (as
// the capture callback would), and render_add() is called every 10 ms (as the playback callback
// would). Real sockets, real Opus, no audio hardware. This proves the pipeline's logic and its
// robustness, not latency or audio quality on real devices.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cmath>
#include <thread>
#include <vector>

#include "rr/audio/live_tap.hpp"
#include "rr/media/live_receiver.hpp"
#include "rr/media/live_sender.hpp"

using namespace rr;
using namespace rr::media;

namespace {

constexpr std::uint32_t kSession = 0x5eed0001u;
constexpr double kPi = 3.14159265358979323846;

struct Rig {
    audio::LiveTap tap;
    LiveSender sender;
    LiveReceiver receiver;
    std::uint64_t phase = 0;
    std::vector<float> in = std::vector<float>(480 * 2);
    std::vector<float> out = std::vector<float>(480 * 2);
    double out_energy = 0.0;

    Rig() { tap.set_source_rate(48000); }

    // One simulated 10 ms period: capture block in, playback block out.
    void tick() {
        for (std::size_t i = 0; i < 480; ++i) {
            const float v = 0.25f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * static_cast<double>(phase + i) / 48000.0));
            in[2 * i] = v;
            in[2 * i + 1] = v;
        }
        phase += 480;
        tap.push_capture(in.data(), 480, 2);
        std::fill(out.begin(), out.end(), 0.0f);
        receiver.render_add(out.data(), 480, 2, 48000);
        for (const float v : out) {
            out_energy += static_cast<double>(v) * v;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    void run(int ticks) {
        for (int i = 0; i < ticks; ++i) {
            tick();
        }
    }

    bool start(std::uint16_t port, const ImpairmentSettings& impair = {}) {
        LiveSenderConfig sc;
        sc.bind_address = "127.0.0.1";
        sc.media_port = port;
        sc.session_id = kSession;
        sc.expected_peer_address = "127.0.0.1";
        sc.test_impairment = impair;
        std::string error;
        if (!sender.start(sc, tap, error)) {
            UNSCOPED_INFO(error);
            return false;
        }
        sender.set_sending(true);
        LiveReceiverConfig rc;
        rc.producer_host = "127.0.0.1";
        rc.media_port = port;
        rc.session_id = kSession;
        rc.playout.gain_db = 0.0f;
        if (!receiver.start(rc, error)) {
            UNSCOPED_INFO(error);
            return false;
        }
        receiver.set_output_enabled(true);
        return true;
    }
};

}  // namespace

TEST_CASE("Live audio flows producer -> performer over loopback UDP and both sides count it", "[media][live]") {
    Rig rig;
    REQUIRE(rig.start(52161));
    rig.run(300);  // ~3 s
    const auto s = rig.sender.stats();
    const auto r = rig.receiver.stats();

    CHECK(s.peer_known);                 // learned from the performer's report
    CHECK(s.streams_started == 1);
    CHECK(s.packets_sent > 200);
    CHECK(s.encode_errors == 0);
    CHECK(s.send_errors == 0);
    CHECK(s.lookahead_samples > 0);
    CHECK(s.has_report);                 // producer sees the performer's receive counters
    CHECK(s.last_report.received > 0);

    CHECK(r.arrival.received > 200);
    CHECK(r.arrival.lost_estimate == 0);  // loopback, no impairment
    CHECK(r.invalid.total() == 0);
    CHECK(r.decode_errors == 0);
    CHECK(r.jb.played > 150);
    CHECK(r.jb_playing);
    CHECK(r.output_peak_dbfs > -20.0f);   // the 0.25 (-12 dBFS) sine is audible at 0 dB gain
    CHECK(rig.out_energy > 0.0);
    CHECK(r.queue_full_drops == 0);

    // The performer stops listening: the producer stops streaming and says so.
    rig.receiver.stop();
    for (int i = 0; i < 50 && rig.sender.stats().streaming; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    const auto after = rig.sender.stats();
    CHECK_FALSE(after.peer_known);
    CHECK_FALSE(after.streaming);
    rig.sender.stop();
    CHECK_FALSE(rig.tap.enabled());
}

TEST_CASE("Forced loss, duplication, reordering and loss bursts do not stop live playback", "[media][live]") {
    Rig rig;
    ImpairmentSettings impair;
    impair.loss_percent = 10.0;
    impair.duplicate_percent = 5.0;
    impair.reorder_percent = 5.0;
    impair.burst_every = 100;
    impair.burst_length = 30;  // 300 ms outage every 1 s of packets: forces underruns and refills
    impair.seed = 7;
    REQUIRE(rig.start(52162, impair));
    rig.run(400);
    const auto s = rig.sender.stats();
    const auto r = rig.receiver.stats();
    INFO("sent " << s.packets_sent << " dropped " << s.test_dropped << " dup " << s.test_duplicated << " reorder "
                 << s.test_reordered);
    INFO("received " << r.arrival.received << " lost est " << r.arrival.lost_estimate << " dups " << r.arrival.duplicates
                     << " reordered " << r.arrival.reordered << " late " << r.jb.late << " lost " << r.jb.lost
                     << " underruns " << r.jb.underruns << " rebuffers " << r.jb.rebuffers);
    CHECK(s.test_dropped > 0);
    CHECK(r.arrival.lost_estimate > 0);
    CHECK(r.arrival.duplicates > 0);
    CHECK(r.arrival.reordered + r.jb.late > 0);
    CHECK(r.concealed > 0);           // Opus PLC on the live monitor path
    CHECK(r.jb.rebuffers > 0);        // the 300 ms bursts exceed the stall limit (20 frames)
    CHECK(r.jb.played > 100);         // and playback resumed after each
    CHECK(r.decode_errors == 0);
    CHECK(r.output_peak_dbfs > -20.0f);
    rig.receiver.stop();
    rig.sender.stop();
}

TEST_CASE("The receiver rejects malformed, oversized and wrong-session datagrams and keeps playing", "[media][live]") {
    // The test plays the producer: a socket bound to the producer's media port.
    std::string error;
    net::init_sockets(error);
    net::UdpSocket fake_producer;
    REQUIRE(fake_producer.bind_on("127.0.0.1", 52163, error));
    LiveReceiver receiver;
    LiveReceiverConfig rc;
    rc.producer_host = "127.0.0.1";
    rc.media_port = 52163;
    rc.session_id = kSession;
    REQUIRE(receiver.start(rc, error));
    receiver.set_output_enabled(true);

    // Learn the receiver's address from its first report.
    std::uint8_t buf[net::UdpSocket::kMaxDatagram];
    net::Endpoint performer;
    for (int i = 0; i < 100 && !performer.valid(); ++i) {
        fake_producer.wait_readable(20);
        if (fake_producer.recv_from(buf, sizeof buf, performer, error) <= 0) {
            performer = net::Endpoint{};
        }
    }
    REQUIRE(performer.valid());

    OpusLiveEncoder enc;
    REQUIRE(enc.create(LiveCodecSettings{}, error));
    std::vector<float> pcm(480, 0.1f);
    std::uint8_t opus[1276];
    const int bytes = enc.encode(pcm.data(), opus, sizeof opus);
    REQUIRE(bytes > 0);
    auto make = [&](std::uint32_t seq, std::uint32_t session) {
        MediaHeader h;
        h.seq = seq;
        h.media_index = seq * 480ull;
        h.session_id = session;
        h.flags = kCodecOpus;
        std::vector<std::uint8_t> d(kHeaderBytes + static_cast<std::size_t>(bytes));
        write_packet(h, opus, static_cast<std::size_t>(bytes), d.data(), d.size());
        return d;
    };
    auto send = [&](const std::vector<std::uint8_t>& d) { fake_producer.send_to(performer, d.data(), d.size(), error); };

    std::vector<float> out(480 * 2);
    for (std::uint32_t seq = 0; seq < 60; ++seq) {
        send(make(seq, kSession));                    // valid
        auto bad_crc = make(seq, kSession);
        bad_crc[30] ^= 0x55;
        send(bad_crc);
        send(make(seq, 0x0BADBAD0u));                 // another session
        auto truncated = make(seq, kSession);
        truncated.resize(20);
        send(truncated);
        auto old_version = make(seq, kSession);
        old_version[20] = 0x00;                       // a prototype-format packet
        send(old_version);
        send(std::vector<std::uint8_t>(3000, 0xAB));  // larger than any valid datagram
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        std::fill(out.begin(), out.end(), 0.0f);
        receiver.render_add(out.data(), 480, 2, 48000);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    const auto r = receiver.stats();
    INFO("crc " << r.invalid.bad_crc << " session " << r.invalid.bad_session << " len " << r.invalid.bad_length
                << " version " << r.invalid.bad_version << " oversized " << r.invalid.oversized);
    CHECK(r.arrival.received == 60);
    CHECK(r.invalid.bad_crc == 60);
    CHECK(r.invalid.bad_session == 60);
    CHECK(r.invalid.bad_version == 60);
    // A 3000-byte datagram is reported as oversized (Windows) or truncated and refused by length
    // (POSIX); a 20-byte one is refused by length.
    CHECK(r.invalid.bad_length + r.invalid.oversized == 120);
    CHECK(r.jb.played > 40);
    CHECK(r.decode_errors == 0);
    receiver.stop();
}

TEST_CASE("Live output can be switched off: nothing is added to the output", "[media][live]") {
    Rig rig;
    REQUIRE(rig.start(52164));
    rig.run(100);
    rig.receiver.set_output_enabled(false);
    rig.out_energy = 0.0;
    rig.run(50);
    CHECK(rig.out_energy == 0.0);
    CHECK_FALSE(rig.receiver.stats().jb_playing);
    rig.receiver.set_output_enabled(true);
    rig.run(50);
    CHECK(rig.out_energy > 0.0);
    rig.receiver.stop();
    rig.sender.stop();
}

TEST_CASE("The producer ignores reports from other addresses and other sessions", "[media][live]") {
    audio::LiveTap tap;
    tap.set_source_rate(48000);
    LiveSender sender;
    LiveSenderConfig sc;
    sc.bind_address = "127.0.0.1";
    sc.media_port = 52165;
    sc.session_id = kSession;
    sc.expected_peer_address = "127.0.0.2";  // the performer is "elsewhere"
    std::string error;
    REQUIRE(sender.start(sc, tap, error));
    sender.set_sending(true);

    net::UdpSocket stranger;
    REQUIRE(stranger.connect_to("127.0.0.1", 52165, error));
    ReceiverReport rep;
    std::uint8_t body[ReceiverReport::kBytes];
    write_report(rep, body);
    MediaHeader h;
    h.type = PacketType::ReceiverReport;
    h.session_id = kSession;
    std::uint8_t d[kHeaderBytes + ReceiverReport::kBytes];
    const std::size_t n = write_packet(h, body, sizeof body, d, sizeof d);
    for (int i = 0; i < 5; ++i) {
        stranger.send(d, n, error);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    auto s = sender.stats();
    CHECK(s.invalid.src_rejected == 5);
    CHECK_FALSE(s.peer_known);
    CHECK(s.packets_sent == 0);
    CHECK_FALSE(tap.enabled());
    sender.stop();

    // Right address, wrong session.
    sc.expected_peer_address = "127.0.0.1";
    REQUIRE(sender.start(sc, tap, error));
    sender.set_sending(true);
    h.session_id = 0x12345678u;
    const std::size_t m = write_packet(h, body, sizeof body, d, sizeof d);
    for (int i = 0; i < 5; ++i) {
        stranger.send(d, m, error);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    s = sender.stats();
    CHECK(s.invalid.bad_session == 5);
    CHECK_FALSE(s.peer_known);
    sender.stop();
}
