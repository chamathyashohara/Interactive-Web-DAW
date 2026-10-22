#pragma once

// What both apps show about a take transfer (Stage 11). VERIFIED is set only by the producer,
// after the whole-file SHA-256 of the bytes on its disk matched AND the WAV structure checks
// passed; the performer shows VERIFIED only when the producer's RESULT says so.

#include <cstdint>
#include <string>

enum class TransferState : uint8_t
{
    Queued,        // requested; waiting for the performer's connection / preparing the file
    Transferring,  // chunks moving
    Retrying,      // connection lost or hash mismatch; waiting for the performer to resume
    Verifying,     // all bytes received; hashing the file on disk and checking the WAV
    Verified,      // integrity AND format checks passed; the copy is in its final place
    Failed,        // gave up; the original stays on the performer's PC
};

const char* transferStateName(TransferState s) noexcept;  // "queued" ... "failed"
bool transferStateFinal(TransferState s) noexcept;         // Verified or Failed

struct TransferView
{
    uint32_t takeId = 0;
    TransferState state = TransferState::Queued;
    uint64_t bytesTotal = 0;
    uint64_t bytesDone = 0;
    uint32_t chunksTotal = 0;
    uint32_t chunksDone = 0;
    uint32_t chunkBytes = 0;
    uint32_t connections = 0;        // connections used (1 = no interruption)
    uint32_t resumedFromChunk = 0; // last resume point; > 0 means data was reused
    uint32_t resumes = 0;            // connections that continued from a saved point
    uint32_t chunkRejects = 0;      // chunks whose SHA-256 did not match (NACKed)
    uint32_t hashFailures = 0;      // whole-file hash mismatches
    bool alreadyVerified = false;        // duplicate request: an identical verified copy existed
    std::string sha256Hex;               // the performer's whole-file SHA-256
    std::string file;                     // producer: final copy (VERIFIED) or partial; performer: original
    std::string detail;                   // last error or explanation
    /** Producer: facts from its own check of the received WAV (valid when VERIFIED). */
    uint32_t sampleRate = 0;
    uint32_t channels = 0;
    uint32_t bits = 0;
    uint64_t frames = 0;
    double durationS = 0.0;
    std::string framesVsReport;         // "match" / "MISMATCH" / "no report" (performer's TAKE_FINALISED)
    /** Performer: hash of its original before and after sending (must be equal). */
    std::string sourceShaAfterHex;
    bool sourceUnchanged = false;
    int64_t startedNs = 0;
    int64_t finishedNs = 0;
};

