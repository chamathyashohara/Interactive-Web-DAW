#include "rr/media/LiveEndpoint.h"

#include "rr/shared/Clock.h"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <timeapi.h>
#endif

LiveEndpoint::LiveEndpoint(Logger* logger) : log(logger) {}

LiveEndpoint::~LiveEndpoint()
{
    stop();
}

bool LiveEndpoint::start(const LiveEndpointConfig& config, LiveTap* tap, std::string& error)
{
    stop();
    if (config.sessionId == 0 || config.mediaPort == 0)
    {
        error = "live media needs a session id and a media port";
        return false;
    }
    if (!config.hasOutgoing && !config.hasIncoming)
    {
        error = "live media endpoint without any stream";
        return false;
    }
    if (config.hasOutgoing && tap == nullptr)
    {
        error = "live media: no capture tap for the outgoing stream";
        return false;
    }
    if (config.hasOutgoing && config.hasIncoming && config.outgoing.streamId == config.incoming.streamId)
    {
        error = "live media: incoming and outgoing stream ids must differ";
        return false;
    }
    if (!initSockets(error))
    {
        return false;
    }
    if (config.bindMode)
    {
        if (!parseEndpoint(config.peerAddress, 1, expectedPeer))
        {
            error = "live media: the performer's address is not known yet";
            return false;
        }
    }
    else if (!parseEndpoint(config.peerAddress, config.mediaPort, expectedPeer))
    {
        error = "not an IPv4 address: " + config.peerAddress;
        return false;
    }
    outgoing.reset();
    incoming.reset();
    if (config.hasOutgoing)
    {
        auto out = std::make_unique<OutgoingStream>();
        OutgoingConfig oc = config.outgoing;
        oc.sessionId = config.sessionId;
        if (!out->create(oc, *tap, error))
        {
            return false;
        }
        outgoing = std::move(out);
    }
    if (config.hasIncoming)
    {
        auto in = std::make_unique<IncomingStream>();
        if (!in->create(config.incoming, error))
        {
            outgoing.reset();
            return false;
        }
        incoming = std::move(in);
    }
    const bool ok = config.bindMode ? socket.bindOn(config.localAddress, config.mediaPort, error)
                                     : socket.connectTo(config.peerAddress, config.mediaPort, error);
    if (!ok)
    {
        outgoing.reset();
        incoming.reset();
        return false;
    }
    cfg = config;
    {
        std::lock_guard<std::mutex> lock(mutex);
        peerKnown = !config.bindMode;
        peer = config.bindMode ? Endpoint{} : expectedPeer;
        peerClosed = false;
        wasHeard = false;
        lastRxNs = 0;
        peerTimeouts = reportsSent = reportErrors = reportsReceived = blackholed = 0;
        reportSeq = 0;
        invalid = InvalidCounts{};
        hasRemoteReport = false;
        remoteReport = ReceiverReport{};
        remoteReportNs = 0;
    }
    stopRequested.store(false);
    running.store(true);
    thread = std::thread([this] { threadMain(); });
    if (log != nullptr)
    {
        std::vector<Field> fields{
            {"role", config.bindMode ? "producer" : "performer"},
            {"local", socket.localEndpoint().text()},
            {"peer", config.peerAddress},
            {"outgoing_stream", config.hasOutgoing ? std::to_string(config.outgoing.streamId) : "none"},
            {"incoming_stream", config.hasIncoming ? std::to_string(config.incoming.streamId) : "none"}};
        if (outgoing)
        {
            const auto s = outgoing->stats();
            fields.push_back({"codec", s.opus_version});
            fields.push_back({"application", s.application});
            fields.push_back({"frame_samples", std::to_string(s.frameSamples)});
            fields.push_back({"bitrate_bps", std::to_string(s.bitrateBps)});
            fields.push_back({"complexity", std::to_string(s.complexity)});
            fields.push_back({"cbr", config.outgoing.codec.constantBitrate ? "1" : "0"});
            fields.push_back({"lookahead_samples", std::to_string(s.lookaheadSamples)});
            fields.push_back({"test_impairment", config.outgoing.testImpairment.active() ? "ON (test only)" : "off"});
        }
        if (incoming)
        {
            fields.push_back({"jitter_target_frames", std::to_string(config.incoming.playout.targetFrames)});
            fields.push_back({"gain_db", std::to_string(config.incoming.playout.gainDb)});
        }
        Record r;
        r.monoNs = monotonicNs();
        r.utcMs = utcNowMs();
        r.level = Level::Info;
        r.component = "live";
        r.event = "endpoint_started";
        r.message = "live media endpoint started";
        r.fields = std::move(fields);
        log->submit(std::move(r));
    }
    return true;
}

void LiveEndpoint::stop()
{
    if (thread.joinable())
    {
        stopRequested.store(true);
        thread.join();
        if (log != nullptr)
        {
            std::vector<Field> fields;
            if (outgoing)
            {
                const auto s = outgoing->stats();
                fields.push_back({"out_stream", std::to_string(s.streamId)});
                fields.push_back({"packets_sent", std::to_string(s.packetsSent)});
                fields.push_back({"send_errors", std::to_string(s.sendErrors)});
                fields.push_back({"muted_frames", std::to_string(s.mutedFrames)});
                fields.push_back({"tap_gap_frames", std::to_string(s.tapGapFrames)});
                fields.push_back({"backlog_trim_frames", std::to_string(s.backlogTrimFrames)});
            }
            if (incoming)
            {
                const auto s = incoming->stats();
                fields.push_back({"in_stream", std::to_string(s.streamId)});
                fields.push_back({"received", std::to_string(s.arrival.received)});
                fields.push_back({"lost_estimate", std::to_string(s.arrival.lostEstimate)});
                fields.push_back({"late", std::to_string(s.jb.late)});
                fields.push_back({"underruns", std::to_string(s.jb.underruns)});
                fields.push_back({"queue_full_drops", std::to_string(s.queueFullDrops)});
            }
            fields.push_back({"invalid", std::to_string(stats().invalid.total())});
            Record r;
            r.monoNs = monotonicNs();
            r.utcMs = utcNowMs();
            r.level = Level::Info;
            r.component = "live";
            r.event = "endpoint_stopped";
            r.message = "live media endpoint stopped";
            r.fields = std::move(fields);
            log->submit(std::move(r));
        }
    }
    socket.close();
    running.store(false);
}

bool LiveEndpoint::sendDatagram(const uint8_t* d, size_t n)
{
    Endpoint to;
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (!peerKnown)
        {
            return false;
        }
        to = peer;
    }
    std::string error;
    const long sent = cfg.bindMode ? socket.send_to(to, d, n, error) : socket.send(d, n, error);
    return sent == static_cast<long>(n);
}

void LiveEndpoint::sendReport(bool closing)
{
    if (!incoming)
    {
        return;
    }
    uint32_t invalidCount = 0;
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (!peerKnown)
        {
            return;
        }
        invalidCount = static_cast<uint32_t>(invalid.total());
    }
    const ReceiverReport r = incoming->makeReport(closing, invalidCount);
    uint8_t payload[ReceiverReport::kBytes];
    writeReport(r, payload);
    MediaHeader h;
    h.type = PacketType::ReceiverReport;
    h.sessionId = cfg.sessionId;
    h.streamId = cfg.incoming.streamId;
    h.flags = 0;
    uint8_t datagram[kMediaHeaderBytes + ReceiverReport::kBytes];
    {
        std::lock_guard<std::mutex> lock(mutex);
        h.seq = reportSeq++;
    }
    const size_t n = writePacket(h, payload, sizeof payload, datagram, sizeof datagram);
    const bool ok = sendDatagram(datagram, n);
    std::lock_guard<std::mutex> lock(mutex);
    ++(ok ? reportsSent : reportErrors);
}

void LiveEndpoint::handle(const uint8_t* data, long size, const Endpoint& from, int64_t now)
{
    // Step 1: source.
    {
        std::lock_guard<std::mutex> lock(mutex);
        const bool sourceOk = cfg.bindMode ? from.ip == expectedPeer.ip : from == expectedPeer;
        if (!sourceOk)
        {
            ++invalid.srcRejected;
            return;
        }
    }
    MediaHeader h;
    const uint8_t* payload = nullptr;
    const PacketCheck check = parsePacket(data, static_cast<size_t>(size), cfg.sessionId, h, payload);
    if (check != PacketCheck::Ok)
    {
        std::lock_guard<std::mutex> lock(mutex);
        invalid.count(check);
        return;
    }
    // Direction.
    bool accepted = false;
    bool closing = false;
    if (h.type == PacketType::ReceiverReport)
    {
        if (outgoing && h.streamId == cfg.outgoing.streamId)
        {
            const ReceiverReport r = readReport(payload);
            closing = (r.flags & ReceiverReport::kFlagClosing) != 0;
            std::lock_guard<std::mutex> lock(mutex);
            ++reportsReceived;
            hasRemoteReport = true;
            remoteReport = r;
            remoteReportNs = now;
            accepted = true;
        }
    }
    else if (incoming && h.streamId == cfg.incoming.streamId)
    {
        if (h.type == PacketType::Audio)
        {
            if (!incoming->onAudio(h, payload, now))
            {
                std::lock_guard<std::mutex> lock(mutex);
                ++invalid.badPayload;
                return;
            }
        }
        else
        {
            incoming->onEndOfStream();
        }
        accepted = true;
    }
    std::lock_guard<std::mutex> lock(mutex);
    if (!accepted)
    {
        ++invalid.wrongStream;
        return;
    }
    lastRxNs = now;
    if (cfg.bindMode && (!peerKnown || peer != from))
    {
        peerKnown = true;
        peer = from;
        if (log != nullptr)
        {
            log->log(Level::Info, "live", "peer_learned", "performer media endpoint learned from its datagrams",
                      {{"peer", from.text()}});
        }
    }
    if (closing)
    {
        if (!peerClosed && log != nullptr)
        {
            log->log(Level::Info, "live", "peer_closed", "remote side stopped its live media", {{"peer", from.text()}});
        }
        peerClosed = true;
    }
    else
    {
        peerClosed = false;
    }
}

bool LiveEndpoint::reachable(int64_t now)
{
    std::lock_guard<std::mutex> lock(mutex);
    const bool heard = lastRxNs != 0 && now - lastRxNs <= static_cast<int64_t>(cfg.peerTimeoutMs) * 1000000;
    if (wasHeard && !heard)
    {
        ++peerTimeouts;
        if (log != nullptr)
        {
            log->log(Level::Warn, "live", "peer_timeout", "no live datagram from the remote side",
                      {{"peer", peer.text()}, {"control_link_up", controlUp.load() ? "1" : "0"}});
        }
    }
    wasHeard = heard;
    return peerKnown && !peerClosed && (heard || controlUp.load());
}

void LiveEndpoint::threadMain()
{
#ifdef _WIN32
    // 1 ms timer resolution while live audio runs, so select() wakes promptly (default ~15.6 ms).
    if (cfg.hasOutgoing)
    {
        timeBeginPeriod(1);
    }
#endif
    const OutgoingStream::SendFn send = [this](const uint8_t* d, size_t n) { return sendDatagram(d, n); };
    uint8_t buffer[UdpSocket::kMaxDatagram];
    int64_t nextReport = monotonicNs();
    while (!stopRequested.load())
    {
        socket.waitReadable(cfg.hasOutgoing ? 1 : 20);
        for (int i = 0; i < 256; ++i)
        {
            Endpoint from;
            std::string error;
            const long n = socket.recv_from(buffer, sizeof buffer, from, error);
            if (n == 0)
            {
                break;
            }
            if (n == -3)
            {
                std::lock_guard<std::mutex> lock(mutex);
                ++invalid.oversized;
                continue;
            }
            if (n < 0)
            {
                if (log != nullptr)
                {
                    log->log(Level::Warn, "live", "receive_error", error);
                }
                break;
            }
            if (blackhole.load())
            {
                std::lock_guard<std::mutex> lock(mutex);
                ++blackholed;
                continue;
            }
            handle(buffer, n, from, monotonicNs());
        }
        const int64_t now = monotonicNs();
        const bool canSend = reachable(now);
        if (outgoing)
        {
            outgoing->pump(canSend, send);
        }
        if (incoming && now >= nextReport)
        {
            sendReport(false);
            nextReport = now + static_cast<int64_t>(cfg.reportIntervalMs) * 1000000;
        }
    }
    if (outgoing)
    {
        outgoing->finish(reachable(monotonicNs()), send);
    }
    // Tell the other side this direction is closing (twice: UDP may lose one; it also times out).
    sendReport(true);
    sendReport(true);
#ifdef _WIN32
    if (cfg.hasOutgoing)
    {
        timeEndPeriod(1);
    }
#endif
}

EndpointStats LiveEndpoint::stats() const
{
    const int64_t now = monotonicNs();
    std::lock_guard<std::mutex> lock(mutex);
    EndpointStats s;
    s.running = running.load();
    s.localEndpoint = socket.valid() ? socket.localEndpoint().text() : std::string();
    s.peerKnown = peerKnown;
    s.peerEndpoint = peerKnown ? peer.text() : std::string();
    s.peerHeard = lastRxNs != 0 && now - lastRxNs <= static_cast<int64_t>(cfg.peerTimeoutMs) * 1000000;
    s.peerClosed = peerClosed;
    s.controlLinkUp = controlUp.load();
    s.peerReachable = peerKnown && !peerClosed && (s.peerHeard || s.controlLinkUp);
    s.lastRxAgeMs = lastRxNs == 0 ? -1.0 : static_cast<double>(now - lastRxNs) / 1e6;
    s.peerTimeouts = peerTimeouts;
    s.reportsSent = reportsSent;
    s.reportSendErrors = reportErrors;
    s.reportsReceived = reportsReceived;
    s.testBlackholed = blackholed;
    s.invalid = invalid;
    s.hasRemoteReport = hasRemoteReport;
    s.remoteReport = remoteReport;
    s.remoteReportAgeMs = remoteReportNs == 0 ? -1.0 : static_cast<double>(now - remoteReportNs) / 1e6;
    return s;
}

