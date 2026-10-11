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

#include "rr/shared/log.hpp"
#include "rr/transfer/transfer_types.hpp"

namespace rr::xfer {

struct ReceiverImpl;

struct ReceiverParams {
    std::string bind_address;            // explicit IPv4 of the session interface (never 0.0.0.0)
    std::uint16_t port = 52002;
    std::string session_id;              // 8 hex, this session
    std::uint32_t hello_timeout_ms = 5000;
    std::uint32_t idle_timeout_ms = 10000;   // no message while receiving -> treated as lost
    std::uint32_t resume_wait_ms = 60000;    // Retrying -> Failed if the performer does not return
    std::uint32_t max_hash_failures = 2;     // whole-file mismatches before Failed
    std::uint32_t max_same_chunk_rejects = 4;
    std::uint32_t ack_every_chunks = 16;     // flush + journal + ACK
};

class TakeReceiver {
public:
    TakeReceiver(ReceiverParams params, log::Logger& logger);
    ~TakeReceiver();
    TakeReceiver(const TakeReceiver&) = delete;
    TakeReceiver& operator=(const TakeReceiver&) = delete;

    bool start(std::string& error);  // binds and listens; errors are immediate
    void stop();
    bool running() const { return running_.load(); }
    std::uint16_t port() const { return params_.port; }

    // Only this address may connect (the joined performer). Empty = nobody.
    void set_allowed_peer(const std::string& ipv4);

    // Requests take `take_id`: files go to `dir`, named by this PC. `expected_frames` is the frame
    // count from the performer's TAKE_FINALISED (0 = unknown). Returns the one-time token (never
    // log it). Refused while a transfer of that take is already queued or running.
    bool expect(std::uint32_t take_id, std::uint64_t expected_frames, const std::filesystem::path& dir,
                std::string& token, std::string& error);

    // Ends a queued or running transfer as FAILED with `why` (performer refused it, or the
    // producer gave up). What was received stays on disk; a new request resumes from it.
    void cancel(std::uint32_t take_id, const std::string& why);
    bool any_active() const;  // a transfer is queued, running, paused or verifying

    std::vector<TransferView> transfers() const;  // every requested take, by take id
    std::vector<std::string> take_history();      // new human-readable lines since the last call
    std::uint64_t refused_connections() const;

    // ---- test hooks ----
    void test_drop_after_chunks(std::uint32_t n) { test_drop_after_.store(n); }  // once

private:
    friend struct ReceiverImpl;
    void run();
    void history(const std::string& line);
    void set_view(const TransferView& v);

    ReceiverParams params_;
    log::Logger& log_;
    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<std::uint32_t> test_drop_after_{0};

    mutable std::mutex mutex_;  // guards the members below
    std::string allowed_peer_;
    std::map<std::uint32_t, TransferView> views_;
    struct Expectation {
        std::uint32_t take_id;
        std::uint64_t expected_frames;
        std::filesystem::path dir;
        std::string token;
    };
    std::deque<Expectation> inbox_;
    std::deque<std::pair<std::uint32_t, std::string>> cancels_;
    std::deque<std::string> history_;
    std::uint64_t refused_connections_ = 0;

    std::unique_ptr<ReceiverImpl> impl_;  // thread-only state (listener, connection, jobs)
};

}  // namespace rr::xfer
