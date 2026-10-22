#include "rr/transfer/TakeReceiver.h"

#include <algorithm>
#include <cstdio>
#include <system_error>

#include "rr/audio/FileIo.h"
#include "rr/audio/WavInspect.h"
#include "rr/network/ControlLink.h"
#include "rr/shared/Clock.h"
#include "rr/shared/ErrorCodes.h"
#include "rr/shared/JsonEscape.h"
#include "rr/transfer/TransferFiles.h"
#include "rr/transfer/TransferProtocol.h"
#include "XConn.h"

namespace
{

int64_t msNs(uint32_t ms)
{
    return static_cast<int64_t>(ms) * 1000000;
}

std::string takeTag(uint32_t take)
{
    return "take " + std::to_string(take) + " transfer: ";
}

uint16_t codeOf(ErrorCode c)
{
    return static_cast<uint16_t>(c);
}

// Renames `p` to "<p>.<what>-<n>" without replacing anything (received data is never deleted).
std::string setAside(const std::filesystem::path& p, const char* what)
{
    std::error_code ec;
    if (!std::filesystem::exists(p, ec))
    {
        return {};
    }
    for (int n = 1; n < 1000; ++n)
    {
        std::filesystem::path to = p;
        to += "." + std::string(what) + "-" + std::to_string(n);
        std::string err;
        if (!std::filesystem::exists(to, ec) && renameNoReplace(p, to, err))
        {
            return pathToUtf8(to);
        }
    }
    return {};
}

}  // namespace

const char* transferStateName(TransferState s) noexcept
{
    switch (s)
    {
        case TransferState::Queued: return "queued";
        case TransferState::Transferring: return "transferring";
        case TransferState::Retrying: return "paused/retrying";
        case TransferState::Verifying: return "verifying";
        case TransferState::Verified: return "VERIFIED";
        case TransferState::Failed: return "FAILED";
    }
    return "unknown";
}

bool transferStateFinal(TransferState s) noexcept
{
    return s == TransferState::Verified || s == TransferState::Failed;
}

// ---------------------------------------------------------------------------------------------
struct ReceiverImpl
{
    struct Job
    {
        TransferView v;
        std::string token;
        uint64_t expectedFrames = 0;
        ReceivePaths paths;
        bool haveOffer = false;
        XMsg offer;               // first accepted OFFER (a later one must match it)
        uint32_t next = 0;   // next chunk needed
        PartialFile file;
        int64_t retryDeadline = 0;
        uint32_t sameChunkRejects = 0;
        bool discarding = false;  // after a NACK: drop chunks until `next` arrives again
        uint32_t sinceAck = 0;
    };
    enum class Phase { AwaitHello, AwaitOffer, Receiving, Closing };
    struct Conn
    {
        XConn x;
        std::string peer;
        Phase phase = Phase::AwaitHello;
        int64_t deadline = 0;
        int64_t lastRx = 0;
        uint32_t take = 0;
        uint32_t chunksThisConn = 0;
    };

    TakeReceiver& r;
    TcpSocket listener;
    std::map<uint32_t, Job> jobs;
    std::unique_ptr<Conn> conn;

    explicit ReceiverImpl(TakeReceiver& owner) : r(owner) {}

    void publish(Job& j) { r.setView(j.v); }

    void abortConn(const std::string& text, ErrorCode code)
    {
        if (!conn)
        {
            return;
        }
        XMsg a;
        a.type = XType::Abort;
        a.code = codeOf(code);
        a.text = text;
        conn->x.send(a);
        conn->x.closeAfterFlush(500);
        conn.reset();
    }

    void finishConn()
    {
        if (conn)
        {
            conn->x.closeAfterFlush(500);
            conn.reset();
        }
    }

    void fail(Job& j, const std::string& why)
    {
        j.file.close();
        j.v.state = TransferState::Failed;
        j.v.detail = why;
        j.v.finishedNs = monotonicNs();
        r.history(takeTag(j.v.takeId) + "FAILED: " + why + " (the performer's original is unchanged)");
        r.log.log(Level::Warn, "transfer", "failed", why, {{"take", std::to_string(j.v.takeId)}});
        publish(j);
    }

    void persist(Job& j)
    {
        std::string err;
        if (!j.file.flushToDisk(err))
        {
            r.history(takeTag(j.v.takeId) + "flush failed: " + err);
        }
        Journal jr;
        jr.sessionId = r.params.sessionId;
        jr.takeId = j.v.takeId;
        jr.fileBytes = j.offer.fileBytes;
        jr.sha256Hex = toHex(j.offer.fileSha);
        jr.chunkBytes = j.offer.chunkBytes;
        jr.chunksDone = j.next;
        if (!writeJournal(j.paths.journal, jr, err))
        {
            r.history(takeTag(j.v.takeId) + err);
        }
    }

    // Connection gone while a job was active: keep what is on disk, wait for the performer.
    // `abortCode` != Ok: tell the performer why before closing (protocol problem on this side).
    void connectionLost(std::string why, ErrorCode abortCode = ErrorCode::Ok) {  // by value: callers pass conn-owned text
        if (!conn)
        {
            return;
        }
        const uint32_t take = conn->take;
        const Phase phase = conn->phase;
        if (abortCode != ErrorCode::Ok)
        {
            XMsg a;
            a.type = XType::Abort;
            a.code = codeOf(abortCode);
            a.text = why;
            conn->x.send(a);
            conn->x.closeAfterFlush(500);
        }
        else
        {
            conn->x.close();
        }
        conn.reset();
        auto it = jobs.find(take);
        if (it == jobs.end() || transferStateFinal(it->second.v.state) || phase == Phase::AwaitHello)
        {
            return;
        }
        Job& j = it->second;
        if (j.v.state == TransferState::Transferring && j.file.is_open())
        {
            persist(j);
        }
        j.file.close();
        j.v.state = TransferState::Retrying;
        j.v.detail = "connection lost (" + why + "); waiting for the performer to resume";
        j.retryDeadline = monotonicNs() + msNs(r.params.resumeWaitMs);
        r.history(takeTag(take) + "PAUSED: " + why + "; " + std::to_string(j.next) + " of " +
                  std::to_string(j.v.chunksTotal) + " chunks kept on disk");
        r.log.log(Level::Warn, "transfer", "connection_lost", why,
                   {{"take", std::to_string(take)}, {"chunks_kept", std::to_string(j.next)}});
        publish(j);
    }

    void acceptNew()
    {
        for (;;)
        {
            std::string peer;
            std::string err;
            TcpSocket s = listener.acceptPending(peer, err);
            if (!s.valid())
            {
                return;
            }
            std::string allowed;
            {
                std::lock_guard<std::mutex> lock(r.mutex);
                allowed = r.allowedPeer;
            }
            XConn x(std::move(s));
            if (allowed.empty() || peer != allowed)
            {
                uint64_t n = 0;
                {
                    std::lock_guard<std::mutex> lock(r.mutex);
                    n = ++r.refusedConnections;
                }
                if (n <= 3 || n % 100 == 0) {  // rate-limited: a stranger must not flood the log
                    r.log.log(Level::Warn, "transfer", "connection_refused", "not the joined performer's address",
                               {{"from", peer}, {"refused_so_far", std::to_string(n)}});
                    r.history("transfer connection from " + peer + " refused (not the joined performer; " +
                              std::to_string(n) + " so far)");
                }
                x.close();  // no reply to strangers
                continue;
            }
            if (conn)
            {
                XMsg a;
                a.type = XType::Abort;
                a.code = codeOf(ErrorCode::Busy);
                a.text = "another transfer is running";
                x.send(a);
                x.closeAfterFlush(200);
                continue;
            }
            conn = std::make_unique<Conn>();
            conn->x.reset(std::move(x.socket()));
            conn->peer = peer;
            conn->phase = Phase::AwaitHello;
            conn->deadline = monotonicNs() + msNs(r.params.helloTimeoutMs);
            conn->lastRx = monotonicNs();
        }
    }

    void takeInbox()
    {
        std::deque<TakeReceiver::Expectation> in;
        std::deque<std::pair<uint32_t, std::string>> cancels;
        {
            std::lock_guard<std::mutex> lock(r.mutex);
            in.swap(r.inbox);
            cancels.swap(r.cancels);
        }
        for (auto& e : in)
        {
            jobs.erase(e.takeId);  // a repeated request starts a fresh job (files on disk decide the resume point)
            Job& j = jobs[e.takeId];
            j.token = e.token;
            j.expectedFrames = e.expectedFrames;
            j.v.takeId = e.takeId;
            j.v.state = TransferState::Queued;
            j.v.startedNs = monotonicNs();
            j.retryDeadline = j.v.startedNs + msNs(r.params.resumeWaitMs);  // QUEUED must not last forever
            std::string err;
            if (!makeReceivePaths(e.dir, r.params.sessionId, e.takeId, j.paths, err))
            {
                fail(j, err);
                continue;
            }
            j.v.file = pathToUtf8(j.paths.partial);
            j.v.detail = "waiting for the performer";
            publish(j);
        }
        // After the new requests, so a cancel issued right after expect() is not lost.
        for (const auto& [take, why] : cancels)
        {
            auto it = jobs.find(take);
            if (it == jobs.end() || transferStateFinal(it->second.v.state))
            {
                continue;
            }
            if (conn && conn->take == take)
            {
                if (it->second.file.is_open())
                {
                    persist(it->second);
                }
                abortConn(why, ErrorCode::Cancelled);
            }
            fail(it->second, why);
        }
    }

    void onHello(XMsg& m)
    {
        if (m.sessionId != r.params.sessionId)
        {
            r.log.log(Level::Warn, "transfer", "hello_refused", "wrong session",
                       {{"got", m.sessionId}, {"take", std::to_string(m.takeId)}});
            r.history("transfer HELLO for another session (" + m.sessionId + ") refused; nothing written");
            abortConn("wrong session", ErrorCode::TransferRefused);
            return;
        }
        auto it = jobs.find(m.takeId);
        if (it == jobs.end() || transferStateFinal(it->second.v.state))
        {
            r.history("transfer HELLO for take " + std::to_string(m.takeId) + " refused: not requested");
            r.log.log(Level::Warn, "transfer", "hello_refused", "take not requested", {{"take", std::to_string(m.takeId)}});
            abortConn("no transfer was requested for this take", ErrorCode::UnknownTake);
            return;
        }
        if (m.token != it->second.token)
        {
            // The token itself is never logged.
            r.history(takeTag(m.takeId) + "HELLO with a wrong token refused; nothing written");
            r.log.log(Level::Warn, "transfer", "hello_refused", "wrong token", {{"take", std::to_string(m.takeId)}});
            abortConn("wrong transfer token", ErrorCode::TransferRefused);
            return;
        }
        conn->take = m.takeId;
        conn->phase = Phase::AwaitOffer;
        conn->deadline = monotonicNs() + msNs(r.params.helloTimeoutMs);
        ++it->second.v.connections;
        publish(it->second);
    }

    // Checks the offer itself (no file access). Returns an error text, empty if acceptable.
    std::string checkOffer(const Job& j, const XMsg& o)
    {
        if (o.takeId != j.v.takeId) return "offer for a different take";
        if (o.fileBytes < 44 || o.fileBytes > 0xFFFFFFFFull + 8) return "file size out of range";
        if (o.chunkBytes < kMinChunkBytes || o.chunkBytes > kMaxChunkBytes) return "chunk size out of range";
        if (o.chunkCount != chunkCountFor(o.fileBytes, o.chunkBytes)) return "chunk count does not match the size";
        if (!(o.formatTag == 3 || o.formatTag == 0xFFFE) || o.bits != 32) return "not a 32-bit float WAV";
        if (o.channels < 1 || o.channels > 32 || o.sampleRate < 8000 || o.sampleRate > 384000) return "format out of range";
        if (o.frames * o.channels * 4ull > o.fileBytes) return "frame count larger than the file";
        if (j.expectedFrames != 0 && o.frames != j.expectedFrames)
        {
            return "offered " + std::to_string(o.frames) + " frames but the performer reported " +
                   std::to_string(j.expectedFrames) + " in TAKE_FINALISED";
        }
        if (j.haveOffer && (o.fileBytes != j.offer.fileBytes || o.fileSha != j.offer.fileSha ||
                             o.chunkBytes != j.offer.chunkBytes))
                             {
            return "the performer's file differs from the one this transfer started with";
        }
        return {};
    }

    void onOffer(XMsg& m)
    {
        Job& j = jobs[conn->take];
        const std::string bad = checkOffer(j, m);
        if (!bad.empty())
        {
            abortConn(bad, ErrorCode::TransferRefused);
            fail(j, "offer refused: " + bad);
            return;
        }
        j.offer = m;
        j.offer.data.clear();
        j.haveOffer = true;
        j.v.bytesTotal = m.fileBytes;
        j.v.chunksTotal = m.chunkCount;
        j.v.chunkBytes = m.chunkBytes;
        j.v.sha256Hex = toHex(m.fileSha);
        const std::string tag = takeTag(j.v.takeId);
        std::error_code ec;
        std::filesystem::create_directories(j.paths.dir, ec);

        // Never overwrite: an existing final copy is either identical (duplicate request) or a conflict.
        if (std::filesystem::exists(j.paths.finalWav, ec))
        {
            Digest have{};
            uint64_t n = 0;
            std::string err;
            if (sha256File(j.paths.finalWav, have, n, err) && have == m.fileSha && n == m.fileBytes &&
                checkWav(j, j.paths.finalWav).empty())
                {
                XMsg res;
                res.type = XType::Result;
                res.takeId = j.v.takeId;
                res.code = 0;
                res.already = true;
                res.text = "an identical verified copy already exists; nothing was rewritten";
                conn->x.send(res);
                finishConn();
                j.v.state = TransferState::Verified;
                j.v.alreadyVerified = true;
                j.v.bytesDone = m.fileBytes;
                j.v.chunksDone = m.chunkCount;
                j.v.file = pathToUtf8(j.paths.finalWav);
                j.v.detail = res.text;
                j.v.finishedNs = monotonicNs();
                r.history(tag + "duplicate request: identical verified copy already present (SHA-256 " + j.v.sha256Hex + ")");
                r.log.log(Level::Info, "transfer", "duplicate_verified", res.text, {{"take", std::to_string(j.v.takeId)}});
                publish(j);
                return;
            }
            const std::string why = "a different file already exists for this take (" + pathToUtf8(j.paths.finalWav) +
                                    "); it was not overwritten";
            abortConn(why, ErrorCode::TransferRefused);
            fail(j, why);
            return;
        }
        if (availableDiskBytes(j.paths.dir) < m.fileBytes + (1u << 20))
        {
            abortConn("not enough disk space on the producer PC", ErrorCode::DiskSpace);
            fail(j, "not enough disk space for " + std::to_string(m.fileBytes) + " bytes");
            return;
        }
        // Resume point: the journal must describe exactly this session, take and file.
        uint32_t next = 0;
        const auto jr = readJournal(j.paths.journal);
        const bool partialExists = std::filesystem::exists(j.paths.partial, ec);
        if (partialExists && jr && jr->sessionId == r.params.sessionId && jr->takeId == j.v.takeId &&
            jr->fileBytes == m.fileBytes && jr->sha256Hex == j.v.sha256Hex && jr->chunkBytes == m.chunkBytes)
            {
            const uint64_t onDisk = std::filesystem::file_size(j.paths.partial, ec);
            const uint64_t whole = ec ? 0 : onDisk / m.chunkBytes;
            next = static_cast<uint32_t>(std::min<uint64_t>({jr->chunksDone, whole, m.chunkCount}));
        }
        else if (partialExists)
        {
            const std::string aside = setAside(j.paths.partial, "stale");
            r.history(tag + "an unrelated partial file was set aside (" + aside + "); starting from chunk 0");
        }
        std::string err;
        if (!j.file.open(j.paths.partial, static_cast<uint64_t>(next) * m.chunkBytes, err))
        {
            abortConn("producer cannot write the copy", ErrorCode::DiskWrite);
            fail(j, err);
            return;
        }
        j.next = next;
        j.discarding = false;
        j.sameChunkRejects = 0;
        j.sinceAck = 0;
        persist(j);
        XMsg res;
        res.type = XType::Resume;
        res.takeId = j.v.takeId;
        res.nextChunk = next;
        res.code = 0;
        conn->x.send(res);
        conn->phase = Phase::Receiving;
        j.v.state = TransferState::Transferring;
        j.v.resumedFromChunk = next;
        if (next > 0)
        {
            ++j.v.resumes;
        }
        j.v.chunksDone = next;
        j.v.bytesDone = std::min<uint64_t>(static_cast<uint64_t>(next) * m.chunkBytes, m.fileBytes);
        j.v.detail = next > 0 ? "resumed from chunk " + std::to_string(next) : "receiving";
        r.history(tag + (next > 0 ? "RESUMED from chunk " + std::to_string(next) + " of " + std::to_string(m.chunkCount)
                                  : "started: " + std::to_string(m.fileBytes) + " bytes in " + std::to_string(m.chunkCount) +
                                        " chunks, '" + displaySafeName(m.name) + "'"));
        r.log.log(Level::Info, "transfer", next > 0 ? "resumed" : "started", "offer accepted",
                   {{"take", std::to_string(j.v.takeId)}, {"bytes", std::to_string(m.fileBytes)},
                    {"chunks", std::to_string(m.chunkCount)}, {"from_chunk", std::to_string(next)},
                    {"sha256", j.v.sha256Hex}});
        publish(j);
    }

    void onChunk(XMsg& m)
    {
        Job& j = jobs[conn->take];
        if (j.discarding && m.index != j.next)
        {
            return;  // still in flight from before the NACK
        }
        j.discarding = false;
        if (m.index != j.next || j.next >= j.offer.chunkCount)
        {
            connectionLost("chunk " + std::to_string(m.index) + " out of order", ErrorCode::ProtocolMalformed);
            return;
        }
        const uint64_t offset = static_cast<uint64_t>(m.index) * j.offer.chunkBytes;
        const uint64_t want = std::min<uint64_t>(j.offer.chunkBytes, j.offer.fileBytes - offset);
        Digest d{};
        std::string err;
        const bool ok = m.data.size() == want && sha256(m.data.data(), m.data.size(), d, err) && d == m.chunkSha;
        if (!ok)
        {
            ++j.v.chunkRejects;
            ++j.sameChunkRejects;
            r.history(takeTag(j.v.takeId) + "chunk " + std::to_string(m.index) + " failed its SHA-256 check; asked again");
            r.log.log(Level::Warn, "transfer", "chunk_rejected", "chunk hash mismatch",
                       {{"take", std::to_string(j.v.takeId)}, {"chunk", std::to_string(m.index)}});
            if (j.sameChunkRejects >= r.params.maxSameChunkRejects)
            {
                persist(j);
                abortConn("chunk failed its check repeatedly", ErrorCode::TransferHashMismatch);
                fail(j, "chunk " + std::to_string(m.index) + " failed its SHA-256 check " +
                            std::to_string(j.sameChunkRejects) + " times");
                return;
            }
            XMsg n;
            n.type = XType::Nack;
            n.nextChunk = j.next;
            n.code = codeOf(ErrorCode::TransferHashMismatch);
            conn->x.send(n);
            j.discarding = true;
            publish(j);
            return;
        }
        if (!j.file.writeAt(offset, m.data.data(), m.data.size(), err))
        {
            abortConn("producer cannot write the copy", ErrorCode::DiskWrite);
            fail(j, err);
            return;
        }
        ++j.next;
        j.sameChunkRejects = 0;
        ++j.sinceAck;
        ++conn->chunksThisConn;
        j.v.chunksDone = j.next;
        j.v.bytesDone = std::min<uint64_t>(static_cast<uint64_t>(j.next) * j.offer.chunkBytes, j.offer.fileBytes);
        if (j.sinceAck >= r.params.ackEveryChunks || j.next == j.offer.chunkCount)
        {
            persist(j);
            XMsg a;
            a.type = XType::Ack;
            a.nextChunk = j.next;
            conn->x.send(a);
            j.sinceAck = 0;
            publish(j);
        }
        const uint32_t drop = r.testDropAfter.load();
        if (drop != 0 && conn->chunksThisConn == drop)
        {
            r.testDropAfter.store(0);
            r.history(takeTag(j.v.takeId) + "TEST: producer drops the transfer connection");
            connectionLost("test: connection dropped by the producer");
        }
    }

    void onDone(XMsg& m)
    {
        Job& j = jobs[conn->take];
        if (j.discarding)
        {
            return;  // sent before our NACK arrived; a new DONE follows the resent chunks
        }
        if (m.takeId != j.v.takeId || j.next != j.offer.chunkCount)
        {
            connectionLost("DONE before all chunks arrived", ErrorCode::ProtocolMalformed);
            return;
        }
        persist(j);
        j.file.close();
        j.v.state = TransferState::Verifying;
        j.v.detail = "checking SHA-256 of the file on disk and the WAV structure";
        publish(j);
        r.history(takeTag(j.v.takeId) + "all " + std::to_string(j.offer.chunkCount) + " chunks received; VERIFYING");
        XMsg res;
        res.type = XType::Result;
        res.takeId = j.v.takeId;
        verify(j, res);
        conn->x.send(res);
        finishConn();
    }

    // The file-format half of VERIFIED: a complete float32 WAV whose format and frame count match
    // the offer and the performer's TAKE_FINALISED report. Fills the view's facts. Empty = passed.
    std::string checkWav(Job& j, const std::filesystem::path& file)
    {
        const WavInfo w = inspectWav(file);
        std::string bad;
        if (!w.isCompleteFloatWav())
        {
            bad = "not a complete float32 WAV";
            for (const auto& p : w.problems)
            {
                bad += "; " + p;
            }
        }
        else if (w.sampleRate != j.offer.sampleRate || w.channels != j.offer.channels)
        {
            bad = "WAV format differs from the offer";
        }
        else if (w.frames != j.offer.frames)
        {
            bad = "WAV has " + std::to_string(w.frames) + " frames, the offer said " + std::to_string(j.offer.frames);
        }
        else if (j.expectedFrames != 0 && w.frames != j.expectedFrames)
        {
            bad = "WAV has " + std::to_string(w.frames) + " frames, TAKE_FINALISED said " + std::to_string(j.expectedFrames);
        }
        if (bad.empty())
        {
            j.v.sampleRate = w.sampleRate;
            j.v.channels = w.channels;
            j.v.bits = w.bitsPerSample;
            j.v.frames = w.frames;
            j.v.durationS = w.sampleRate ? static_cast<double>(w.frames) / w.sampleRate : 0.0;
            j.v.framesVsReport = j.expectedFrames == 0 ? "no report" : "match";
        }
        return bad;
    }

    void verify(Job& j, XMsg& res)
    {
        const std::string tag = takeTag(j.v.takeId);
        Digest d{};
        uint64_t n = 0;
        std::string err;
        if (!sha256File(j.paths.partial, d, n, err))
        {
            res.code = codeOf(ErrorCode::DiskWrite);
            res.text = "producer could not read back the copy: " + err;
            fail(j, res.text);
            return;
        }
        if (n != j.offer.fileBytes || d != j.offer.fileSha)
        {
            ++j.v.hashFailures;
            const std::string aside = setAside(j.paths.partial, "rejected");
            std::error_code ec;
            std::filesystem::remove(j.paths.journal, ec);  // transfer bookkeeping only
            j.next = 0;
            res.code = codeOf(ErrorCode::TransferHashMismatch);
            res.text = "whole-file SHA-256 mismatch: expected " + toHex(j.offer.fileSha) + ", got " + toHex(d) +
                       " (" + std::to_string(n) + " bytes)";
            r.log.log(Level::Warn, "transfer", "hash_mismatch", res.text, {{"take", std::to_string(j.v.takeId)}, {"set_aside", aside}});
            if (j.v.hashFailures >= r.params.maxHashFailures)
            {
                fail(j, res.text + "; rejected copy kept as " + aside);
            }
            else
            {
                j.v.state = TransferState::Retrying;
                j.v.detail = res.text + "; the performer will send the file again";
                j.retryDeadline = monotonicNs() + msNs(r.params.resumeWaitMs);
                r.history(tag + "SHA-256 MISMATCH, rejected copy kept as " + aside + "; retrying from the start");
                publish(j);
            }
            return;
        }
        const std::string bad = checkWav(j, j.paths.partial);
        if (!bad.empty())
        {
            const std::string aside = setAside(j.paths.partial, "rejected");
            std::error_code ec;
            std::filesystem::remove(j.paths.journal, ec);
            res.code = codeOf(ErrorCode::TransferInvalidFile);
            res.text = "hash matched but the WAV check failed: " + bad;
            fail(j, res.text + "; kept as " + aside);
            return;
        }
        if (!renameNoReplace(j.paths.partial, j.paths.finalWav, err))
        {
            res.code = codeOf(ErrorCode::TransferRefused);
            res.text = "could not move the copy to its final name without replacing a file: " + err;
            fail(j, res.text);
            return;
        }
        std::error_code ec;
        std::filesystem::remove(j.paths.journal, ec);
        j.v.file = pathToUtf8(j.paths.finalWav);
        j.v.bytesDone = n;
        j.v.state = TransferState::Verified;
        j.v.finishedNs = monotonicNs();
        char dur[32];
        std::snprintf(dur, sizeof dur, "%.3f", j.v.durationS);
        j.v.detail = "SHA-256 and WAV checks passed";
        // Record next to the copy (written once; never replaces anything).
        std::string rec = "{\n";
        rec += "  \"what\": \"verified copy of the performer's take (the original stays on the performer's PC)\",\n";
        rec += "  \"session_id\": \"" + r.params.sessionId + "\",\n";
        rec += "  \"take_id\": " + std::to_string(j.v.takeId) + ",\n";
        rec += "  \"file\": \"" + jsonEscape(pathToUtf8(j.paths.finalWav.filename())) + "\",\n";
        rec += "  \"name_sent_by_performer\": \"" + jsonEscape(displaySafeName(j.offer.name)) + "\",\n";
        rec += "  \"bytes\": " + std::to_string(n) + ",\n";
        rec += "  \"sha256\": \"" + j.v.sha256Hex + "\",\n";
        rec += "  \"sha256_checked_on\": \"bytes on the producer's disk after the transfer\",\n";
        rec += "  \"sample_rate\": " + std::to_string(j.v.sampleRate) + ",\n";
        rec += "  \"channels\": " + std::to_string(j.v.channels) + ",\n";
        rec += "  \"bits\": " + std::to_string(j.v.bits) + ",\n";
        rec += "  \"frames\": " + std::to_string(j.v.frames) + ",\n";
        rec += "  \"duration_s\": " + std::string(dur) + ",\n";
        rec += "  \"frames_vs_take_finalised\": \"" + j.v.framesVsReport + "\",\n";
        rec += "  \"chunks\": " + std::to_string(j.offer.chunkCount) + ",\n";
        rec += "  \"chunk_bytes\": " + std::to_string(j.offer.chunkBytes) + ",\n";
        rec += "  \"connections\": " + std::to_string(j.v.connections) + ",\n";
        rec += "  \"resumes\": " + std::to_string(j.v.resumes) + ",\n";
        rec += "  \"chunk_rejects\": " + std::to_string(j.v.chunkRejects) + ",\n";
        rec += "  \"hash_failures\": " + std::to_string(j.v.hashFailures) + ",\n";
        rec += "  \"verified_utc\": \"" + formatUtcIso8601Ms(utcNowMs()) + "\"\n}\n";
        if (!writeTextFileAtomically(j.paths.record, rec, err))
        {
            r.history(takeTag(j.v.takeId) + "note: transfer record not written: " + err);
        }
        res.code = 0;
        res.text = "SHA-256 " + j.v.sha256Hex + " matched; WAV " + std::to_string(j.v.frames) + " frames, " +
                   std::to_string(j.v.sampleRate) + " Hz, " + std::to_string(j.v.channels) + " ch";
        r.history(tag + "VERIFIED: " + j.v.file + " (" + std::to_string(n) + " bytes, SHA-256 " + j.v.sha256Hex + ", " +
                  std::to_string(j.v.frames) + " frames = " + dur + " s, " + std::to_string(j.v.sampleRate) + " Hz, " +
                  std::to_string(j.v.channels) + " ch float32)");
        r.log.log(Level::Info, "transfer", "verified", "copy verified",
                   {{"take", std::to_string(j.v.takeId)}, {"bytes", std::to_string(n)}, {"sha256", j.v.sha256Hex},
                    {"frames", std::to_string(j.v.frames)}, {"connections", std::to_string(j.v.connections)},
                    {"resumes", std::to_string(j.v.resumes)}, {"chunk_rejects", std::to_string(j.v.chunkRejects)},
                    {"hash_failures", std::to_string(j.v.hashFailures)}});
        publish(j);
    }

    void handle(XMsg& m)
    {
        if (!conn)
        {
            return;
        }
        conn->lastRx = monotonicNs();
        switch (conn->phase)
        {
        case Phase::AwaitHello:
            if (m.type != XType::Hello)
            {
                abortConn("expected HELLO", ErrorCode::ProtocolMalformed);
                return;
            }
            onHello(m);
            return;
        case Phase::AwaitOffer:
            if (m.type == XType::Abort)
            {
                connectionLost("performer aborted: " + m.text);
                return;
            }
            if (m.type != XType::Offer)
            {
                abortConn("expected OFFER", ErrorCode::ProtocolMalformed);
                return;
            }
            onOffer(m);
            return;
        case Phase::Receiving:
            if (m.type == XType::Chunk)
            {
                onChunk(m);
            }
            else if (m.type == XType::Done)
            {
                onDone(m);
            }
            else if (m.type == XType::Abort)
            {
                connectionLost("performer aborted: " + m.text);
            }
            else
            {
                connectionLost(std::string("unexpected ") + xtypeName(m.type), ErrorCode::ProtocolMalformed);
            }
            return;
        case Phase::Closing:
            return;
        }
    }

    void timers()
    {
        const int64_t now = monotonicNs();
        if (conn)
        {
            if ((conn->phase == Phase::AwaitHello || conn->phase == Phase::AwaitOffer) && now > conn->deadline)
            {
                if (conn->phase == Phase::AwaitHello)
                {
                    abortConn("no HELLO", ErrorCode::Timeout);
                }
                else
                {
                    connectionLost("no OFFER in time");
                }
            }
            else if (conn && conn->phase == Phase::Receiving && now - conn->lastRx > msNs(r.params.idleTimeoutMs))
            {
                connectionLost("no data for " + std::to_string(r.params.idleTimeoutMs / 1000) + " s");
            }
        }
        for (auto& [take, j] : jobs)
        {
            if (j.v.state == TransferState::Queued && now > j.retryDeadline && !(conn && conn->take == take))
            {
                fail(j, "the performer did not start sending within " + std::to_string(r.params.resumeWaitMs / 1000) +
                            " s (refused, failed or not reachable)");
            }
            if (j.v.state == TransferState::Retrying && now > j.retryDeadline && !(conn && conn->take == take))
            {
                fail(j, "the performer did not resume within " + std::to_string(r.params.resumeWaitMs / 1000) +
                            " s; " + std::to_string(j.next) + " chunks kept, a new request resumes from there");
            }
        }
    }
};

// ---------------------------------------------------------------------------------------------
TakeReceiver::TakeReceiver(ReceiverParams params, Logger& logger)
    : params(std::move(params)), log(logger), impl(std::make_unique<ReceiverImpl>(*this)) {}

TakeReceiver::~TakeReceiver()
{
    stop();
}

bool TakeReceiver::start(std::string& error)
{
    if (running.load())
    {
        return true;
    }
    if (params.bindAddress.empty() || params.bindAddress == "0.0.0.0")
    {
        error = "the transfer listener needs one explicit interface address";
        return false;
    }
    if (!initSockets(error) || !impl->listener.listenOn(params.bindAddress, params.port, error))
    {
        return false;
    }
    running.store(true);
    thread = std::thread([this] { run(); });
    log.log(Level::Info, "transfer", "listening", "take transfer listener started",
             {{"address", params.bindAddress}, {"port", std::to_string(params.port)}});
    history("transfer listener on " + params.bindAddress + ":" + std::to_string(params.port) +
            " (only the joined performer may connect)");
    return true;
}

void TakeReceiver::stop()
{
    if (!running.exchange(false))
    {
        return;
    }
    if (thread.joinable())
    {
        thread.join();
    }
    impl->listener.close();
}

void TakeReceiver::run()
{
    while (running.load())
    {
        impl->takeInbox();
        impl->acceptNew();
        if (impl->conn)
        {
            std::deque<XMsg> in;
            const bool alive = impl->conn->x.pump(20, in);
            for (auto& m : in)
            {
                impl->handle(m);
                if (!impl->conn)
                {
                    break;
                }
            }
            if (!alive && impl->conn)
            {
                impl->connectionLost(impl->conn->x.getError());
            }
        }
        else
        {
            std::vector<TcpSocket*> rd{&impl->listener};
            TcpSocket::wait(rd, {}, 20);
        }
        impl->timers();
    }
    if (impl->conn)
    {
        impl->connectionLost("producer stopped the transfer service");
    }
    for (auto& [take, j] : impl->jobs)
    {
        j.file.close();
    }
}

void TakeReceiver::setAllowedPeer(const std::string& ipv4)
{
    std::lock_guard<std::mutex> lock(mutex);
    allowedPeer = ipv4;
}

bool TakeReceiver::expect(uint32_t takeId, uint64_t expectedFrames, const std::filesystem::path& dir,
                          std::string& token, std::string& error)
                          {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = views.find(takeId);
    if (it != views.end() && !transferStateFinal(it->second.state))
    {
        error = "a transfer of take " + std::to_string(takeId) + " is already " + transferStateName(it->second.state);
        return false;
    }
    for (const auto& e : inbox)
    {
        if (e.takeId == takeId)
        {
            error = "a transfer of take " + std::to_string(takeId) + " is already queued";
            return false;
        }
    }
    token = makeRandomToken(kTokenChars);
    inbox.push_back(Expectation{takeId, expectedFrames, dir, token});
    TransferView v;
    v.takeId = takeId;
    v.state = TransferState::Queued;
    v.detail = "requested";
    views[takeId] = v;
    historyLines.push_back(formatUtcIso8601Ms(utcNowMs()).substr(11, 12) + "  take " +
                       std::to_string(takeId) + " transfer: QUEUED (requested from the performer)");
    return true;
}

void TakeReceiver::cancel(uint32_t takeId, const std::string& why)
{
    std::lock_guard<std::mutex> lock(mutex);
    cancels.emplace_back(takeId, why);
    auto it = views.find(takeId);
    if (it != views.end() && !transferStateFinal(it->second.state) && !running.load())
    {
        it->second.state = TransferState::Failed;
        it->second.detail = why;
    }
}

bool TakeReceiver::anyActive() const
{
    std::lock_guard<std::mutex> lock(mutex);
    for (const auto& [take, v] : views)
    {
        if (!transferStateFinal(v.state))
        {
            return true;
        }
    }
    return false;
}

void TakeReceiver::setView(const TransferView& v)
{
    std::lock_guard<std::mutex> lock(mutex);
    views[v.takeId] = v;
}

void TakeReceiver::history(const std::string& line)
{
    std::lock_guard<std::mutex> lock(mutex);
    historyLines.push_back(formatUtcIso8601Ms(utcNowMs()).substr(11, 12) + "  " + line);
    if (historyLines.size() > 500)
    {
        historyLines.pop_front();
    }
}

std::vector<TransferView> TakeReceiver::transfers() const
{
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<TransferView> out;
    for (const auto& [take, v] : views)
    {
        out.push_back(v);
    }
    return out;
}

std::vector<std::string> TakeReceiver::takeHistory()
{
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<std::string> out(historyLines.begin(), historyLines.end());
    historyLines.clear();
    return out;
}

uint64_t TakeReceiver::getRefusedConnections() const
{
    std::lock_guard<std::mutex> lock(mutex);
    return refusedConnections;
}

