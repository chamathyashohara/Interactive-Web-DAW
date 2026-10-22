#include "rr/media/OutgoingStream.h"

#include <algorithm>

#include "rr/shared/Clock.h"

bool OutgoingStream::create(const OutgoingConfig& config, LiveTap& sourceTap, std::string& error)
{
    if (config.sessionId == 0)
    {
        error = "outgoing stream needs a session id";
        return false;
    }
    if (config.streamId != kStreamProducerMic && config.streamId != kStreamPerformerMic)
    {
        error = "unknown stream id " + std::to_string(config.streamId);
        return false;
    }
    if (!encoder.create(config.codec, error))
    {
        return false;
    }
    cfg = config;
    tap = &sourceTap;
    impairment = Impairment(config.testImpairment);
    frame.assign(config.codec.frameSamples, 0.0f);
    scratch.assign(4096, 0.0f);
    heldBack.clear();
    seq = 0;
    mediaIndex = 0;
    streaming.store(false);
    std::lock_guard<std::mutex> lock(mutex);
    counters = OutgoingStats{};
    counters.streamId = config.streamId;
    counters.opus_version = opus_version();
    counters.application = opus_application_name(config.codec.application);
    counters.frameSamples = config.codec.frameSamples;
    counters.bitrateBps = encoder.actualBitrate();
    counters.complexity = encoder.actualComplexity();
    counters.lookaheadSamples = encoder.lookaheadSamples();
    return true;
}

void OutgoingStream::discardTap(size_t samples)
{
    auto& ring = tap->getRing();
    while (samples > 0)
    {
        const size_t n = ring.read(scratch.data(), std::min(samples, scratch.size()));
        if (n == 0)
        {
            break;
        }
        samples -= n;
    }
}

void OutgoingStream::sendCounted(const SendFn& send, const uint8_t* d, size_t n, bool audio)
{
    const bool ok = send(d, n);
    std::lock_guard<std::mutex> lock(mutex);
    if (ok)
    {
        if (audio)
        {
            ++counters.packetsSent;  // AUDIO only, comparable with the receiver's count
        }
        counters.bytesSent += n;
    }
    else
    {
        ++counters.sendErrors;
    }
}

void OutgoingStream::sendEndOfStream(const SendFn& send)
{
    MediaHeader h;
    h.type = PacketType::EndOfStream;
    h.seq = seq;
    h.mediaIndex = mediaIndex;
    h.sessionId = cfg.sessionId;
    h.streamId = cfg.streamId;
    h.flags = 0;
    uint8_t datagram[kMediaHeaderBytes];
    const size_t n = writePacket(h, nullptr, 0, datagram, sizeof datagram);
    sendCounted(send, datagram, n, false);
    sendCounted(send, datagram, n, false);  // twice: UDP may lose one (the receiver also copes without it)
    std::lock_guard<std::mutex> lock(mutex);
    ++counters.endOfStreamSent;
}

void OutgoingStream::finish(bool canSend, const SendFn& send)
{
    if (tap == nullptr)
    {
        return;
    }
    tap->setEnabled(false);
    if (streaming.load())
    {
        if (canSend)
        {
            sendEndOfStream(send);
        }
        streaming.store(false);
    }
}

void OutgoingStream::pump(bool allowed, const SendFn& send)
{
    if (tap == nullptr)
    {
        return;
    }
    const bool want = enabled.load() && allowed;
    auto& ring = tap->getRing();
    if (want && !streaming.load())
    {
        // A new stream for the codec, but seq and mediaIndex CONTINUE for the endpoint's lifetime:
        // after a pause (switched off, or the peer was unreachable) the receiver must not mistake
        // the new packets for old ones (Stage 8 run D4b). They start at 0 only in create().
        encoder.reset();
        heldBack.clear();
        tapDropBase = tap->droppedFrames();
        discardTap(ring.readAvailable());
        tap->setEnabled(true);
        streaming.store(true);
        std::lock_guard<std::mutex> lock(mutex);
        ++counters.streamsStarted;
    }
    else if (!want && streaming.load())
    {
        tap->setEnabled(false);
        streaming.store(false);
        if (allowed)
        {
            sendEndOfStream(send);
        }
    }
    if (!streaming.load())
    {
        discardTap(ring.readAvailable());
        return;
    }

    // A tap overflow is a gap in the live stream: advance the sample counter so the receiver
    // can see it (approximate position: within one loop iteration).
    const uint64_t dropped = tap->droppedFrames();
    if (dropped > tapDropBase)
    {
        mediaIndex += dropped - tapDropBase;
        std::lock_guard<std::mutex> lock(mutex);
        counters.tapGapFrames += dropped - tapDropBase;
    }
    tapDropBase = dropped;

    const size_t frameLen = cfg.codec.frameSamples;
    const size_t available = ring.readAvailable();
    if (available > frameLen * cfg.maxBacklogFrames)
    {
        const size_t excess = available - frameLen;
        discardTap(excess);
        mediaIndex += excess;
        std::lock_guard<std::mutex> lock(mutex);
        counters.backlogTrimFrames += excess;
    }

    while (ring.readAvailable() >= frameLen)
    {
        ring.read(frame.data(), frameLen);
        const bool isMutedNow = muted.load();
        if (isMutedNow)
        {
            // Mute affects only what is SENT. The capture, the tap timing and the local
            // recording continue unchanged.
            std::fill(frame.begin(), frame.end(), 0.0f);
        }
        uint8_t opus_packet[kMaxOpusPacketBytes];
        const int64_t t0 = monotonicNs();
        const int bytes = encoder.encode(frame.data(), opus_packet, sizeof opus_packet);
        const int64_t took = monotonicNs() - t0;
        {
            std::lock_guard<std::mutex> lock(mutex);
            counters.maxEncodeNs = std::max(counters.maxEncodeNs, took);
            if (bytes <= 0)
            {
                ++counters.encodeErrors;
            }
            else
            {
                ++counters.framesEncoded;
                if (isMutedNow)
                {
                    ++counters.mutedFrames;
                }
            }
        }
        if (bytes > 0)
        {
            MediaHeader h;
            h.type = PacketType::Audio;
            h.seq = seq;
            h.mediaIndex = mediaIndex;
            h.sessionId = cfg.sessionId;
            h.streamId = cfg.streamId;
            h.flags = static_cast<uint8_t>(kCodecOpus | (isMutedNow ? kFlagMuted : 0u));
            uint8_t packet[kMaxDatagramBytes];
            const size_t n = writePacket(h, opus_packet, static_cast<size_t>(bytes), packet, sizeof packet);
            const bool hadHeld = !heldBack.empty();
            switch (cfg.testImpairment.active() ? impairment.next() : Impairment::Action::Send)
            {
                case Impairment::Action::Send:
                    sendCounted(send, packet, n, true);
                    break;
                case Impairment::Action::Drop: {
                    std::lock_guard<std::mutex> lock(mutex);
                    ++counters.testDropped;
                    break;
                }
                case Impairment::Action::Duplicate: {
                    sendCounted(send, packet, n, true);
                    sendCounted(send, packet, n, true);
                    std::lock_guard<std::mutex> lock(mutex);
                    ++counters.testDuplicated;
                    break;
                }
                case Impairment::Action::HoldBack:
                    if (hadHeld)
                    {
                        sendCounted(send, packet, n, true);  // one held packet at a time
                    }
                    else
                    {
                        heldBack.assign(packet, packet + n);
                        std::lock_guard<std::mutex> lock(mutex);
                        ++counters.testReordered;
                    }
                    break;
            }
            // A held-back packet goes out after the packet that followed it.
            if (hadHeld)
            {
                sendCounted(send, heldBack.data(), heldBack.size(), true);
                heldBack.clear();
            }
        }
        ++seq;  // also for a failed encode: the receiver sees a loss, not a silent shift
        mediaIndex += frameLen;
    }
}

OutgoingStats OutgoingStream::stats() const
{
    std::lock_guard<std::mutex> lock(mutex);
    OutgoingStats s = counters;
    s.enabled = enabled.load();
    s.muted = muted.load();
    s.streaming = streaming.load();
    if (tap != nullptr)
    {
        s.tap = tap->stats();
    }
    return s;
}

