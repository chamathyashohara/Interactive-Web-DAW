import type { Op, Project } from '../daw-shared'

/** Most ops one message may carry (a paste or quantize is one batch). */
export const MAX_OPS_PER_MESSAGE = 500

export interface UserInfo {
  id: string
  name: string
  color: string
}

/** One accepted op, in the single order the server decided. */
export interface LogEntry {
  seq: number
  op: Op
  /** Server time in ms when the op was accepted. */
  at: number
}

/** App -> server. The room is chosen by the URL: /ops/<6-digit code>. */
export type ClientMsg =
  | { t: 'hello'; clientId: string; name: string; color: string; lastSeq: number | null }
  /** A batch is all-or-nothing: if one op is invalid the whole batch is rejected. */
  | { t: 'ops'; ops: Op[] }
  | { t: 'presence'; state: Record<string, unknown> | null }
  | { t: 'probe'; seq: number; at: number }

/** Server -> app. */
export type ServerMsg =
  /** Sent once after hello: a full project (`project`) or just the ops missed since `lastSeq` (`entries`). */
  | { t: 'welcome'; seq: number; project?: Project; entries?: LogEntry[]; users: UserInfo[] }
  /** Accepted ops, to everyone in the room including the sender (that is the sender's acknowledgement). */
  | { t: 'entries'; entries: LogEntry[] }
  | { t: 'reject'; opIds: string[]; reason: string }
  | { t: 'users'; users: UserInfo[] }
  | { t: 'presence'; id: string; state: Record<string, unknown> | null }
  | { t: 'probe'; id: string; seq: number; at: number }
