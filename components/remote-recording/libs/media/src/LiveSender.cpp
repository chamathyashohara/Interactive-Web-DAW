#include "rr/media/LiveSender.h"

LiveSender::LiveSender(Logger* logger) : endpoint(logger) {}

LiveSender::~LiveSender()
{
    stop();
}

bool LiveSender::start(const LiveSenderConfig& config, LiveTap& tap, std::string& error)
{
    LiveEndpointConfig c;
    c.bindMode = true;
    c.localAddress = config.bindAddress;
    c.peerAddress = config.expectedPeerAddress;
    c.mediaPort = config.mediaPort;
    c.sessionId = config.sessionId;
    c.hasOutgoing = true;
    c.outgoing.streamId = kStreamProducerMic;
    c.outgoing.codec = config.codec;
    c.outgoing.maxBacklogFrames = config.maxBacklogFrames;
    c.outgoing.testImpairment = config.testImpairment;
    c.hasIncoming = false;
    c.peerTimeoutMs = config.peerTimeoutMs;
    if (!endpoint.start(c, &tap, error))
    {
        return false;
    }
    endpoint.getOutgoing()->setEnabled(sending.load());
    return true;
}

void LiveSender::stop()
{
    endpoint.stop();
}

void LiveSender::setSending(bool on) noexcept
{
    sending.store(on);
    if (OutgoingStream* out = endpoint.getOutgoing())
    {
        out->setEnabled(on);
    }
}

LiveSenderStats LiveSender::stats() const
{
    LiveSenderStats s;
    const EndpointStats e = endpoint.stats();
    s.running = endpoint.isRunning();
    s.sendingEnabled = sending.load();
    s.localEndpoint = e.localEndpoint;
    // Stage 7 meaning: "the performer can be sent to now".
    s.peerKnown = e.peerReachable;
    s.peerEndpoint = e.peerReachable ? e.peerEndpoint : std::string();
    s.reportsReceived = e.reportsReceived;
    s.peerTimeouts = e.peerTimeouts;
    s.invalid = e.invalid;
    s.hasReport = e.hasRemoteReport;
    s.lastReport = e.remoteReport;
    s.lastReportAgeMs = e.remoteReportAgeMs;
    if (const OutgoingStream* out = endpoint.getOutgoing())
    {
        const OutgoingStats o = out->stats();
        s.streaming = o.streaming;
        s.streamsStarted = o.streamsStarted;
        s.framesEncoded = o.framesEncoded;
        s.packetsSent = o.packetsSent;
        s.bytesSent = o.bytesSent;
        s.sendErrors = o.sendErrors;
        s.encodeErrors = o.encodeErrors;
        s.endOfStreamSent = o.endOfStreamSent;
        s.tapGapFrames = o.tapGapFrames;
        s.backlogTrimFrames = o.backlogTrimFrames;
        s.testDropped = o.testDropped;
        s.testDuplicated = o.testDuplicated;
        s.testReordered = o.testReordered;
        s.maxEncodeNs = o.maxEncodeNs;
        s.opus_version = o.opus_version;
        s.application = o.application;
        s.frameSamples = o.frameSamples;
        s.bitrateBps = o.bitrateBps;
        s.complexity = o.complexity;
        s.lookaheadSamples = o.lookaheadSamples;
        s.tap = o.tap;
    }
    return s;
}

