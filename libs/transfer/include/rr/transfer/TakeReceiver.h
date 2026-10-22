#pragma once

// Producer side of the take transfer (Stage 11, ADR-020). Own thread, own TCP listener on the
// session's interface (control port + 2), one connection at a time, only from the joined
// performer's address.
//
// A transfer exists only after the producer asked for it (expect()), which yields a one-time
// token sent to the performer over the control link. HELLO must carry this session's id, a
// requested take id and that token; anything else is refused and nothing is written.
//
// VERIFIED is set in exactly one place: after the whole-file SHA-256 of the bytes ON DISK matched
// the performer's hash, the WAV parsed as a complete float32 file whose format and frame count
// match the offer (and the performer's TAKE_FINALISED report, when known), and the file was moved
// to its final name without replacing anything.

#include <atomic>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rr/shared/Log.h"
#include "rr/transfer/TransferTypes.h"

struct ReceiverImpl;

struct ReceiverParams
{
    std::string bindAddress;            // explicit IPv4 of the session interface (never 0.0.0.0)
    uint16_t port = 52002;
    std::string sessionId;              // 8 hex, this session
    uint32_t helloTimeoutMs = 5000;
    uint32_t idleTimeoutMs = 10000;   // no message while receiving -> treated as lost
    uint32_t resumeWaitMs = 60000;    // Retrying -> Failed if the performer does not return
    uint32_t maxHashFailures = 2;     // whole-file mismatches before Failed
    uint32_t maxSameChunkRejects = 4;
    uint32_t ackEveryChunks = 16;     // flush + journal + ACK
};

class TakeReceiver
{
public:
    TakeReceiver(ReceiverParams params, Logger& logger);
    ~TakeReceiver();
    TakeReceiver(const TakeReceiver&) = delete;
    TakeReceiver& operator=(const TakeReceiver&) = delete;

    bool start(std::string& error);  // binds and listens; errors are immediate
    void stop();
    bool isRunning() const { return running.load(); }
    uint16_t port() const { return params.port; }

    /** Only this address may connect (the joined performer). Empty = nobody. */
    void setAllowedPeer(const std::string& ipv4);

    /**
     * Requests take `takeId`: files go to `dir`, named by this PC. `expected_frames` is the frame
     * count from the performer's TAKE_FINALISED (0 = unknown). Returns the one-time token (never
     * log it). Refused while a transfer of that take is already queued or running.
     */
    bool expect(uint32_t takeId, uint64_t expectedFrames, const std::filesystem::path& dir,
                std::string& token, std::string& error);

    /**
     * Ends a queued or running transfer as FAILED with `why` (performer refused it, or the
     * producer gave up). What was received stays on disk; a new request resumes from it.
     */
    void cancel(uint32_t takeId, const std::string& why);
    bool anyActive() const;  // a transfer is queued, running, paused or verifying

    std::vector<TransferView> transfers() const;  // every requested take, by take id
    std::vector<std::string> takeHistory();      // new human-readable lines since the last call
    uint64_t getRefusedConnections() const;

    /** ---- test hooks ---- */
    void testDropAfterChunks(uint32_t n) { testDropAfter.store(n); }  // once

private:
    friend struct ReceiverImpl;
    void run();
    void history(const std::string& line);
    void setView(const TransferView& v);

    ReceiverParams params;
    Logger& log;
    std::thread thread;
    std::atomic<bool> running{false};
    std::atomic<uint32_t> testDropAfter{0};

    mutable std::mutex mutex;  // guards the members below
    std::string allowedPeer;
    std::map<uint32_t, TransferView> views;
    struct Expectation
    {
        uint32_t takeId;
        uint64_t expectedFrames;
        std::filesystem::path dir;
        std::string token;
    };
    std::deque<Expectation> inbox;
    std::deque<std::pair<uint32_t, std::string>> cancels;
    std::deque<std::string> historyLines;
    uint64_t refusedConnections = 0;

    std::unique_ptr<ReceiverImpl> impl;  // thread-only state (listener, connection, jobs)
};

