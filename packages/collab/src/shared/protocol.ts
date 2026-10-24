import type { Op, Project } from '@daw/shared'

/** Most ops one message may carry (a paste or quantize is one batch). */
export const MAX_OPS_PER_MESSAGE = 500

export interface UserInfo {
  id: string
  name: string
  /** Chosen by the server so that no two people in a session share a colour. */
  color: string
}

/** One accepted op, in the single order the server decided. */
export interface LogEntry {
  seq: number
  op: Op
  /** Server time in ms when the op was accepted. */
  at: number
  /** Set when this op is part of a restore: the step the project was put back to. */
  restore?: number
}

/** A note put in the room by one person for everyone to read. */
export interface SharedNote {
  /** Client id of the person who put it there. */
  id: string
  topic: string
  data: unknown
}

/** Topic names are short lowercase words; the note itself is kept small. */
export const SHARE_TOPIC = /^[a-z][a-z0-9-]{0,31}$/
export const MAX_SHARE_BYTES = 1024

/** App -> server. The room is chosen by the URL: /ops/<6-digit code>. */
export type ClientMsg =
  | { t: 'hello'; clientId: string; name: string; color: string; lastSeq: number | null }
  /** A batch is all-or-nothing: if one op is invalid the whole batch is rejected. */
  | { t: 'ops'; ops: Op[] }
  | { t: 'presence'; state: Record<string, unknown> | null }
  | { t: 'probe'; seq: number; at: number }
  /** Put the project back to how it was just after step `toSeq` (0 = the original). Recorded as a new action; nothing is erased. */
  | { t: 'restore'; toSeq: number }
  /**
   * Puts a small note in the room that everyone (including people who join later) can read, such as how to reach a live recording.
   * One note per topic; `data: null` takes it down. It disappears by itself when the person who put it there leaves.
   */
  | { t: 'share'; topic: string; data: unknown | null }

/** Server -> app. */
export type ServerMsg =
  /** Sent once after hello: a full project (`project`, plus recent `history`) or just the ops missed since `lastSeq` (`entries`). */
  | { t: 'welcome'; seq: number; project?: Project; entries?: LogEntry[]; /** recent past actions, sent with a snapshot */ history?: LogEntry[]; users: UserInfo[]; /** notes put in the room (see `share`), always the full current set */ shared?: SharedNote[] }
  /** Accepted ops, to everyone in the room including the sender (that is the sender's acknowledgement). */
  | { t: 'entries'; entries: LogEntry[] }
  | { t: 'reject'; opIds: string[]; reason: string }
  /** A request that is not an edit (a restore) was refused. */
  | { t: 'refused'; reason: string }
  | { t: 'users'; users: UserInfo[] }
  | { t: 'presence'; id: string; state: Record<string, unknown> | null }
  | { t: 'probe'; id: string; seq: number; at: number }
  | { t: 'share'; id: string; topic: string; data: unknown | null }
