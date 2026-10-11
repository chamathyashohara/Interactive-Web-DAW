#pragma once

#include <array>
#include <cstdint>
#include <string_view>

namespace rr {

// Error codes shared by the control protocol, take metadata and logs.
// Values are part of protocol 1.x and match docs/architecture/PROTOCOL_OVERVIEW.md §6.1.
// Never renumber; only append.
enum class ErrorCode : std::uint16_t {
    Ok = 0,
    ProtocolMalformed = 1,
    VersionUnsupported = 2,
    BadPairingCode = 3,
    SessionFull = 4,
    WrongRole = 5,
    NotReady = 6,
    NoConsent = 7,
    ArmTooLate = 8,
    TakeIdConflict = 9,
    Busy = 10,
    Device = 11,
    DiskSpace = 12,
    DiskWrite = 13,
    Timeout = 14,
    Cancelled = 15,
    UnknownTake = 16,
    UserStop = 17,
    SafetyLimit = 18,
    Shutdown = 19,
    TransferHashMismatch = 20,
    TransferRefused = 21,
    Internal = 22,
};

inline constexpr std::array<ErrorCode, 23> kAllErrorCodes = {
    ErrorCode::Ok, ErrorCode::ProtocolMalformed, ErrorCode::VersionUnsupported,
    ErrorCode::BadPairingCode, ErrorCode::SessionFull, ErrorCode::WrongRole,
    ErrorCode::NotReady, ErrorCode::NoConsent, ErrorCode::ArmTooLate,
    ErrorCode::TakeIdConflict, ErrorCode::Busy, ErrorCode::Device,
    ErrorCode::DiskSpace, ErrorCode::DiskWrite, ErrorCode::Timeout,
    ErrorCode::Cancelled, ErrorCode::UnknownTake, ErrorCode::UserStop,
    ErrorCode::SafetyLimit, ErrorCode::Shutdown, ErrorCode::TransferHashMismatch,
    ErrorCode::TransferRefused, ErrorCode::Internal,
};

// Protocol name, e.g. "E_DISK_WRITE" ("OK" for Ok, "E_UNKNOWN_CODE" otherwise).
std::string_view error_code_name(ErrorCode code) noexcept;

// Status of a finished take (PROTOCOL_OVERVIEW.md §6.2). "has gaps" is a separate flag.
enum class TakeStatus : std::uint8_t {
    Complete = 0,
    CompleteShutdown = 1,
    IncompleteDisk = 2,
    IncompleteDevice = 3,
    IncompleteCrash = 4,
    Cancelled = 5,
};

inline constexpr std::array<TakeStatus, 6> kAllTakeStatuses = {
    TakeStatus::Complete, TakeStatus::CompleteShutdown, TakeStatus::IncompleteDisk,
    TakeStatus::IncompleteDevice, TakeStatus::IncompleteCrash, TakeStatus::Cancelled,
};

// Metadata name, e.g. "incomplete_disk".
std::string_view take_status_name(TakeStatus status) noexcept;

// True only for statuses whose file was finalised normally.
bool take_status_is_complete(TakeStatus status) noexcept;

}  // namespace rr
