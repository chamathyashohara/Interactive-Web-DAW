// Two-way live audio (Stage 8, ADR-018): producer endpoint (sends stream 1, receives stream 2)
// and performer endpoint (sends stream 2, receives stream 1) over loopback UDP.
//
// TEST SIGNALS AND TEST CLOCK - the producer "microphone" is a 440 Hz sine and the performer's a
// 660 Hz sine, pushed into LiveTaps every 10 ms as the capture callbacks would; renderAdd() is
// called every 10 ms as the playback callbacks would. Real sockets and Opus, no audio hardware.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cmath>
#include <thread>
#include <vector>

#include "rr/audio/LiveTap.h"
#include "rr/media/LiveEndpoint.h"

namespace
{

constexpr uint32_t kSession = 0x5eed0002u;
constexpr double kPi = 3.14159265358979323846;

// Share of the energy of x at hz (Goertzel), 0..1.
double toneShare(const std::vector<float>& x, double hz)
{
    const double w = 2.0 * kPi * hz / 48000.0;
    const double coeff = 2.0 * std::cos(w);
    double s1 = 0.0;
    double s2 = 0.0;
    double energy = 0.0;
    for (const float v : x)
    {
        const double s0 = v + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
        energy += static_cast<double>(v) * v;
    }
    const double power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    return energy > 0.0 ? 2.0 * power / (static_cast<double>(x.size()) * energy) : 0.0;
}

double rms(const std::vector<float>& x)
{
    double e = 0.0;
    for (const float v : x)
    {
        e += static_cast<double>(v) * v;
    }
    return x.empty() ? 0.0 : std::sqrt(e / static_cast<double>(x.size()));
}

struct Side
{
    LiveTap tap;
    LiveEndpoint endpoint;
    double hz;
    uint64_t phase = 0;
    std::vector<float> heard;  // mono output of this side, collected while `collect` is set

    explicit Side(double tone) : hz(tone) { tap.setSourceRate(48000); }

    void tick(bool collect)
    {
        float in[480];
        for (size_t i = 0; i < 480; ++i)
        {
            in[i] = 0.25f * static_cast<float>(std::sin(2.0 * kPi * hz * static_cast<double>(phase + i) / 48000.0));
        }
        phase += 480;
        tap.pushCapture(in, 480, 1);
        float out[480] = {};
        endpoint.getIncoming()->renderAdd(out, 480, 1, 48000);
        if (collect)
        {
            heard.insert(heard.end(), out, out + 480);
        }
    }
};

struct Duplex
{
    Side producer{440.0};
    Side performer{660.0};

    bool start(uint16_t port, const ImpairmentSettings& producerOut = {}, const ImpairmentSettings& performerOut = {})
    {
        std::string error;
        LiveEndpointConfig p;
        p.bindMode = true;
        p.localAddress = "127.0.0.1";
        p.peerAddress = "127.0.0.1";
        p.mediaPort = port;
        p.sessionId = kSession;
        p.hasOutgoing = true;
        p.outgoing.streamId = kStreamProducerMic;
        p.outgoing.testImpairment = producerOut;
        p.hasIncoming = true;
        p.incoming.streamId = kStreamPerformerMic;
        p.incoming.playout.gainDb = 0.0f;
        if (!producer.endpoint.start(p, &producer.tap, error))
        {
            UNSCOPED_INFO(error);
            return false;
        }
        LiveEndpointConfig r;
        r.bindMode = false;
        r.peerAddress = "127.0.0.1";
        r.mediaPort = port;
        r.sessionId = kSession;
        r.hasOutgoing = true;
        r.outgoing.streamId = kStreamPerformerMic;
        r.outgoing.testImpairment = performerOut;
        r.hasIncoming = true;
        r.incoming.streamId = kStreamProducerMic;
        r.incoming.playout.gainDb = 0.0f;
        if (!performer.endpoint.start(r, &performer.tap, error))
        {
            UNSCOPED_INFO(error);
            return false;
        }
        for (Side* s : {&producer, &performer})
        {
            s->endpoint.getOutgoing()->setEnabled(true);
            s->endpoint.getIncoming()->setOutputEnabled(true);
        }
        return true;
    }

    void run(int ticks, bool collect = true)
    {
        for (int i = 0; i < ticks; ++i)
        {
            producer.tick(collect);
            performer.tick(collect);
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    }

    void clear()
    {
        producer.heard.clear();
        performer.heard.clear();
    }

    void stop()
    {
        performer.endpoint.stop();
        producer.endpoint.stop();
    }
};

}  // namespace

TEST_CASE("Both directions carry live audio at once, each side hearing the other and not itself", "[media][duplex]")
{
    Duplex d;
    REQUIRE(d.start(52171));
    d.run(100, false);  // warm up: learn the peer, fill the jitter buffers
    d.clear();
    d.run(200);

    const auto po = d.producer.endpoint.getOutgoing()->stats();
    const auto pi = d.producer.endpoint.getIncoming()->stats();
    const auto ro = d.performer.endpoint.getOutgoing()->stats();
    const auto ri = d.performer.endpoint.getIncoming()->stats();
    const auto pe = d.producer.endpoint.stats();
    const auto re = d.performer.endpoint.stats();

    // Distinct streams, each with its own counters.
    CHECK(po.streamId == kStreamProducerMic);
    CHECK(ro.streamId == kStreamPerformerMic);
    CHECK(pi.streamId == kStreamPerformerMic);
    CHECK(ri.streamId == kStreamProducerMic);
    CHECK(po.packetsSent > 250);
    CHECK(ro.packetsSent > 250);
    CHECK(ri.arrival.received > 250);
    CHECK(pi.arrival.received > 250);
    CHECK(ri.arrival.lostEstimate == 0);
    CHECK(pi.arrival.lostEstimate == 0);
    CHECK(pe.invalid.total() == 0);
    CHECK(re.invalid.total() == 0);
    // Each side has the other's report about its own outgoing stream.
    CHECK(pe.hasRemoteReport);
    CHECK(re.hasRemoteReport);
    CHECK(pe.remoteReport.received > 0);
    CHECK(re.remoteReport.received > 0);

    // The producer hears 660 Hz (the performer), the performer hears 440 Hz (the producer).
    INFO("producer hears 660: " << toneShare(d.producer.heard, 660.0) << ", 440: " << toneShare(d.producer.heard, 440.0));
    INFO("performer hears 440: " << toneShare(d.performer.heard, 440.0) << ", 660: " << toneShare(d.performer.heard, 660.0));
    CHECK(toneShare(d.producer.heard, 660.0) > 0.9);
    CHECK(toneShare(d.producer.heard, 440.0) < 0.01);
    CHECK(toneShare(d.performer.heard, 440.0) > 0.9);
    CHECK(toneShare(d.performer.heard, 660.0) < 0.01);
    d.stop();
}

TEST_CASE("Send mute, receive mute and gain are independent per direction and per side", "[media][duplex]")
{
    Duplex d;
    REQUIRE(d.start(52172));
    d.run(100, false);

    SECTION("performer mutes its microphone: the stream keeps running, flagged, as silence")
    {
        d.performer.endpoint.getOutgoing()->setMuted(true);
        d.run(50, false);
        d.clear();
        d.run(100);
        const auto ro = d.performer.endpoint.getOutgoing()->stats();
        const auto pi = d.producer.endpoint.getIncoming()->stats();
        CHECK(ro.streaming);
        CHECK(ro.muted);
        CHECK(ro.mutedFrames > 50);
        CHECK(pi.remoteMuted);           // the producer can show "performer muted"
        CHECK(pi.remoteStreaming);       // ... and not a network failure
        CHECK(rms(d.producer.heard) < 1e-3);
        // The other direction is untouched.
        CHECK_FALSE(d.producer.endpoint.getOutgoing()->stats().muted);
        CHECK(toneShare(d.performer.heard, 440.0) > 0.9);
        CHECK(rms(d.performer.heard) > 0.1);
        // Unmute: audio is back.
        d.performer.endpoint.getOutgoing()->setMuted(false);
        d.run(50, false);
        d.clear();
        d.run(50);
        CHECK_FALSE(d.producer.endpoint.getIncoming()->stats().remoteMuted);
        CHECK(toneShare(d.producer.heard, 660.0) > 0.9);
    }
    SECTION("producer switches off hearing: nothing plays, but the stream is still received and counted")
    {
        const auto before = d.producer.endpoint.getIncoming()->stats().arrival.received;
        d.producer.endpoint.getIncoming()->setOutputEnabled(false);
        d.clear();
        d.run(100);
        const auto pi = d.producer.endpoint.getIncoming()->stats();
        CHECK(rms(d.producer.heard) == 0.0);
        CHECK(pi.arrival.received > before + 80);
        CHECK_FALSE(pi.jbPlaying);
        // The performer still hears the producer.
        CHECK(toneShare(d.performer.heard, 440.0) > 0.9);
        // ... and can see that the producer is not listening (report flag).
        d.run(60, false);
        const auto re = d.performer.endpoint.stats();
        CHECK(re.hasRemoteReport);
        CHECK((re.remoteReport.flags & ReceiverReport::kFlagPlaying) == 0u);
    }
    SECTION("gain applies to one incoming stream only")
    {
        d.performer.endpoint.getIncoming()->setGainDb(-20.0f);
        d.run(20, false);
        d.clear();
        d.run(100);
        const double performerLevel = rms(d.performer.heard);
        const double producerLevel = rms(d.producer.heard);
        INFO("performer " << performerLevel << " producer " << producerLevel);
        CHECK(performerLevel < producerLevel * 0.15);  // -20 dB = x0.1
        CHECK(performerLevel > producerLevel * 0.07);
    }
    d.stop();
}

TEST_CASE("Asymmetric failure: one direction dies, the other continues while the control link is up", "[media][duplex]")
{
    Duplex d;
    REQUIRE(d.start(52173));
    d.producer.endpoint.setControlLinkUp(true);
    d.performer.endpoint.setControlLinkUp(true);
    d.run(100, false);

    // Everything producer -> performer is lost from now on (audio AND reports).
    d.performer.endpoint.setTestReceiveBlackhole(true);
    d.run(400, false);  // 4 s: longer than the 3 s peer timeout
    d.clear();
    d.run(100);
    const auto re = d.performer.endpoint.stats();
    const auto ri = d.performer.endpoint.getIncoming()->stats();
    CHECK(re.testBlackholed > 100);
    CHECK_FALSE(re.peerHeard);
    CHECK(re.peerReachable);                       // control link up: keep sending
    CHECK(re.peerTimeouts == 1);
    CHECK_FALSE(ri.remoteStreaming);               // performer sees its incoming stream stopped
    CHECK(d.performer.endpoint.getOutgoing()->stats().streaming);
    CHECK(toneShare(d.producer.heard, 660.0) > 0.9);   // the producer still hears the performer
    CHECK(d.producer.endpoint.getIncoming()->stats().jb.underruns == 0);

    // Recovery when the path comes back.
    d.performer.endpoint.setTestReceiveBlackhole(false);
    d.run(100, false);
    d.clear();
    d.run(100);
    CHECK(d.performer.endpoint.stats().peerHeard);
    CHECK(toneShare(d.performer.heard, 440.0) > 0.9);
    d.stop();
}

TEST_CASE("Without the control-link hint a silent peer stops this side sending (no blind sending)", "[media][duplex]")
{
    Duplex d;
    REQUIRE(d.start(52174));
    d.run(100, false);
    d.performer.endpoint.setTestReceiveBlackhole(true);
    d.run(400, false);
    CHECK_FALSE(d.performer.endpoint.stats().peerReachable);
    CHECK_FALSE(d.performer.endpoint.getOutgoing()->stats().streaming);
    // The performer stopped sending audio, but its reports about stream 1 still reach the
    // producer, so the producer still considers it reachable and keeps sending.
    CHECK(d.producer.endpoint.stats().peerReachable);
    CHECK(d.producer.endpoint.getOutgoing()->stats().streaming);
    d.stop();
}

TEST_CASE("A side's own stream coming back, and reports about the wrong stream, are refused", "[media][duplex]")
{
    std::string error;
    initSockets(error);
    LiveTap tap;
    tap.setSourceRate(48000);
    LiveEndpoint producer;
    LiveEndpointConfig p;
    p.bindMode = true;
    p.localAddress = "127.0.0.1";
    p.peerAddress = "127.0.0.1";
    p.mediaPort = 52175;
    p.sessionId = kSession;
    p.hasOutgoing = true;
    p.outgoing.streamId = kStreamProducerMic;
    p.hasIncoming = true;
    p.incoming.streamId = kStreamPerformerMic;
    REQUIRE(producer.start(p, &tap, error));

    UdpSocket fake;
    REQUIRE(fake.connectTo("127.0.0.1", 52175, error));
    OpusLiveEncoder enc;
    REQUIRE(enc.create(LiveCodecSettings{}, error));
    std::vector<float> pcm(480, 0.1f);
    uint8_t opus[1276];
    const int bytes = enc.encode(pcm.data(), opus, sizeof opus);
    REQUIRE(bytes > 0);
    for (uint32_t seq = 0; seq < 10; ++seq)
    {
        MediaHeader h;
        h.seq = seq;
        h.sessionId = kSession;
        h.streamId = kStreamProducerMic;  // the producer's OWN stream (echoed back)
        h.flags = kCodecOpus;
        uint8_t d[kMaxDatagramBytes];
        const size_t n = writePacket(h, opus, static_cast<size_t>(bytes), d, sizeof d);
        fake.send(d, n, error);
        ReceiverReport rep;
        uint8_t body[ReceiverReport::kBytes];
        writeReport(rep, body);
        MediaHeader rh;
        rh.type = PacketType::ReceiverReport;
        rh.sessionId = kSession;
        rh.streamId = kStreamPerformerMic;  // a report about a stream the producer does not send
        const size_t m = writePacket(rh, body, sizeof body, d, sizeof d);
        fake.send(d, m, error);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    const auto s = producer.stats();
    CHECK(s.invalid.wrongStream == 20);
    CHECK_FALSE(s.peerKnown);  // nothing valid arrived, so no endpoint was learned
    CHECK(producer.getIncoming()->stats().arrival.received == 0);
    producer.stop();
}

TEST_CASE("Excessive buffering is bounded: sender backlog trim and receiver catch-up", "[media][duplex]")
{
    Duplex d;
    REQUIRE(d.start(52176));
    d.run(100, false);

    // Sender side: 200 ms of capture arrives at once (a stalled sender thread looks the same).
    std::vector<float> block(9600, 0.0f);
    d.producer.tap.pushCapture(block.data(), 9600, 1);
    d.run(20, false);
    CHECK(d.producer.endpoint.getOutgoing()->stats().backlogTrimFrames >= 9600 - 6 * 480);

    // Receiver side: the performer's playback stalls for 300 ms (no render), then resumes.
    for (int i = 0; i < 30; ++i)
    {
        float in[480] = {};
        d.producer.tap.pushCapture(in, 480, 1);
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    d.run(20, false);
    const auto ri = d.performer.endpoint.getIncoming()->stats();
    INFO("catch-up frames " << ri.jb.catchupFrames << ", held " << ri.jbHeld << ", max held " << ri.jbMaxHeld);
    CHECK(ri.jb.catchupFrames >= 15);
    CHECK(ri.jbHeld <= ri.jbTarget + 2);
    CHECK(ri.queueFullDrops == 0);  // 30 packets fit the 64-slot queue
    d.stop();
}

TEST_CASE("After a pause the resumed stream is heard at once (sequence continues, no false duplicates)", "[media][duplex]")
{
    Duplex d;
    REQUIRE(d.start(52177));
    d.run(150, false);
    d.performer.endpoint.getOutgoing()->setEnabled(false);  // pause (END_OF_STREAM)
    d.run(50, false);
    d.performer.endpoint.getOutgoing()->setEnabled(true);
    d.run(30, false);
    d.clear();
    d.run(100);
    const auto pi = d.producer.endpoint.getIncoming()->stats();
    CHECK(pi.arrival.duplicates == 0);
    CHECK(pi.arrival.lostEstimate == 0);
    CHECK(d.performer.endpoint.getOutgoing()->stats().streamsStarted == 2);
    CHECK(toneShare(d.producer.heard, 660.0) > 0.9);
    d.stop();
}
