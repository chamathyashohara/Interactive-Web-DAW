#include "rr/transfer/TakeSender.h"

#include <algorithm>
#include <chrono>

#include "rr/audio/FileIo.h"
#include "rr/audio/WavInspect.h"
#include "rr/network/Socket.h"
#include "rr/shared/Clock.h"
#include "rr/shared/ErrorCodes.h"
#include "rr/transfer/Sha256.h"
#include "rr/transfer/TransferFiles.h"
#include "rr/transfer/TransferProtocol.h"
#include "XConn.h"

namespace
{

int64_t msNs(uint32_t ms)
{
    return static_cast<int64_t>(ms) * 1000000;
}

bool hashOpenFile(ReadOnlyFile& f, Digest& out, std::string& error)
{
    Sha256 h;
    if (!h.init(error))
    {
        return false;
    }
    std::vector<uint8_t> buf(1 << 20);
    uint64_t at = 0;
    for (;;)
    {
        size_t got = 0;
        if (!f.readAt(at, buf.data(), buf.size(), got, error))
        {
            return false;
        }
        if (got == 0)
        {
            break;
        }
        if (!h.update(buf.data(), got, error))
        {
            return false;
        }
        at += got;
    }
    return h.finish(out, error);
}

enum class Outcome { Verified, HashMismatch, Lost, Failed, Stopped };

}  // namespace

TakeSender::TakeSender(SenderParams params, Logger& logger) : params(params), log(logger)
{
    this->params.chunkBytes = std::min(kMaxChunkBytes, std::max(kMinChunkBytes, this->params.chunkBytes));
}

TakeSender::~TakeSender()
{
    stop();
}

bool TakeSender::start(const SendJob& job, std::string& error)
{
    if (busy.load())
    {
        error = "another take is being sent";
        return false;
    }
    if (thread.joinable())
    {
        thread.join();
    }
    {
        // A take sent again on request replaces its row; the producer decides whether the copy
        // it already has is identical ("already verified") or a conflict.
        std::lock_guard<std::mutex> lock(mutex);
        TransferView v;
        v.takeId = job.takeId;
        v.state = TransferState::Queued;
        v.file = pathToUtf8(job.file);
        v.detail = "preparing";
        views[job.takeId] = v;
    }
    stopRequested.store(false);
    busy.store(true);
    thread = std::thread([this, job] { run(job); });
    return true;
}

void TakeSender::stop()
{
    stopRequested.store(true);
    if (thread.joinable())
    {
        thread.join();
    }
}

void TakeSender::run(SendJob job)
{
    const std::string tag = "take " + std::to_string(job.takeId) + " send: ";
    TransferView v;
    v.takeId = job.takeId;
    v.state = TransferState::Queued;
    v.file = pathToUtf8(job.file);
    v.startedNs = monotonicNs();
    v.detail = "checking the file and computing its SHA-256";
    setView(v);

    ReadOnlyFile f;
    std::string err;
    auto finish = [&](TransferState st, const std::string& detail)
    {
        // The original must be exactly as it was: hash it again through the same read-only handle.
        if (f.is_open() && !v.sha256Hex.empty()) {  // only comparable once the "before" hash exists
            Digest after{};
            std::string herr;
            if (hashOpenFile(f, after, herr))
            {
                v.sourceShaAfterHex = toHex(after);
                v.sourceUnchanged = !v.sha256Hex.empty() && v.sourceShaAfterHex == v.sha256Hex;
            }
        }
        f.close();
        v.state = st;
        v.detail = detail;
        v.finishedNs = monotonicNs();
        setView(v);
        history(tag + transferStateName(st) + ": " + detail + (v.sourceShaAfterHex.empty()
                    ? std::string()
                    : std::string("; original ") + (v.sourceUnchanged ? "unchanged" : "CHANGED") +
                          " (SHA-256 after " + v.sourceShaAfterHex + ")"));
        log.log(st == TransferState::Verified ? Level::Info : Level::Warn, "transfer",
                 st == TransferState::Verified ? "send_verified" : "send_failed", detail,
                 {{"take", std::to_string(job.takeId)}, {"sha256", v.sha256Hex},
                  {"original_unchanged", v.sourceUnchanged ? "yes" : "no"},
                  {"connections", std::to_string(v.connections)}});
        busy.store(false);
    };

    if (!f.open(job.file, err))
    {
        finish(TransferState::Failed, "cannot open the take: " + err);
        return;
    }
    const WavInfo w = inspectWav(job.file);
    const bool skip = skipWavCheck.load();
    if (!skip && !w.isCompleteFloatWav())
    {
        finish(TransferState::Failed, "not a finalised float32 WAV; nothing was sent");
        return;
    }
    Digest src{};
    if (!hashOpenFile(f, src, err))
    {
        finish(TransferState::Failed, "cannot hash the take: " + err);
        return;
    }
    const uint32_t cb = params.chunkBytes;
    XMsg offer;
    offer.type = XType::Offer;
    offer.takeId = job.takeId;
    offer.fileBytes = f.getSize();
    offer.chunkBytes = cb;
    offer.chunkCount = chunkCountFor(f.getSize(), cb);
    offer.fileSha = src;
    if (skip && !w.isCompleteFloatWav())
    {
        // TEST: pretend it is a mono float WAV so only the producer's final check can catch it.
        offer.formatTag = 3;
        offer.bits = 32;
        offer.channels = 1;
        offer.sampleRate = 48000;
        offer.frames = f.getSize() > 44 ? (f.getSize() - 44) / 4 : 0;
    }
    else
    {
        offer.formatTag = w.formatTag;
        offer.bits = static_cast<uint16_t>(w.bitsPerSample);
        offer.channels = static_cast<uint16_t>(w.channels);
        offer.sampleRate = w.sampleRate;
        offer.frames = w.frames;
    }
    offer.takeStatus = job.takeStatus;
    offer.name = pathToUtf8(job.file.filename());
    v.sha256Hex = toHex(src);
    v.bytesTotal = f.getSize();
    v.chunkBytes = cb;
    v.chunksTotal = offer.chunkCount;
    v.frames = offer.frames;
    v.sampleRate = offer.sampleRate;
    v.channels = offer.channels;
    v.detail = "connecting to the producer";
    setView(v);
    history(tag + "QUEUED: " + std::to_string(v.bytesTotal) + " bytes, SHA-256 " + v.sha256Hex + " (original opened read-only)");

    std::string helloSession = job.sessionId;
    std::string helloToken = job.token;
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (!testSession.empty())
        {
            helloSession = testSession;
        }
        if (!testToken.empty())
        {
            helloToken = testToken;
        }
    }

    uint32_t restarts = 0;
    int64_t troubleSince = 0;
    std::vector<uint8_t> buf(cb);
    while (!stopRequested.load())
    {
        const int64_t now = monotonicNs();
        if (troubleSince != 0 && now - troubleSince > msNs(params.giveUpAfterMs))
        {
            finish(TransferState::Failed, "could not complete the transfer for " +
                                              std::to_string(params.giveUpAfterMs / 1000) + " s; last problem: " + v.detail);
            return;
        }
        // ---- connect ----
        TcpSocket s;
        bool connected = false;
        if (s.connectStart(job.host, job.port, err))
        {
            const int64_t until = monotonicNs() + msNs(params.connectTimeoutMs);
            while (!stopRequested.load() && monotonicNs() < until)
            {
                const int r = s.connectFinished(err);
                if (r == 1)
                {
                    connected = true;
                    break;
                }
                if (r < 0)
                {
                    break;
                }
                std::vector<TcpSocket*> wr{&s};
                TcpSocket::wait({}, wr, 20);
            }
            if (!connected && err.empty())
            {
                err = "timed out";
            }
        }
        if (!connected)
        {
            if (troubleSince == 0)
            {
                troubleSince = now;
            }
            v.state = TransferState::Retrying;
            v.detail = "cannot reach the producer (" + err + "); retrying";
            setView(v);
            std::this_thread::sleep_for(std::chrono::milliseconds(params.retryIntervalMs));
            continue;
        }
        ++v.connections;
        XConn c(std::move(s));
        XMsg hello;
        hello.type = XType::Hello;
        hello.sessionId = helloSession;
        hello.token = helloToken;
        hello.takeId = job.takeId;
        c.send(hello);
        c.send(offer);

        // ---- one connection ----
        Outcome out = Outcome::Lost;
        std::string why;
        bool already = false;
        bool resumed = false;
        uint32_t nextSend = 0;
        bool doneSent = false;
        uint32_t sentHere = 0;
        int64_t dropAt = 0;  // TEST: cut the connection once the queued chunks are delivered
        uint32_t acked = 0;
        int64_t lastRx = monotonicNs();
        const int64_t resultWait = msNs(params.replyTimeoutMs) +
                                         static_cast<int64_t>(v.bytesTotal / (20ull << 20)) * 1000000000LL;
        while (!stopRequested.load())
        {
            if (resumed)
            {
                while (dropAt == 0 && !doneSent && nextSend < offer.chunkCount &&
                       c.pendingOut() < params.maxQueuedBytes)
                       {
                    const uint64_t off = static_cast<uint64_t>(nextSend) * cb;
                    size_t got = 0;
                    const size_t want = static_cast<size_t>(std::min<uint64_t>(cb, v.bytesTotal - off));
                    if (!f.readAt(off, buf.data(), want, got, err) || got != want)
                    {
                        why = "cannot read the take: " + (err.empty() ? std::string("short read") : err);
                        out = Outcome::Failed;
                        break;
                    }
                    XMsg ch;
                    ch.type = XType::Chunk;
                    ch.index = nextSend;
                    ch.data.assign(buf.begin(), buf.begin() + static_cast<ptrdiff_t>(want));
                    if (testConsistentIndex.load() == nextSend + 1)
                    {
                        ch.data[0] ^= 0x01;  // TEST: wrong data with a matching chunk hash
                        if (!testConsistentAlways.load())
                        {
                            testConsistentIndex.store(0);
                        }
                        history(tag + "TEST: chunk " + std::to_string(nextSend) + " altered before hashing");
                    }
                    sha256(ch.data.data(), ch.data.size(), ch.chunkSha, err);
                    if (corruptChunkIndex.load() == nextSend + 1)
                    {
                        ch.data[ch.data.size() / 2] ^= 0x01;  // TEST: damaged after hashing
                        corruptChunkIndex.store(0);
                        history(tag + "TEST: chunk " + std::to_string(nextSend) + " damaged after hashing");
                    }
                    c.send(ch);
                    ++nextSend;
                    ++sentHere;
                    const uint32_t drop = testDropAfter.load();
                    if (drop != 0 && sentHere == drop)
                    {
                        // Stop queuing; the connection is cut once the producer has acknowledged
                        // these chunks (or after 2 s), like a network that dies mid-file.
                        testDropAfter.store(0);
                        dropAt = monotonicNs() + msNs(2000);
                    }
                }
                if (out == Outcome::Failed)
                {
                    break;
                }
                if (dropAt != 0 && ((c.pendingOut() == 0 && acked + 8 >= nextSend) || monotonicNs() > dropAt))
                {
                    history(tag + "TEST: performer drops the connection after " + std::to_string(sentHere) +
                            " chunks (" + std::to_string(acked) + " acknowledged)");
                    c.close();
                    why = "test: connection dropped by the performer";
                    out = Outcome::Lost;
                    break;
                }
                if (!doneSent && nextSend == offer.chunkCount)
                {
                    XMsg d;
                    d.type = XType::Done;
                    d.takeId = job.takeId;
                    c.send(d);
                    doneSent = true;
                    v.state = TransferState::Verifying;
                    v.detail = "all chunks sent; the producer is verifying";
                    setView(v);
                }
            }
            std::deque<XMsg> in;
            const bool alive = c.pump(20, in);
            bool end = false;
            for (auto& m : in)
            {
                lastRx = monotonicNs();
                if (m.type == XType::Resume && !resumed)
                {
                    if (m.code != 0)
                    {
                        why = "producer refused: " + m.text;
                        out = Outcome::Failed;
                        end = true;
                        break;
                    }
                    if (m.nextChunk > offer.chunkCount)
                    {
                        why = "producer asked for a chunk beyond the end";
                        out = Outcome::Failed;
                        end = true;
                        break;
                    }
                    resumed = true;
                    nextSend = m.nextChunk;
                    v.resumedFromChunk = nextSend;
                    if (nextSend > 0)
                    {
                        ++v.resumes;
                    }
                    v.chunksDone = nextSend;
                    v.state = TransferState::Transferring;
                    v.detail = nextSend > 0 ? "resumed from chunk " + std::to_string(nextSend) : "sending";
                    setView(v);
                    history(tag + (nextSend > 0 ? "RESUMING from chunk " + std::to_string(nextSend) : std::string("TRANSFERRING")));
                    troubleSince = 0;
                }
                else if (m.type == XType::Ack)
                {
                    acked = m.nextChunk;
                    v.chunksDone = std::min(m.nextChunk, offer.chunkCount);
                    v.bytesDone = std::min<uint64_t>(static_cast<uint64_t>(v.chunksDone) * cb, v.bytesTotal);
                    troubleSince = 0;
                    setView(v);
                }
                else if (m.type == XType::Nack)
                {
                    ++v.chunkRejects;
                    history(tag + "producer rejected chunk " + std::to_string(m.nextChunk) + "; sending again from there");
                    nextSend = std::min(m.nextChunk, offer.chunkCount);
                    doneSent = false;
                    v.state = TransferState::Transferring;
                }
                else if (m.type == XType::Result)
                {
                    if (m.code == 0)
                    {
                        out = Outcome::Verified;
                        already = m.already;
                    }
                    else if (m.code == static_cast<uint16_t>(ErrorCode::TransferHashMismatch))
                    {
                        out = Outcome::HashMismatch;
                    }
                    else
                    {
                        out = Outcome::Failed;
                    }
                    why = m.text;
                    end = true;
                    break;
                }
                else if (m.type == XType::Abort)
                {
                    why = "producer: " + m.text;
                    out = m.code == static_cast<uint16_t>(ErrorCode::Busy) ? Outcome::Lost : Outcome::Failed;
                    end = true;
                    break;
                }
            }
            if (end)
            {
                break;
            }
            if (!alive)
            {
                why = c.getError();
                out = Outcome::Lost;
                break;
            }
            const int64_t quiet = monotonicNs() - lastRx;
            if (!doneSent && quiet > msNs(params.replyTimeoutMs))
            {
                why = "no reply from the producer for " + std::to_string(params.replyTimeoutMs / 1000) + " s";
                out = Outcome::Lost;
                break;
            }
            if (doneSent && quiet > resultWait)
            {
                why = "no verification result from the producer";
                out = Outcome::Lost;
                break;
            }
        }
        if (stopRequested.load())
        {
            c.close();
            finish(TransferState::Failed, "stopped on this PC before the producer verified the copy");
            return;
        }
        switch (out)
        {
        case Outcome::Verified:
            c.closeAfterFlush(200);
            v.alreadyVerified = already;
            v.bytesDone = v.bytesTotal;
            v.chunksDone = v.chunksTotal;
            finish(TransferState::Verified, "the producer verified the copy" +
                                                std::string(already ? " (it already had an identical one)" : "") + ": " + why);
            return;
        case Outcome::HashMismatch:
            c.closeAfterFlush(200);
            ++v.hashFailures;
            if (restarts < params.maxHashRestarts)
            {
                ++restarts;
                v.state = TransferState::Retrying;
                v.detail = "producer found a whole-file SHA-256 mismatch; sending again from the start";
                setView(v);
                history(tag + "producer reported SHA-256 MISMATCH (" + why + "); sending again");
                continue;
            }
            finish(TransferState::Failed, "whole-file SHA-256 mismatch again: " + why);
            return;
        case Outcome::Failed:
            c.closeAfterFlush(200);
            finish(TransferState::Failed, why);
            return;
        case Outcome::Lost:
        case Outcome::Stopped:
            c.close();
            if (troubleSince == 0)
            {
                troubleSince = monotonicNs();
            }
            v.state = TransferState::Retrying;
            v.detail = "connection lost (" + why + "); retrying";
            setView(v);
            history(tag + "PAUSED: " + why + "; retrying in " + std::to_string(params.retryIntervalMs) + " ms");
            std::this_thread::sleep_for(std::chrono::milliseconds(params.retryIntervalMs));
            continue;
        }
    }
    finish(TransferState::Failed, "stopped on this PC before the producer verified the copy");
}

void TakeSender::setView(const TransferView& v)
{
    std::lock_guard<std::mutex> lock(mutex);
    views[v.takeId] = v;
}

void TakeSender::history(const std::string& line)
{
    std::lock_guard<std::mutex> lock(mutex);
    historyLines.push_back(formatUtcIso8601Ms(utcNowMs()).substr(11, 12) + "  " + line);
    if (historyLines.size() > 500)
    {
        historyLines.pop_front();
    }
}

std::vector<TransferView> TakeSender::transfers() const
{
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<TransferView> out;
    for (const auto& [take, v] : views)
    {
        out.push_back(v);
    }
    return out;
}

std::vector<std::string> TakeSender::takeHistory()
{
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<std::string> out(historyLines.begin(), historyLines.end());
    historyLines.clear();
    return out;
}

