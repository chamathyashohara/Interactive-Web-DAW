// Live sender -> UDP (127.0.0.1) -> live receiver, end to end (ADR-017).
//
// TEST SIGNAL AND TEST CLOCK - a synthetic 440 Hz sine is pushed into a LiveTap every 10 ms (as
// the capture callback would), and renderAdd() is called every 10 ms (as the playback callback
// would). Real sockets, real Opus, no audio hardware. This proves the pipeline's logic and its
// robustness, not latency or audio quality on real devices.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cmath>
#include <thread>
#include <vector>

#include "rr/audio/LiveTap.h"
#include "rr/media/LiveReceiver.h"
#include "rr/media/LiveSender.h"

namespace
{

constexpr uint32_t kSession = 0x5eed0001u;
constexpr double kPi = 3.14159265358979323846;

struct Rig
{
    LiveTap tap;
    LiveSender sender;
    LiveReceiver receiver;
    uint64_t phase = 0;
    std::vector<float> in = std::vector<float>(480 * 2);
    std::vector<float> out = std::vector<float>(480 * 2);
    double outEnergy = 0.0;

    Rig() { tap.setSourceRate(48000); }

    // One simulated 10 ms period: capture block in, playback block out.
    void tick()
    {
        for (size_t i = 0; i < 480; ++i)
        {
            const float v = 0.25f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * static_cast<double>(phase + i) / 48000.0));
            in[2 * i] = v;
            in[2 * i + 1] = v;
        }
        phase += 480;
        tap.pushCapture(in.data(), 480, 2);
        std::fill(out.begin(), out.end(), 0.0f);
        receiver.renderAdd(out.data(), 480, 2, 48000);
        for (const float v : out)
        {
            outEnergy += static_cast<double>(v) * v;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    void run(int ticks)
    {
        for (int i = 0; i < ticks; ++i)
        {
            tick();
        }
    }

    bool start(uint16_t port, const ImpairmentSettings& impair = {})
    {
        LiveSenderConfig sc;
        sc.bindAddress = "127.0.0.1";
        sc.mediaPort = port;
        sc.sessionId = kSession;
        sc.expectedPeerAddress = "127.0.0.1";
        sc.testImpairment = impair;
        std::string error;
        if (!sender.start(sc, tap, error))
        {
            UNSCOPED_INFO(error);
            return false;
        }
        sender.setSending(true);
        LiveReceiverConfig rc;
        rc.producerHost = "127.0.0.1";
        rc.mediaPort = port;
        rc.sessionId = kSession;
        rc.playout.gainDb = 0.0f;
        if (!receiver.start(rc, error))
        {
            UNSCOPED_INFO(error);
            return false;
        }
        receiver.setOutputEnabled(true);
        return true;
    }
};

}  // namespace

TEST_CASE("Live audio flows producer -> performer over loopback UDP and both sides count it", "[media][live]")
{
    Rig rig;
    REQUIRE(rig.start(52161));
    rig.run(300);  // ~3 s
    const auto s = rig.sender.stats();
    const auto r = rig.receiver.stats();

    CHECK(s.peerKnown);                 // learned from the performer's report
    CHECK(s.streamsStarted == 1);
    CHECK(s.packetsSent > 200);
    CHECK(s.encodeErrors == 0);
    CHECK(s.sendErrors == 0);
    CHECK(s.lookaheadSamples > 0);
    CHECK(s.hasReport);                 // producer sees the performer's receive counters
    CHECK(s.lastReport.received > 0);

    CHECK(r.arrival.received > 200);
    CHECK(r.arrival.lostEstimate == 0);  // loopback, no impairment
    CHECK(r.invalid.total() == 0);
    CHECK(r.decodeErrors == 0);
    CHECK(r.jb.played > 150);
    CHECK(r.jbPlaying);
    CHECK(r.outputPeakDbfs > -20.0f);   // the 0.25 (-12 dBFS) sine is audible at 0 dB gain
    CHECK(rig.outEnergy > 0.0);
    CHECK(r.queueFullDrops == 0);

    // The performer stops listening: the producer stops streaming and says so.
    rig.receiver.stop();
    for (int i = 0; i < 50 && rig.sender.stats().streaming; ++i)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    const auto after = rig.sender.stats();
    CHECK_FALSE(after.peerKnown);
    CHECK_FALSE(after.streaming);
    rig.sender.stop();
    CHECK_FALSE(rig.tap.isEnabled());
}

TEST_CASE("Forced loss, duplication, reordering and loss bursts do not stop live playback", "[media][live]")
{
    Rig rig;
    ImpairmentSettings impair;
    impair.lossPercent = 10.0;
    impair.duplicatePercent = 5.0;
    impair.reorderPercent = 5.0;
    impair.burstEvery = 100;
    impair.burstLength = 30;  // 300 ms outage every 1 s of packets: forces underruns and refills
    impair.seed = 7;
    REQUIRE(rig.start(52162, impair));
    rig.run(400);
    const auto s = rig.sender.stats();
    const auto r = rig.receiver.stats();
    INFO("sent " << s.packetsSent << " dropped " << s.testDropped << " dup " << s.testDuplicated << " reorder "
                 << s.testReordered);
    INFO("received " << r.arrival.received << " lost est " << r.arrival.lostEstimate << " dups " << r.arrival.duplicates
                     << " reordered " << r.arrival.reordered << " late " << r.jb.late << " lost " << r.jb.lost
                     << " underruns " << r.jb.underruns << " rebuffers " << r.jb.rebuffers);
    CHECK(s.testDropped > 0);
    CHECK(r.arrival.lostEstimate > 0);
    CHECK(r.arrival.duplicates > 0);
    CHECK(r.arrival.reordered + r.jb.late > 0);
    CHECK(r.concealed > 0);           // Opus PLC on the live monitor path
    CHECK(r.jb.rebuffers > 0);        // the 300 ms bursts exceed the stall limit (20 frames)
    CHECK(r.jb.played > 100);         // and playback resumed after each
    CHECK(r.decodeErrors == 0);
    CHECK(r.outputPeakDbfs > -20.0f);
    rig.receiver.stop();
    rig.sender.stop();
}

TEST_CASE("The receiver rejects malformed, oversized and wrong-session datagrams and keeps playing", "[media][live]")
{
    // The test plays the producer: a socket bound to the producer's media port.
    std::string error;
    initSockets(error);
    UdpSocket fakeProducer;
    REQUIRE(fakeProducer.bindOn("127.0.0.1", 52163, error));
    LiveReceiver receiver;
    LiveReceiverConfig rc;
    rc.producerHost = "127.0.0.1";
    rc.mediaPort = 52163;
    rc.sessionId = kSession;
    REQUIRE(receiver.start(rc, error));
    receiver.setOutputEnabled(true);

    // Learn the receiver's address from its first report.
    uint8_t buf[UdpSocket::kMaxDatagram];
    Endpoint performer;
    for (int i = 0; i < 100 && !performer.valid(); ++i)
    {
        fakeProducer.waitReadable(20);
        if (fakeProducer.recv_from(buf, sizeof buf, performer, error) <= 0)
        {
            performer = Endpoint{};
        }
    }
    REQUIRE(performer.valid());

    OpusLiveEncoder enc;
    REQUIRE(enc.create(LiveCodecSettings{}, error));
    std::vector<float> pcm(480, 0.1f);
    uint8_t opus[1276];
    const int bytes = enc.encode(pcm.data(), opus, sizeof opus);
    REQUIRE(bytes > 0);
    auto make = [&](uint32_t seq, uint32_t session)
    {
        MediaHeader h;
        h.seq = seq;
        h.mediaIndex = seq * 480ull;
        h.sessionId = session;
        h.flags = kCodecOpus;
        std::vector<uint8_t> d(kMediaHeaderBytes + static_cast<size_t>(bytes));
        writePacket(h, opus, static_cast<size_t>(bytes), d.data(), d.size());
        return d;
    };
    auto send = [&](const std::vector<uint8_t>& d) { fakeProducer.send_to(performer, d.data(), d.size(), error); };

    std::vector<float> out(480 * 2);
    for (uint32_t seq = 0; seq < 60; ++seq)
    {
        send(make(seq, kSession));                    // valid
        auto badCrc = make(seq, kSession);
        badCrc[30] ^= 0x55;
        send(badCrc);
        send(make(seq, 0x0BADBAD0u));                 // another session
        auto truncated = make(seq, kSession);
        truncated.resize(20);
        send(truncated);
        auto oldVersion = make(seq, kSession);
        oldVersion[20] = 0x00;                       // a prototype-format packet
        send(oldVersion);
        send(std::vector<uint8_t>(3000, 0xAB));  // larger than any valid datagram
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        std::fill(out.begin(), out.end(), 0.0f);
        receiver.renderAdd(out.data(), 480, 2, 48000);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    const auto r = receiver.stats();
    INFO("crc " << r.invalid.badCrc << " session " << r.invalid.badSession << " len " << r.invalid.badLength
                << " version " << r.invalid.badVersion << " oversized " << r.invalid.oversized);
    CHECK(r.arrival.received == 60);
    CHECK(r.invalid.badCrc == 60);
    CHECK(r.invalid.badSession == 60);
    CHECK(r.invalid.badVersion == 60);
    // A 3000-byte datagram is reported as oversized (Windows) or truncated and refused by length
    // (POSIX); a 20-byte one is refused by length.
    CHECK(r.invalid.badLength + r.invalid.oversized == 120);
    CHECK(r.jb.played > 40);
    CHECK(r.decodeErrors == 0);
    receiver.stop();
}

TEST_CASE("Live output can be switched off: nothing is added to the output", "[media][live]")
{
    Rig rig;
    REQUIRE(rig.start(52164));
    rig.run(100);
    rig.receiver.setOutputEnabled(false);
    rig.outEnergy = 0.0;
    rig.run(50);
    CHECK(rig.outEnergy == 0.0);
    CHECK_FALSE(rig.receiver.stats().jbPlaying);
    rig.receiver.setOutputEnabled(true);
    rig.run(50);
    CHECK(rig.outEnergy > 0.0);
    rig.receiver.stop();
    rig.sender.stop();
}

TEST_CASE("The producer ignores reports from other addresses and other sessions", "[media][live]")
{
    LiveTap tap;
    tap.setSourceRate(48000);
    LiveSender sender;
    LiveSenderConfig sc;
    sc.bindAddress = "127.0.0.1";
    sc.mediaPort = 52165;
    sc.sessionId = kSession;
    sc.expectedPeerAddress = "127.0.0.2";  // the performer is "elsewhere"
    std::string error;
    REQUIRE(sender.start(sc, tap, error));
    sender.setSending(true);

    UdpSocket stranger;
    REQUIRE(stranger.connectTo("127.0.0.1", 52165, error));
    ReceiverReport rep;
    uint8_t body[ReceiverReport::kBytes];
    writeReport(rep, body);
    MediaHeader h;
    h.type = PacketType::ReceiverReport;
    h.sessionId = kSession;
    uint8_t d[kMediaHeaderBytes + ReceiverReport::kBytes];
    const size_t n = writePacket(h, body, sizeof body, d, sizeof d);
    for (int i = 0; i < 5; ++i)
    {
        stranger.send(d, n, error);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    auto s = sender.stats();
    CHECK(s.invalid.srcRejected == 5);
    CHECK_FALSE(s.peerKnown);
    CHECK(s.packetsSent == 0);
    CHECK_FALSE(tap.isEnabled());
    sender.stop();

    // Right address, wrong session.
    sc.expectedPeerAddress = "127.0.0.1";
    REQUIRE(sender.start(sc, tap, error));
    sender.setSending(true);
    h.sessionId = 0x12345678u;
    const size_t m = writePacket(h, body, sizeof body, d, sizeof d);
    for (int i = 0; i < 5; ++i)
    {
        stranger.send(d, m, error);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    s = sender.stats();
    CHECK(s.invalid.badSession == 5);
    CHECK_FALSE(s.peerKnown);
    sender.stop();
}
