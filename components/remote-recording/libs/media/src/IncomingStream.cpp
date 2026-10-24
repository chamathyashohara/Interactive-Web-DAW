#include "rr/media/IncomingStream.h"

#include <cmath>
#include <cstring>

#include "rr/shared/Clock.h"

namespace
{

template <typename T>
void storeMax(std::atomic<T>& a, T v) noexcept
{
    T cur = a.load(std::memory_order_relaxed);
    while (v > cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed))
    {
    }
}

}  // namespace

void IncomingStream::setGainDb(float db) noexcept
{
    if (!(db >= kMinGainDb))
    {
        db = kMinGainDb;
    }
    if (db > kMaxGainDb)
    {
        db = kMaxGainDb;
    }
    gainDb.store(db);
    gainLinear.store(std::pow(10.0f, db / 20.0f));
}

bool IncomingStream::create(const IncomingConfig& config, std::string& error)
{
    error = validate(config.playout);
    if (!error.empty())
    {
        return false;
    }
    if (config.streamId != kStreamProducerMic && config.streamId != kStreamPerformerMic)
    {
        error = "unknown stream id " + std::to_string(config.streamId);
        return false;
    }
    if (!decoder.create(error))
    {
        return false;
    }
    cfg = config;
    {
        std::lock_guard<std::mutex> lock(mutex);
        arrival = ArrivalStats{};
        queueFullDrops = eos = badFrames = testDropped = 0;
        lastPacketNs = lastEosNs = 0;
        remoteMuted = false;
        receiveImpairment = Impairment(config.testReceiveImpairment);
    }
    while (queue.read(&cbPacket, 1) == 1)
    {
    }
    jb = JitterBuffer(config.playout.targetFrames, config.playout.stallLimit);
    pcmLen = pcmPos = 0;
    frameSamples = 480;
    wasEnabled = false;
    targetFrames.store(config.playout.targetFrames);
    setGainDb(config.playout.gainDb);
    return true;
}

bool IncomingStream::onAudio(const MediaHeader& h, const uint8_t* payload, int64_t now)
{
    // The Opus packet must describe one allowed frame (2.5..20 ms at 48 kHz).
    const int samples = OpusLiveDecoder::packetSamples(payload, h.payloadLen);
    std::lock_guard<std::mutex> lock(mutex);
    if (samples <= 0 || !isAllowedFrame(static_cast<uint32_t>(samples)))
    {
        ++badFrames;
        return false;
    }
    if (receiveImpairment.settings().active() && receiveImpairment.next() == Impairment::Action::Drop)
    {
        ++testDropped;
        return true;
    }
    const ArrivalStats::Result r = arrival.onPacket(h.seq, h.mediaIndex, now);
    if (r == ArrivalStats::Result::Duplicate)
    {
        return true;  // counted in the arrival statistics
    }
    if (r == ArrivalStats::Result::Restart)
    {
        rxPacket.kind = JbPacket::StreamReset;
        rxPacket.len = 0;
        if (!queue.tryWriteAll(&rxPacket, 1))
        {
            ++queueFullDrops;
        }
    }
    lastPacketNs = now;
    remoteMuted = (h.flags & kFlagMuted) != 0;
    rxPacket.kind = JbPacket::Audio;
    rxPacket.seq = h.seq;
    rxPacket.mediaIndex = h.mediaIndex;
    rxPacket.arrivalNs = now;
    rxPacket.len = h.payloadLen;
    std::memcpy(rxPacket.data, payload, h.payloadLen);
    if (!queue.tryWriteAll(&rxPacket, 1))
    {
        ++queueFullDrops;
    }
    return true;
}

void IncomingStream::onEndOfStream()
{
    std::lock_guard<std::mutex> lock(mutex);
    ++eos;
    lastEosNs = monotonicNs();
    arrival.onEndOfStream();
    rxPacket.kind = JbPacket::StreamReset;
    rxPacket.len = 0;
    if (!queue.tryWriteAll(&rxPacket, 1))
    {
        ++queueFullDrops;
    }
}

ReceiverReport IncomingStream::makeReport(bool closing, uint32_t invalidPackets) const
{
    ReceiverReport r;
    {
        std::lock_guard<std::mutex> lock(mutex);
        const ArrivalSnapshot a = arrival.snapshot();
        r.received = a.received;
        r.lostEstimate = a.lostEstimate;
        r.duplicates = static_cast<uint32_t>(a.duplicates);
        r.reordered = static_cast<uint32_t>(a.reordered);
        r.jitterUs = static_cast<uint32_t>(a.jitterMs * 1000.0);
    }
    r.invalidPackets = invalidPackets;
    r.late = static_cast<uint32_t>(cbLate.load());
    r.jbFill = cbHeld.load();
    r.jbTarget = cbTarget.load();
    r.underruns = static_cast<uint32_t>(cbUnderruns.load());
    r.concealed = static_cast<uint32_t>(cbConcealed.load());
    r.decodeErrors = static_cast<uint32_t>(cbDecodeErrors.load());
    r.flags = (outputEnabled.load() ? ReceiverReport::kFlagPlaying : 0u) | (closing ? ReceiverReport::kFlagClosing : 0u);
    return r;
}

bool IncomingStream::nextFrame() noexcept
{
    const JitterBuffer::Pull r = jb.pull(cbPacket);
    int n = 0;
    switch (r)
    {
        case JitterBuffer::Pull::Filling:
            return false;
        case JitterBuffer::Pull::Packet:
            n = decoder.decode(cbPacket.data, cbPacket.len, pcm, OpusLiveDecoder::kMaxFrameSamples);
            if (n <= 0)
            {
                cbDecodeErrors.fetch_add(1, std::memory_order_relaxed);
                n = decoder.conceal(pcm, frameSamples);
                cbConcealed.fetch_add(1, std::memory_order_relaxed);
            }
            else
            {
                frameSamples = static_cast<uint32_t>(n);
            }
            break;
        case JitterBuffer::Pull::Lost:
        case JitterBuffer::Pull::Underrun:
            // Opus PLC: an estimate for the LIVE monitor only. It restores nothing in any recording.
            n = decoder.conceal(pcm, frameSamples);
            cbConcealed.fetch_add(1, std::memory_order_relaxed);
            break;
    }
    if (n <= 0)
    {
        std::memset(pcm, 0, sizeof(float) * frameSamples);
        n = static_cast<int>(frameSamples);
    }
    pcmLen = static_cast<uint32_t>(n);
    pcmPos = 0;
    return true;
}

void IncomingStream::renderAdd(float* out, uint32_t frames, uint32_t channels, uint32_t sampleRate) noexcept
{
    const int64_t t0 = monotonicNs();
    cbCallbacks.fetch_add(1, std::memory_order_relaxed);
    cbLastRenderNs.store(t0, std::memory_order_relaxed);

    const bool enabled = outputEnabled.load(std::memory_order_acquire);
    if (sampleRate != kLiveSampleRate || !enabled)
    {
        if (sampleRate != kLiveSampleRate)
        {
            cbWrongRate.fetch_add(1, std::memory_order_relaxed);
        }
        // Not playing: keep the queue empty and start fresh when playing again.
        while (queue.read(&cbPacket, 1) == 1)
        {
        }
        if (wasEnabled)
        {
            jb.reset();
            pcmLen = pcmPos = 0;
            decoder.reset();
            wasEnabled = false;
        }
        cbJbPlaying.store(false, std::memory_order_relaxed);
        cbHeld.store(0, std::memory_order_relaxed);
        return;
    }
    wasEnabled = true;

    jb.setTarget(targetFrames.load(std::memory_order_relaxed));
    jb.setDriftPulls(frameSamples > 0 ? kLiveSampleRate / frameSamples : 100);  // about 1 s
    while (queue.read(&cbPacket, 1) == 1)
    {
        if (cbPacket.kind == JbPacket::StreamReset)
        {
            jb.reset();
            pcmLen = pcmPos = 0;
            decoder.reset();
        }
        else
        {
            jb.insert(cbPacket);
        }
    }
    storeMax(cbMaxHeld, jb.getHeld());

    const float gain = gainLinear.load(std::memory_order_relaxed);
    uint32_t done = 0;
    while (done < frames)
    {
        if (pcmPos >= pcmLen && !nextFrame())
        {
            break;  // filling: no live contribution for the rest of this block
        }
        const uint32_t n = (frames - done) < (pcmLen - pcmPos) ? (frames - done) : (pcmLen - pcmPos);
        for (uint32_t i = 0; i < n; ++i)
        {
            const float v = pcm[pcmPos + i] * gain;
            const float a = std::fabs(v);
            if (a > windowPeak)
            {
                windowPeak = a;
            }
            float* frame = out + static_cast<size_t>(done + i) * channels;
            for (uint32_t c = 0; c < channels; ++c)
            {
                frame[c] += v;
            }
        }
        pcmPos += n;
        done += n;
    }
    cbFramesOut.fetch_add(done, std::memory_order_relaxed);
    windowFrames += frames;
    if (windowFrames >= kLiveSampleRate)
    {
        cbPeak.store(windowPeak, std::memory_order_relaxed);
        windowPeak = 0.0f;
        windowFrames = 0;
    }

    const JitterStats& s = jb.getStats();
    cbJbPlaying.store(jb.isPlaying(), std::memory_order_relaxed);
    cbHeld.store(jb.getHeld(), std::memory_order_relaxed);
    cbTarget.store(jb.getTarget(), std::memory_order_relaxed);
    cbAccepted.store(s.accepted, std::memory_order_relaxed);
    cbLate.store(s.late, std::memory_order_relaxed);
    cbDups.store(s.duplicates, std::memory_order_relaxed);
    cbTooEarly.store(s.tooEarlyResets, std::memory_order_relaxed);
    cbPlayed.store(s.played, std::memory_order_relaxed);
    cbLost.store(s.lost, std::memory_order_relaxed);
    cbUnderruns.store(s.underruns, std::memory_order_relaxed);
    cbRebuffers.store(s.rebuffers, std::memory_order_relaxed);
    cbDrift.store(s.driftSkips, std::memory_order_relaxed);
    cbCatchup.store(s.catchupFrames, std::memory_order_relaxed);
    cbResyncs.store(s.resyncs, std::memory_order_relaxed);
    cbResets.store(s.resets, std::memory_order_relaxed);
    cbFrameSamples.store(frameSamples, std::memory_order_relaxed);
    storeMax(cbMaxRenderNs, monotonicNs() - t0);
}

IncomingStats IncomingStream::stats() const
{
    IncomingStats s;
    s.streamId = cfg.streamId;
    const int64_t now = monotonicNs();
    {
        std::lock_guard<std::mutex> lock(mutex);
        s.arrival = arrival.snapshot();
        s.queueFullDrops = queueFullDrops;
        s.endOfStream = eos;
        s.badFrames = badFrames;
        s.testDropped = testDropped;
        s.lastPacketAgeMs = lastPacketNs == 0 ? -1.0 : static_cast<double>(now - lastPacketNs) / 1e6;
        s.remoteMuted = remoteMuted;
        s.remoteStreaming = lastPacketNs != 0 && lastPacketNs > lastEosNs && now - lastPacketNs < 1000000000;
    }
    s.outputEnabled = outputEnabled.load();
    s.jbPlaying = cbJbPlaying.load();
    s.jbHeld = cbHeld.load();
    s.jbMaxHeld = cbMaxHeld.load();
    s.jbTarget = cbTarget.load();
    s.jb.accepted = cbAccepted.load();
    s.jb.late = cbLate.load();
    s.jb.duplicates = cbDups.load();
    s.jb.tooEarlyResets = cbTooEarly.load();
    s.jb.played = cbPlayed.load();
    s.jb.lost = cbLost.load();
    s.jb.underruns = cbUnderruns.load();
    s.jb.rebuffers = cbRebuffers.load();
    s.jb.driftSkips = cbDrift.load();
    s.jb.catchupFrames = cbCatchup.load();
    s.jb.resyncs = cbResyncs.load();
    s.jb.resets = cbResets.load();
    s.concealed = cbConcealed.load();
    s.decodeErrors = cbDecodeErrors.load();
    s.renderCallbacks = cbCallbacks.load();
    s.wrongRateCallbacks = cbWrongRate.load();
    s.framesOutput = cbFramesOut.load();
    s.maxRenderNs = cbMaxRenderNs.load();
    const int64_t last = cbLastRenderNs.load();
    s.lastRenderAgeMs = last == 0 ? -1.0 : static_cast<double>(now - last) / 1e6;
    s.lastFrameSamples = cbFrameSamples.load();
    s.gainDb = gainDb.load();
    const float peak = cbPeak.load();
    s.outputPeakDbfs = peak > 1e-10f ? 20.0f * std::log10(peak) : -200.0f;  // below -200 dBFS = silent
    return s;
}

