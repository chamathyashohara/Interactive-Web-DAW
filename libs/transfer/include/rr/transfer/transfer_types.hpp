#pragma once

// What both apps show about a take transfer (Stage 11). VERIFIED is set only by the producer,
// after the whole-file SHA-256 of the bytes on its disk matched AND the WAV structure checks
// passed; the performer shows VERIFIED only when the producer's RESULT says so.

#include <cstdint>
#include <string>

namespace rr::xfer {

enum class TransferState : std::uint8_t {
    Queued,        // requested; waiting for the performer's connection / preparing the file
    Transferring,  // chunks moving
    Retrying,      // connection lost or hash mismatch; waiting for the performer to resume
    Verifying,     // all bytes received; hashing the file on disk and checking the WAV
    Verified,      // integrity AND format checks passed; the copy is in its final place
    Failed,        // gave up; the original stays on the performer's PC
};

const char* transfer_state_name(TransferState s) noexcept;  // "queued" ... "failed"
bool transfer_state_final(TransferState s) noexcept;         // Verified or Failed

struct TransferView {
    std::uint32_t take_id = 0;
    TransferState state = TransferState::Queued;
    std::uint64_t bytes_total = 0;
    std::uint64_t bytes_done = 0;
    std::uint32_t chunks_total = 0;
    std::uint32_t chunks_done = 0;
    std::uint32_t chunk_bytes = 0;
    std::uint32_t connections = 0;        // connections used (1 = no interruption)
    std::uint32_t resumed_from_chunk = 0; // last resume point; > 0 means data was reused
    std::uint32_t resumes = 0;            // connections that continued from a saved point
    std::uint32_t chunk_rejects = 0;      // chunks whose SHA-256 did not match (NACKed)
    std::uint32_t hash_failures = 0;      // whole-file hash mismatches
    bool already_verified = false;        // duplicate request: an identical verified copy existed
    std::string sha256_hex;               // the performer's whole-file SHA-256
    std::string file;                     // producer: final copy (VERIFIED) or partial; performer: original
    std::string detail;                   // last error or explanation
    // Producer: facts from its own check of the received WAV (valid when VERIFIED).
    std::uint32_t sample_rate = 0;
    std::uint32_t channels = 0;
    std::uint32_t bits = 0;
    std::uint64_t frames = 0;
    double duration_s = 0.0;
    std::string frames_vs_report;         // "match" / "MISMATCH" / "no report" (performer's TAKE_FINALISED)
    // Performer: hash of its original before and after sending (must be equal).
    std::string source_sha_after_hex;
    bool source_unchanged = false;
    std::int64_t started_ns = 0;
    std::int64_t finished_ns = 0;
};

}  // namespace rr::xfer
