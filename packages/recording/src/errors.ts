/** Error and take-status codes (PROTOCOL_OVERVIEW §6). Numeric values are the wire values. */

export const ErrorCode = {
  Ok: 0,
  ProtocolMalformed: 1,
  VersionUnsupported: 2,
  BadPairingCode: 3,
  SessionFull: 4,
  WrongRole: 5,
  NotReady: 6,
  NoConsent: 7,
  ArmTooLate: 8,
  TakeIdConflict: 9,
  Busy: 10,
  Device: 11,
  DiskSpace: 12,
  DiskWrite: 13,
  Timeout: 14,
  Cancelled: 15,
  UnknownTake: 16,
  UserStop: 17,
  SafetyLimit: 18,
  Shutdown: 19,
  TransferHashMismatch: 20,
  TransferRefused: 21,
  Internal: 22,
  TransferInvalidFile: 23,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const ERROR_NAMES = Object.fromEntries(Object.entries(ErrorCode).map(([k, v]) => [v, k])) as Record<number, string>;
export const errorCodeName = (code: number): string => ERROR_NAMES[code] ?? `Code${code}`;

export const TakeStatus = {
  Complete: 0,
  CompleteShutdown: 1,
  IncompleteDisk: 2,
  IncompleteDevice: 3,
  IncompleteCrash: 4,
  Cancelled: 5,
} as const;
export type TakeStatus = (typeof TakeStatus)[keyof typeof TakeStatus];

const STATUS_NAMES: Record<number, string> = {
  0: "complete",
  1: "complete_shutdown",
  2: "incomplete_disk",
  3: "incomplete_device",
  4: "incomplete_crash",
  5: "cancelled",
};
export const takeStatusName = (s: number): string => STATUS_NAMES[s] ?? `status${s}`;
export const takeStatusIsComplete = (s: number): boolean => s === TakeStatus.Complete || s === TakeStatus.CompleteShutdown;

export type Role = "producer" | "performer";
