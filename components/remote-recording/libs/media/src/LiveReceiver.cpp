#include "rr/media/LiveReceiver.h"

LiveReceiver::LiveReceiver(Logger* logger) : endpoint(logger) {}

LiveReceiver::~LiveReceiver()
{
    stop();
}

bool LiveReceiver::start(const LiveReceiverConfig& config, std::string& error)
{
    LiveEndpointConfig c;
    c.bindMode = false;
    c.peerAddress = config.producerHost;
    c.mediaPort = config.mediaPort;
    c.sessionId = config.sessionId;
    c.hasOutgoing = false;
    c.hasIncoming = true;
    c.incoming.streamId = kStreamProducerMic;
    c.incoming.playout = config.playout;
    c.incoming.testReceiveImpairment = config.testReceiveImpairment;
    c.reportIntervalMs = config.reportIntervalMs;
    return endpoint.start(c, nullptr, error);
}

void LiveReceiver::stop()
{
    endpoint.stop();
}

void LiveReceiver::setOutputEnabled(bool on) noexcept
{
    if (IncomingStream* in = endpoint.getIncoming())
    {
        in->setOutputEnabled(on);
    }
}

bool LiveReceiver::outputEnabled() const noexcept
{
    const IncomingStream* in = endpoint.getIncoming();
    return in != nullptr && in->isOutputEnabled();
}

void LiveReceiver::setGainDb(float db) noexcept
{
    if (IncomingStream* in = endpoint.getIncoming())
    {
        in->setGainDb(db);
    }
}

void LiveReceiver::setTargetFrames(uint32_t frames) noexcept
{
    if (IncomingStream* in = endpoint.getIncoming())
    {
        in->setTargetFrames(frames);
    }
}

void LiveReceiver::renderAdd(float* out, uint32_t frames, uint32_t channels, uint32_t sampleRate) noexcept
{
    if (IncomingStream* in = endpoint.getIncoming())
    {
        in->renderAdd(out, frames, channels, sampleRate);
    }
}

LiveReceiverStats LiveReceiver::stats() const
{
    LiveReceiverStats s;
    const EndpointStats e = endpoint.stats();
    s.running = endpoint.isRunning();
    s.producerEndpoint = endpoint.config().peerAddress + ":" + std::to_string(endpoint.config().mediaPort);
    s.localEndpoint = e.localEndpoint;
    s.invalid = e.invalid;
    s.reportsSent = e.reportsSent;
    s.reportSendErrors = e.reportSendErrors;
    if (const IncomingStream* in = endpoint.getIncoming())
    {
        const IncomingStats i = in->stats();
        s.arrival = i.arrival;
        s.queueFullDrops = i.queueFullDrops;
        s.endOfStream = i.endOfStream;
        s.testDropped = i.testDropped;
        s.lastPacketAgeMs = i.lastPacketAgeMs;
        s.outputEnabled = i.outputEnabled;
        s.jbPlaying = i.jbPlaying;
        s.jbHeld = i.jbHeld;
        s.jbMaxHeld = i.jbMaxHeld;
        s.jbTarget = i.jbTarget;
        s.jb = i.jb;
        s.concealed = i.concealed;
        s.decodeErrors = i.decodeErrors;
        s.renderCallbacks = i.renderCallbacks;
        s.wrongRateCallbacks = i.wrongRateCallbacks;
        s.framesOutput = i.framesOutput;
        s.maxRenderNs = i.maxRenderNs;
        s.lastRenderAgeMs = i.lastRenderAgeMs;
        s.lastFrameSamples = i.lastFrameSamples;
        s.gainDb = i.gainDb;
        s.outputPeakDbfs = i.outputPeakDbfs;
    }
    return s;
}

