#pragma once

// Performer side of the take transfer (Stage 11, ADR-020). Own thread; one take at a time.
//  - sends only a finalised take: the file must parse as a complete float32 WAV;
//  - opens the original READ-ONLY and refuses other writers while it is open; hashes it before
//    and after sending and reports whether it is unchanged (it must be);
//  - connects out to the producer (no inbound rule on the performer PC), resumes from the chunk
//    the producer asks for, resends a chunk the producer rejected, restarts once after a
//    whole-file hash mismatch, and keeps retrying a lost connection for `giveUpAfterMs`.
// The one-time token is never logged.

#include <atomic>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rr/shared/Log.h"
#include "rr/transfer/TransferTypes.h"

struct SendJob
{
    std::string host;          // producer address (from the control link)
    uint16_t port = 52002;
    std::string sessionId;
    std::string token;         // one-time, from TRANSFER_REQUEST; never logged
    uint32_t takeId = 0;
    std::filesystem::path file;  // the finalised original (never modified)
    uint8_t takeStatus = 0;
};

struct SenderParams
{
    uint32_t chunkBytes = 32768;
    uint32_t connectTimeoutMs = 5000;
    uint32_t replyTimeoutMs = 10000;    // RESUME after OFFER; ACK while streaming
    uint32_t retryIntervalMs = 1000;
    uint32_t giveUpAfterMs = 60000;    // continuous failure to reach the producer
    uint32_t maxHashRestarts = 1;       // whole-file mismatch -> send again from chunk 0
    size_t maxQueuedBytes = 256 * 1024; // bounded send queue
};

class TakeSender
{
public:
    TakeSender(SenderParams params, Logger& logger);
    ~TakeSender();
    TakeSender(const TakeSender&) = delete;
    TakeSender& operator=(const TakeSender&) = delete;

    /** Starts sending in the background. False (with error) while another take is being sent. */
    bool start(const SendJob& job, std::string& error);
    bool isBusy() const { return busy.load(); }
    void stop();  // abandons a running transfer (the producer keeps what it verified so far)

    std::vector<TransferView> transfers() const;  // every take sent in this session, by take id
    std::vector<std::string> takeHistory();      // new lines since the last call

    /** ---- test hooks (each applies once unless stated) ---- */
    void testDropAfterChunks(uint32_t n) { testDropAfter.store(n); }
    /** Flip one byte of chunk `index` AFTER its SHA-256 was computed (the producer must reject it). */
    void testCorruptChunk(uint32_t index) { corruptChunkIndex.store(index + 1); }
    /**
     * Flip one byte of chunk `index` BEFORE hashing it (chunk check passes; the whole-file hash
     * must catch it). `everyAttempt` keeps doing it, so the transfer must end FAILED.
     */
    void testCorruptConsistent(uint32_t index, bool everyAttempt)
    {
        testConsistentIndex.store(index + 1);
        testConsistentAlways.store(everyAttempt);
    }
    /** Send a file that is not a valid WAV (the producer's format check must refuse it). */
    void testSkipWavCheck(bool skip) { skipWavCheck.store(skip); }
    /** Offer this session id / token instead of the real ones (wrong-session test). */
    void testOverrideHello(const std::string& sessionId, const std::string& token)
    {
        std::lock_guard<std::mutex> lock(mutex);
        testSession = sessionId;
        testToken = token;
    }

private:
    void run(SendJob job);
    void history(const std::string& line);
    void setView(const TransferView& v);

    SenderParams params;
    Logger& log;
    std::thread thread;
    std::atomic<bool> busy{false};
    std::atomic<bool> stopRequested{false};
    std::atomic<uint32_t> testDropAfter{0};
    std::atomic<uint32_t> corruptChunkIndex{0};
    std::atomic<uint32_t> testConsistentIndex{0};
    std::atomic<bool> testConsistentAlways{false};
    std::atomic<bool> skipWavCheck{false};

    mutable std::mutex mutex;
    std::map<uint32_t, TransferView> views;
    std::deque<std::string> historyLines;
    std::string testSession;
    std::string testToken;
};

