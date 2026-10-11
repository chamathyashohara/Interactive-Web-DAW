#pragma once

// Performer side of the take transfer (Stage 11, ADR-020). Own thread; one take at a time.
//  - sends only a finalised take: the file must parse as a complete float32 WAV;
//  - opens the original READ-ONLY and refuses other writers while it is open; hashes it before
//    and after sending and reports whether it is unchanged (it must be);
//  - connects out to the producer (no inbound rule on the performer PC), resumes from the chunk
//    the producer asks for, resends a chunk the producer rejected, restarts once after a
//    whole-file hash mismatch, and keeps retrying a lost connection for `give_up_after_ms`.
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

#include "rr/shared/log.hpp"
#include "rr/transfer/transfer_types.hpp"

namespace rr::xfer {

struct SendJob {
    std::string host;          // producer address (from the control link)
    std::uint16_t port = 52002;
    std::string session_id;
    std::string token;         // one-time, from TRANSFER_REQUEST; never logged
    std::uint32_t take_id = 0;
    std::filesystem::path file;  // the finalised original (never modified)
    std::uint8_t take_status = 0;
};

struct SenderParams {
    std::uint32_t chunk_bytes = 32768;
    std::uint32_t connect_timeout_ms = 5000;
    std::uint32_t reply_timeout_ms = 10000;    // RESUME after OFFER; ACK while streaming
    std::uint32_t retry_interval_ms = 1000;
    std::uint32_t give_up_after_ms = 60000;    // continuous failure to reach the producer
    std::uint32_t max_hash_restarts = 1;       // whole-file mismatch -> send again from chunk 0
    std::size_t max_queued_bytes = 256 * 1024; // bounded send queue
};

class TakeSender {
public:
    TakeSender(SenderParams params, log::Logger& logger);
    ~TakeSender();
    TakeSender(const TakeSender&) = delete;
    TakeSender& operator=(const TakeSender&) = delete;

    // Starts sending in the background. False (with error) while another take is being sent.
    bool start(const SendJob& job, std::string& error);
    bool busy() const { return busy_.load(); }
    void stop();  // abandons a running transfer (the producer keeps what it verified so far)

    std::vector<TransferView> transfers() const;  // every take sent in this session, by take id
    std::vector<std::string> take_history();      // new lines since the last call

    // ---- test hooks (each applies once unless stated) ----
    void test_drop_after_chunks(std::uint32_t n) { test_drop_after_.store(n); }
    // Flip one byte of chunk `index` AFTER its SHA-256 was computed (the producer must reject it).
    void test_corrupt_chunk(std::uint32_t index) { test_corrupt_chunk_.store(index + 1); }
    // Flip one byte of chunk `index` BEFORE hashing it (chunk check passes; the whole-file hash
    // must catch it). `every_attempt` keeps doing it, so the transfer must end FAILED.
    void test_corrupt_consistent(std::uint32_t index, bool every_attempt) {
        test_consistent_index_.store(index + 1);
        test_consistent_always_.store(every_attempt);
    }
    // Send a file that is not a valid WAV (the producer's format check must refuse it).
    void test_skip_wav_check(bool skip) { test_skip_wav_check_.store(skip); }
    // Offer this session id / token instead of the real ones (wrong-session test).
    void test_override_hello(const std::string& session_id, const std::string& token) {
        std::lock_guard<std::mutex> lock(mutex_);
        test_session_ = session_id;
        test_token_ = token;
    }

private:
    void run(SendJob job);
    void history(const std::string& line);
    void set_view(const TransferView& v);

    SenderParams params_;
    log::Logger& log_;
    std::thread thread_;
    std::atomic<bool> busy_{false};
    std::atomic<bool> stop_{false};
    std::atomic<std::uint32_t> test_drop_after_{0};
    std::atomic<std::uint32_t> test_corrupt_chunk_{0};
    std::atomic<std::uint32_t> test_consistent_index_{0};
    std::atomic<bool> test_consistent_always_{false};
    std::atomic<bool> test_skip_wav_check_{false};

    mutable std::mutex mutex_;
    std::map<std::uint32_t, TransferView> views_;
    std::deque<std::string> history_;
    std::string test_session_;
    std::string test_token_;
};

}  // namespace rr::xfer
