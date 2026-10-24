import { randomUUID } from 'node:crypto'
import { applyOp, stamp, type Op, type Project } from '../daw-shared'
import { diffProjects } from '../shared/restore'
import { MAX_OPS_PER_MESSAGE, type LogEntry } from '../shared/protocol'

/** How many accepted ops a room remembers for catching clients up. Older ones force a full snapshot. */
const MAX_LOG = 50_000

export type RestoreResult = { ok: true; entries: LogEntry[] } | { ok: false; reason: string };

export type SubmitResult =
  | { ok: true; entries: LogEntry[]; duplicates: string[] }
  | { ok: false; reason: string; opIds: string[] };

/**
 * One session's authoritative state: the project plus the single ordered list of accepted ops.
 * Pure logic with no sockets, so it can be tested directly.
 * Every op goes through the shared `applyOp`, so the server enforces the same rules as the desktop app.
 */
export class Room {
  project: Project;
  /** The project as the session started, so any earlier step can be rebuilt by replaying the log. */
  readonly initial: Project;
  /** Number of ops accepted so far; the last entry has this seq. */
  seq = 0;
  private log: LogEntry[] = [];
  /** seq of the op just before the first entry still in `log`. */
  private baseSeq = 0;

  constructor(
    project: Project,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.project = project;
    this.initial = project;
  }

  /**
   * Validates a batch against the current project and, if every op is valid, accepts it in order.
   * All-or-nothing, like the desktop app's batches. Ops already applied (same opId) are skipped.
   */
  submit(clientId: string, ops: unknown): SubmitResult {
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS_PER_MESSAGE) {
      return { ok: false, reason: `a message carries 1 to ${MAX_OPS_PER_MESSAGE} ops`, opIds: [] };
    }
    const opIds = ops.map((o) => (o && typeof (o as Op).opId === 'string' ? (o as Op).opId : ''));

    let sim = this.project;
    const accepted: Op[] = [];
    const duplicates: string[] = [];
    for (const raw of ops) {
      const op = raw as Op;
      if (!op || typeof op !== 'object' || typeof op.type !== 'string' || typeof op.opId !== 'string') {
        return { ok: false, reason: 'malformed op', opIds };
      }
      if (op.clientId !== clientId) return { ok: false, reason: 'op is stamped with another client id', opIds };

      let result;
      try {
        result = applyOp(sim, op);
      } catch {
        return { ok: false, reason: 'malformed op', opIds };
      }
      if (!result.ok) return { ok: false, reason: result.reason, opIds };
      if (result.applied) {
        accepted.push(op);
        sim = result.project;
      } else {
        duplicates.push(op.opId);
      }
    }

    return { ok: true, entries: this.commit(accepted, sim), duplicates };
  }

  /** Records ops that have already been checked, in order, and makes `sim` the current project. */
  private commit(ops: Op[], sim: Project, restore?: number): LogEntry[] {
    const at = this.now();
    const entries: LogEntry[] = ops.map((op) => ({ seq: ++this.seq, op, at, ...(restore !== undefined ? { restore } : {}) }));
    this.project = sim;
    this.log.push(...entries);
    if (this.log.length > MAX_LOG) {
      const drop = this.log.length - MAX_LOG;
      this.baseSeq += drop;
      this.log.splice(0, drop);
    }
    return entries;
  }

  /** The project as it was just after step `seq` (0 = as the session started), or null if that is no longer known. */
  stateAt(seq: number): Project | null {
    if (!Number.isInteger(seq) || seq < 0 || seq > this.seq || this.baseSeq > 0) return null;
    let p = this.initial;
    for (const entry of this.log) {
      if (entry.seq > seq) break;
      const r = applyOp(p, entry.op);
      if (!r.ok) return null;
      p = r.project;
    }
    return p;
  }

  /**
   * Puts the project back to how it was just after step `toSeq`. This is a new action, not an erasure:
   * the ops that get there are added to the log (marked `restore`), so the history stays complete and
   * restoring to a later step undoes the restore.
   */
  restoreTo(clientId: string, toSeq: number): RestoreResult {
    if (!Number.isInteger(toSeq) || toSeq < 0 || toSeq > this.seq) return { ok: false, reason: 'there is no such step' };
    if (this.baseSeq > 0) return { ok: false, reason: 'that part of the history is too old to restore' };
    const target = this.stateAt(toSeq);
    if (!target) return { ok: false, reason: 'that step cannot be rebuilt' };
    const bodies = diffProjects(this.project, target);
    if (bodies === null) return { ok: false, reason: 'that step cannot be restored exactly' };
    if (bodies.length === 0) return { ok: false, reason: 'the project is already like that' };

    let sim = this.project;
    const ops: Op[] = [];
    for (const body of bodies) {
      const op = stamp(body, randomUUID(), clientId);
      const r = applyOp(sim, op);
      if (!r.ok) return { ok: false, reason: r.reason };
      sim = r.project;
      ops.push(op);
    }
    return { ok: true, entries: this.commit(ops, sim, toSeq) };
  }

  /** The last `n` accepted ops, oldest first, so a late joiner can see what was already done. */
  recent(n = 100): LogEntry[] {
    return this.log.slice(-n);
  }

  /** Ops a client missed after `lastSeq`, or null if the client must take a full snapshot instead. */
  entriesSince(lastSeq: number | null): LogEntry[] | null {
    if (lastSeq === null || !Number.isInteger(lastSeq) || lastSeq < this.baseSeq || lastSeq > this.seq) return null;
    return this.log.slice(lastSeq - this.baseSeq);
  }
}
