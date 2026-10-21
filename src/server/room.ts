import { applyOp, type Op, type Project } from '../daw-shared'
import { MAX_OPS_PER_MESSAGE, type LogEntry } from '../shared/protocol'

/** How many accepted ops a room remembers for catching clients up. Older ones force a full snapshot. */
const MAX_LOG = 50_000

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

    const at = this.now();
    const entries: LogEntry[] = accepted.map((op) => ({ seq: ++this.seq, op, at }));
    this.project = sim;
    this.log.push(...entries);
    if (this.log.length > MAX_LOG) {
      const drop = this.log.length - MAX_LOG;
      this.baseSeq += drop;
      this.log.splice(0, drop);
    }
    return { ok: true, entries, duplicates };
  }

  /** Ops a client missed after `lastSeq`, or null if the client must take a full snapshot instead. */
  entriesSince(lastSeq: number | null): LogEntry[] | null {
    if (lastSeq === null || !Number.isInteger(lastSeq) || lastSeq < this.baseSeq || lastSeq > this.seq) return null;
    return this.log.slice(lastSeq - this.baseSeq);
  }
}
