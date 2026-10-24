#include "rr/shared/ErrorCodes.h"

std::string_view errorCodeName(ErrorCode code) noexcept
{
    switch (code)
    {
    case ErrorCode::Ok: return "OK";
    case ErrorCode::ProtocolMalformed: return "E_PROTOCOL_MALFORMED";
    case ErrorCode::VersionUnsupported: return "E_VERSION_UNSUPPORTED";
    case ErrorCode::BadPairingCode: return "E_BAD_PAIRING_CODE";
    case ErrorCode::SessionFull: return "E_SESSION_FULL";
    case ErrorCode::WrongRole: return "E_WRONG_ROLE";
    case ErrorCode::NotReady: return "E_NOT_READY";
    case ErrorCode::NoConsent: return "E_NO_CONSENT";
    case ErrorCode::ArmTooLate: return "E_ARM_TOO_LATE";
    case ErrorCode::TakeIdConflict: return "E_TAKE_ID_CONFLICT";
    case ErrorCode::Busy: return "E_BUSY";
    case ErrorCode::Device: return "E_DEVICE";
    case ErrorCode::DiskSpace: return "E_DISK_SPACE";
    case ErrorCode::DiskWrite: return "E_DISK_WRITE";
    case ErrorCode::Timeout: return "E_TIMEOUT";
    case ErrorCode::Cancelled: return "E_CANCELLED";
    case ErrorCode::UnknownTake: return "E_UNKNOWN_TAKE";
    case ErrorCode::UserStop: return "E_USER_STOP";
    case ErrorCode::SafetyLimit: return "E_SAFETY_LIMIT";
    case ErrorCode::Shutdown: return "E_SHUTDOWN";
    case ErrorCode::TransferHashMismatch: return "E_TRANSFER_HASH_MISMATCH";
    case ErrorCode::TransferRefused: return "E_TRANSFER_REFUSED";
    case ErrorCode::Internal: return "E_INTERNAL";
    case ErrorCode::TransferInvalidFile: return "E_TRANSFER_INVALID_FILE";
    }
    return "E_UNKNOWN_CODE";
}

std::string_view takeStatusName(TakeStatus status) noexcept
{
    switch (status)
    {
    case TakeStatus::Complete: return "complete";
    case TakeStatus::CompleteShutdown: return "complete_shutdown";
    case TakeStatus::IncompleteDisk: return "incomplete_disk";
    case TakeStatus::IncompleteDevice: return "incomplete_device";
    case TakeStatus::IncompleteCrash: return "incomplete_crash";
    case TakeStatus::Cancelled: return "cancelled";
    }
    return "unknown";
}

bool takeStatusIsComplete(TakeStatus status) noexcept
{
    return status == TakeStatus::Complete || status == TakeStatus::CompleteShutdown;
}

