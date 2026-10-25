/**
 * Link and session states, the producer/performer transition tables, and the readiness checklist
 * (ported from libs/session and libs/control/readiness of the C++ recorder). Numeric state values are wire values.
 */
import type { Role } from "./errors";

export const LinkState = { Disconnected: 0, Listening: 1, Connecting: 2, Handshaking: 3, Connected: 4, LinkLost: 5 } as const;
export type LinkState = (typeof LinkState)[keyof typeof LinkState];

const LINK_LABELS: Record<number, string> = {
  0: "Not connected",
  1: "Waiting for the performer to join",
  2: "Connecting...",
  3: "Connecting (checking versions)...",
  4: "Connected",
  5: "Connection lost",
};
const LINK_NAMES = ["Disconnected", "Listening", "Connecting", "Handshaking", "Connected", "LinkLost"];
export const linkStateLabel = (s: number): string => LINK_LABELS[s] ?? "Unknown";
export const linkStateName = (s: number): string => LINK_NAMES[s] ?? "Unknown";

export const SessionState = {
  NotReady: 0, Ready: 1, Armed: 2, Scheduled: 3, Recording: 4, Stopping: 5, Finalising: 6, Completed: 7, Error: 8, Recovery: 9, Closed: 10,
} as const;
export type SessionState = (typeof SessionState)[keyof typeof SessionState];
const SESSION_NAMES = ["NotReady", "Ready", "Armed", "Scheduled", "Recording", "Stopping", "Finalising", "Completed", "Error", "Recovery", "Closed"];
export const sessionStateName = (s: number): string => SESSION_NAMES[s] ?? "Unknown";

export const SessionEvent = {
  ReadinessOk: "ReadinessOk", ReadinessLost: "ReadinessLost", UserRecord: "UserRecord", ArmAckReceived: "ArmAckReceived",
  StartAckReceived: "StartAckReceived", TakeRefused: "TakeRefused", ArmReceived: "ArmReceived", ScheduleReceived: "ScheduleReceived",
  CancelReceived: "CancelReceived", ArmExpired: "ArmExpired", LocalTakeStarted: "LocalTakeStarted", UserStop: "UserStop",
  StopReceived: "StopReceived", UserStopAndSave: "UserStopAndSave", LocalFault: "LocalFault", LocalFinalised: "LocalFinalised",
  TakeComplete: "TakeComplete", LinkLost: "LinkLost", EngineFault: "EngineFault", UserRetry: "UserRetry", RecoveryOk: "RecoveryOk",
  RecoveryFailed: "RecoveryFailed", Shutdown: "Shutdown",
} as const;
export type SessionEvent = (typeof SessionEvent)[keyof typeof SessionEvent];

type S = SessionState;
type E = SessionEvent;
type Next = S | null; // null = invalid in this state

const S_ = SessionState;

function common(from: S, e: E): Next {
  switch (from) {
    case S_.NotReady:
    case S_.Ready:
      switch (e) {
        case "ReadinessOk": return S_.Ready;
        case "ReadinessLost": return S_.NotReady;
        case "LinkLost": return S_.NotReady;
        case "EngineFault": return S_.Error;
        case "Shutdown": return S_.Closed;
        default: return null;
      }
    case S_.Completed:
      switch (e) {
        case "ReadinessOk": return S_.Ready;
        case "ReadinessLost": return S_.NotReady;
        case "LinkLost": return S_.NotReady;
        case "Shutdown": return S_.Closed;
        default: return null;
      }
    case S_.Error:
      return e === "UserRetry" ? S_.Recovery : e === "Shutdown" ? S_.Closed : null;
    case S_.Recovery:
      return e === "RecoveryOk" ? S_.NotReady : e === "RecoveryFailed" ? S_.Error : e === "Shutdown" ? S_.Closed : null;
    default:
      return null;
  }
}

export function producerTransition(from: S, e: E): Next {
  switch (from) {
    case S_.Ready:
      return e === "UserRecord" ? S_.Armed : common(from, e);
    case S_.Armed:
      switch (e) {
        case "ArmAckReceived": return S_.Armed;
        case "StartAckReceived": return S_.Scheduled;
        case "TakeRefused": return S_.NotReady;
        case "LinkLost": return S_.NotReady;
        case "Shutdown": return S_.Closed;
        default: return null;
      }
    case S_.Scheduled:
      switch (e) {
        case "LocalTakeStarted": return S_.Recording;
        case "TakeRefused": return S_.NotReady;
        case "LinkLost": return S_.NotReady;
        case "Shutdown": return S_.Closed;
        default: return null;
      }
    case S_.Recording:
      switch (e) {
        case "UserStop": return S_.Stopping;
        case "LinkLost": return S_.Recording;
        case "LocalFault": return S_.Finalising;
        case "Shutdown": return S_.Stopping;
        default: return null;
      }
    case S_.Stopping:
      switch (e) {
        case "UserStop": return S_.Stopping;
        case "LocalFinalised": return S_.Finalising;
        case "LocalFault": return S_.Finalising;
        case "LinkLost": return S_.Stopping;
        case "Shutdown": return S_.Stopping;
        default: return null;
      }
    case S_.Finalising:
      switch (e) {
        case "LocalFinalised": return S_.Finalising;
        case "TakeComplete": return S_.Completed;
        case "LinkLost": return S_.Finalising;
        case "Shutdown": return S_.Closed;
        default: return null;
      }
    default:
      return common(from, e);
  }
}

export function performerTransition(from: S, e: E): Next {
  switch (from) {
    case S_.Ready:
      return e === "ArmReceived" ? S_.Armed : common(from, e);
    case S_.Armed:
      switch (e) {
        case "ScheduleReceived": return S_.Scheduled;
        case "CancelReceived": return S_.Ready;
        case "ArmExpired": return S_.Ready;
        case "TakeRefused": return S_.Ready;
        case "LinkLost": return S_.NotReady;
        case "Shutdown": return S_.Closed;
        default: return null;
      }
    case S_.Scheduled:
      switch (e) {
        case "LocalTakeStarted": return S_.Recording;
        case "CancelReceived": return S_.Ready;
        case "TakeRefused": return S_.Ready;
        case "LinkLost": return S_.NotReady;
        case "Shutdown": return S_.Closed;
        default: return null;
      }
    case S_.Recording:
      switch (e) {
        case "StopReceived": return S_.Stopping;
        case "UserStopAndSave": return S_.Stopping;
        case "LinkLost": return S_.Recording;
        case "LocalFault": return S_.Finalising;
        case "Shutdown": return S_.Stopping;
        default: return null;
      }
    case S_.Stopping:
      switch (e) {
        case "StopReceived": return S_.Stopping;
        case "UserStopAndSave": return S_.Stopping;
        case "LocalFinalised": return S_.Completed;
        case "LocalFault": return S_.Finalising;
        case "LinkLost": return S_.Stopping;
        case "Shutdown": return S_.Stopping;
        default: return null;
      }
    case S_.Finalising:
      switch (e) {
        case "LocalFinalised": return S_.Completed;
        case "LinkLost": return S_.Finalising;
        case "Shutdown": return S_.Closed;
        default: return null;
      }
    default:
      return common(from, e);
  }
}

export const sessionTransition = (role: Role, from: S, e: E): Next => (role === "producer" ? producerTransition(from, e) : performerTransition(from, e));

export const isTakeRunning = (s: number): boolean => s === S_.Recording || s === S_.Stopping || s === S_.Finalising;

/** Plain-English status line for a session state. */
export function sessionStatusText(state: number, reasons: string[]): string {
  switch (state) {
    case S_.NotReady: return reasons.length ? `Not ready: ${reasons.join("; ")}` : "Not ready";
    case S_.Ready: return "Ready";
    case S_.Armed:
    case S_.Scheduled: return "Starting take...";
    case S_.Recording: return "Recording";
    case S_.Stopping:
    case S_.Finalising: return "Saving take...";
    case S_.Completed: return "Take finished";
    case S_.Error: return "Error";
    case S_.Recovery: return "Recovering...";
    case S_.Closed: return "Closed";
    default: return "Unknown";
  }
}

// ---- readiness checklist (Stage 9) ----

export const ReadyItem = { InputDevice: 0, EngineHealthy: 1, FolderWritable: 2, DiskSpace: 3, NoActiveRecording: 4, Consent: 5, Connected: 6, ClockOffset: 7, Backing: 8 } as const;
export type ReadyItem = (typeof ReadyItem)[keyof typeof ReadyItem];

const READY_IDS = ["input", "engine", "folder", "disk", "idle", "consent", "link", "clock", "backing"];
const READY_LABELS = [
  "Input device open",
  "Audio engine healthy",
  "Recording folder writable",
  "Enough disk space for the longest take",
  "No other recording active",
  "Recording consent given (armed)",
  "Connected to the other PC",
  "Clock offset to the producer measured",
  "Backing track received",
];
export const readyItemId = (i: number): string => READY_IDS[i] ?? "unknown";
export const readyItemLabel = (i: number): string => READY_LABELS[i] ?? "Unknown check";

export interface ReadinessCheck {
  item: ReadyItem;
  ok: boolean;
  mandatory: boolean;
  detail: string;
}

export interface LocalReadiness {
  ok: boolean;
  reasons: string[];
  checks: ReadinessCheck[];
}

/** "input=1,engine=1,..." */
export const encodeChecks = (checks: ReadinessCheck[]): string => checks.map((c) => `${readyItemId(c.item)}=${c.ok ? 1 : 0}`).join(",");

/** Unknown ids are skipped (a newer peer may send more items). */
export function decodeChecks(text: string): ReadinessCheck[] {
  const out: ReadinessCheck[] = [];
  for (const pair of text.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const idx = READY_IDS.indexOf(pair.slice(0, eq));
    if (idx >= 0) out.push({ item: idx as ReadyItem, ok: pair.slice(eq + 1) === "1", mandatory: true, detail: "" });
  }
  return out;
}

export const allMandatoryOk = (checks: ReadinessCheck[]): boolean => checks.every((c) => !c.mandatory || c.ok);
