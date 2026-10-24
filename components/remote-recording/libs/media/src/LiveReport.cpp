#include "rr/media/LiveReport.h"

#include <cstdio>
#include <sstream>

namespace
{

std::string fmt(const char* format, double v)
{
    char b[64];
    std::snprintf(b, sizeof b, format, v);
    return b;
}

std::string streamName(uint16_t id)
{
    return id == kStreamProducerMic ? "stream 1, producer mic" : "stream 2, performer mic";
}

}  // namespace

std::string outgoingStatusText(const OutgoingStats& o, const EndpointStats& e)
{
    if (!o.enabled)
    {
        return "off (not sending)";
    }
    if (o.tap.sourceRate != 0 && o.tap.sourceRate != LiveTap::kRequiredRate)
    {
        return "cannot send: input runs at " + std::to_string(o.tap.sourceRate) + " Hz, live audio needs 48000 Hz";
    }
    if (o.tap.sourceRate == 0)
    {
        return "no input device open";
    }
    if (!e.peerKnown)
    {
        return "waiting for the remote side";
    }
    if (e.peerClosed)
    {
        return "paused: the remote side stopped its live audio";
    }
    if (!o.streaming)
    {
        return "paused: no datagram from the remote side for 3 s and no control link";
    }
    std::string s = o.muted ? "MUTED (the remote hears silence; your recording continues)" : "SENDING";
    s += " to " + e.peerEndpoint;
    if (e.hasRemoteReport)
    {
        s += (e.remoteReport.flags & ReceiverReport::kFlagPlaying) != 0 ? "; remote is listening"
                                                                          : "; remote has hearing switched off";
    }
    return s;
}

std::string incomingStatusText(const IncomingStats& i, const EndpointStats& e)
{
    std::string s;
    if (i.lastPacketAgeMs < 0.0)
    {
        s = "nothing received yet";
    }
    else if (!i.remoteStreaming)
    {
        s = i.endOfStream > 0 && i.lastPacketAgeMs < 3000.0
                ? "remote stopped sending"
                : "NO PACKETS for " + fmt("%.1f", i.lastPacketAgeMs / 1000.0) + " s (remote not sending, or the network/firewall blocks this direction)";
    }
    else if (i.remoteMuted)
    {
        s = "remote MUTED (receiving flagged silence)";
    }
    else
    {
        s = "receiving";
    }
    if (!i.outputEnabled)
    {
        s += "; hearing OFF on this PC";
    }
    else if (i.lastRenderAgeMs < 0.0 || i.lastRenderAgeMs > 1000.0)
    {
        s += "; no output device is playing";
    }
    else if (i.wrongRateCallbacks > 0 && i.renderCallbacks == i.wrongRateCallbacks)
    {
        s += "; output not at 48000 Hz";
    }
    else if (i.jbPlaying)
    {
        s += "; playing (peak " + fmt("%.1f", static_cast<double>(i.outputPeakDbfs)) + " dBFS)";
    }
    else
    {
        s += "; buffering";
    }
    (void)e;
    return s;
}

std::string liveReportText(const LiveReportConditions& c, const LiveEndpoint& endpoint)
{
    const EndpointStats e = endpoint.stats();
    const LiveEndpointConfig& cfg = endpoint.config();
    std::ostringstream o;
    o << "LIVE AUDIO DIAGNOSTICS (one page, rr.live_report.v1)\n";
    o << "Generated " << c.generatedUtc << " | " << c.role << " | " << c.appVersion << " | session " << c.sessionId << "\n";
    o << "Security: LAN-only, unencrypted, unauthenticated (ADR-012). Echo cancellation: NOT implemented\n";
    o << "(LATER-03); headphones are required on both PCs. Headphones: " << c.headphones << "\n";
    o << "\nCONDITIONS\n";
    o << "  Test set-up:   " << c.testConditions << "\n";
    o << "  Input:         " << c.captureDevice << " @ " << c.captureRate << " Hz\n";
    o << "  Output:        " << c.outputDevice << " @ " << c.outputRate << " Hz\n";
    o << "  Media socket:  " << e.localEndpoint << " <-> " << (e.peerKnown ? e.peerEndpoint : std::string("(not learned)"))
      << " (" << (cfg.bindMode ? "bound, peer learned" : "connected") << ")\n";
    if (const OutgoingStream* out = endpoint.getOutgoing())
    {
        const OutgoingStats s = out->stats();
        o << "  Send codec:    " << s.opus_version << ", " << s.application << ", " << fmt("%.1f", frameMs(s.frameSamples))
          << " ms frames, " << s.bitrateBps << " bit/s CBR, complexity " << s.complexity << ", lookahead "
          << s.lookaheadSamples << " samples" << (cfg.outgoing.testImpairment.active() ? ", TEST IMPAIRMENT ON" : "") << "\n";
    }
    if (const IncomingStream* in = endpoint.getIncoming())
    {
        const IncomingStats s = in->stats();
        o << "  Playout:       jitter target " << s.jbTarget << " frames, gain " << fmt("%.1f", static_cast<double>(s.gainDb))
          << " dB, stall limit " << cfg.incoming.playout.stallLimit << "\n";
    }
    o << "\nSTATUS (each line is independent)\n";
    o << "  Local capture:       " << c.localCaptureStatus << "\n";
    o << "  Local recording:     " << c.localRecordingStatus << "\n";
    if (const OutgoingStream* out = endpoint.getOutgoing())
    {
        o << "  Outgoing stream:     " << outgoingStatusText(out->stats(), e) << "\n";
    }
    if (const IncomingStream* in = endpoint.getIncoming())
    {
        o << "  Incoming stream:     " << incomingStatusText(in->stats(), e) << "\n";
    }
    o << "  Remote participant:  " << c.remoteParticipantStatus << "\n";

    if (const OutgoingStream* out = endpoint.getOutgoing())
    {
        const OutgoingStats s = out->stats();
        o << "\nOUTGOING  this PC -> remote (" << streamName(s.streamId) << ")\n";
        o << "  measured here:  packets " << s.packetsSent << " (" << s.bytesSent << " B), muted frames " << s.mutedFrames
          << ", send errors " << s.sendErrors << ", encode errors " << s.encodeErrors << ", capture-tap overflow "
          << s.tap.overflowEvents << " events/" << s.tapGapFrames << " frames, backlog trimmed " << s.backlogTrimFrames
          << " frames, max encode " << fmt("%.3f", static_cast<double>(s.maxEncodeNs) / 1e6) << " ms";
        if (cfg.outgoing.testImpairment.active())
        {
            o << ", TEST dropped/dup/reordered " << s.testDropped << "/" << s.testDuplicated << "/" << s.testReordered;
        }
        o << "\n";
        if (e.hasRemoteReport)
        {
            const ReceiverReport& r = e.remoteReport;
            o << "  remote reports (" << fmt("%.0f", e.remoteReportAgeMs) << " ms ago): received " << r.received
              << ", lost (est.) " << r.lostEstimate << ", late " << r.late << ", duplicates " << r.duplicates << ", reordered "
              << r.reordered << ", jitter " << fmt("%.3f", r.jitterUs / 1000.0) << " ms, buffer " << r.jbFill << "/"
              << r.jbTarget << ", underruns " << r.underruns << ", concealed " << r.concealed << ", decode errors "
              << r.decodeErrors << ", invalid " << r.invalidPackets << ", listening "
              << ((r.flags & ReceiverReport::kFlagPlaying) != 0 ? "yes" : "no") << "\n";
        }
        else
        {
            o << "  remote reports: none received\n";
        }
    }
    if (const IncomingStream* in = endpoint.getIncoming())
    {
        const IncomingStats s = in->stats();
        o << "\nINCOMING  remote -> this PC (" << streamName(s.streamId) << ")\n";
        o << "  arrival:   received " << s.arrival.received << " of " << s.arrival.expected << " expected, lost (est.) "
          << s.arrival.lostEstimate << ", duplicates " << s.arrival.duplicates << ", reordered " << s.arrival.reordered
          << ", stream restarts " << s.arrival.streamRestarts << ", end-of-stream " << s.endOfStream << "\n";
        o << "  timing:    inter-arrival jitter " << fmt("%.3f", s.arrival.jitterMs) << " ms, largest gap "
          << fmt("%.1f", s.arrival.maxGapMs) << " ms, last packet "
          << (s.lastPacketAgeMs < 0 ? std::string("never") : fmt("%.0f", s.lastPacketAgeMs) + " ms ago") << "\n";
        o << "  playout:   played " << s.jb.played << ", late " << s.jb.late << ", lost (concealed) " << s.jb.lost
          << ", underruns " << s.jb.underruns << ", concealed total " << s.concealed << ", refills " << s.jb.rebuffers
          << ", drift skips " << s.jb.driftSkips << ", catch-up frames " << s.jb.catchupFrames << ", resyncs "
          << s.jb.resyncs << "\n";
        o << "  buffers:   jitter " << s.jbHeld << "/" << s.jbTarget << " (max " << s.jbMaxHeld << "), packet queue full "
          << s.queueFullDrops << ", decode errors " << s.decodeErrors << ", max decode+mix "
          << fmt("%.3f", static_cast<double>(s.maxRenderNs) / 1e6) << " ms, wrong-rate callbacks " << s.wrongRateCallbacks
          << "\n";
    }
    o << "\nENDPOINT  invalid datagrams " << e.invalid.total() << " (source " << e.invalid.srcRejected << ", oversized "
      << e.invalid.oversized << ", length " << e.invalid.badLength << ", version " << e.invalid.badVersion << ", type "
      << e.invalid.badType << ", CRC " << e.invalid.badCrc << ", session " << e.invalid.badSession << ", payload "
      << e.invalid.badPayload << ", wrong stream " << e.invalid.wrongStream << "); peer timeouts " << e.peerTimeouts
      << "; reports sent " << e.reportsSent << "/received " << e.reportsReceived << "; control link "
      << (e.controlLinkUp ? "up" : "down") << "\n";
    if (e.testBlackholed > 0)
    {
        o << "  TEST receive blackhole dropped " << e.testBlackholed << " datagrams\n";
    }
    o << "\nTERMS: jitter = packet arrival variation, not latency. Loss is estimated from sequence numbers\n";
    o << "(loss after the last packet is invisible). Concealment affects listening only, never a recording.\n";
    o << "Acoustic (mouth-to-ear) latency is NOT measured by these counters.\n";
    return o.str();
}

