import { applyOp, type Op, type Project } from '@daw/shared'
import type { LogEntry } from '../shared/protocol'

export interface Dropped {
  op: Op
  reason: string
}

export type ReceiveStatus = 'ok' | 'stale' | 'gap' | 'diverged'

/**
 * One app's copy of the shared project.
 *
 *  - `confirmed`: the project after every op the server has accepted, applied in the server's order.
 *  - `pending`: this user's own batches the server has not confirmed yet.
 *  - `view`: confirmed + pending replayed on top. This is what the user sees, so their own edits feel instant.
 *
 * When the server confirms ops in a different order than the user made them (because someone else's edit
 * was ordered first), `view` is rebuilt, and any pending edit that no longer applies is dropped and reported.
 * Pure logic with no sockets or timers, so it is easy to test.
 */
export class Replica {
  private confirmed: Project;
  private pending: Op[][] = [];
  view: Project;
  seq: number;

  constructor(project: Project, seq: number) {
    this.confirmed = project;
    this.view = project;
    this.seq = seq;
  }

  get pendingBatches(): Op[][] {
    return this.pending;
  }

  /** Replaces the confirmed state with a fresh snapshot (after reconnecting), keeping pending edits on top. */
  resetTo(project: Project, seq: number): Dropped[] {
    this.confirmed = project;
    this.seq = seq;
    return this.rebuild();
  }

  /** Applies the user's own edit to the view at once and queues it for the server. */
  localApply(ops: Op[]): { ok: true } | { ok: false; reason: string } {
    let sim = this.view;
    for (const op of ops) {
      const r = applyOp(sim, op);
      if (!r.ok) return { ok: false, reason: r.reason };
      sim = r.project;
    }
    this.pending.push(ops);
    this.view = sim;
    return { ok: true };
  }

  /** Takes the next accepted op from the server. Must arrive in order: seq = this.seq + 1. */
  receive(entry: LogEntry): { status: ReceiveStatus; dropped: Dropped[] } {
    if (entry.seq <= this.seq) return { status: 'stale', dropped: [] };
    if (entry.seq !== this.seq + 1) return { status: 'gap', dropped: [] };

    const r = applyOp(this.confirmed, entry.op);
    if (!r.ok) return { status: 'diverged', dropped: [] };
    this.confirmed = r.project;
    this.seq = entry.seq;

    // If this was one of our own ops, it is now confirmed and no longer pending.
    this.pending = this.pending.map((batch) => batch.filter((o) => o.opId !== entry.op.opId)).filter((b) => b.length > 0);
    return { status: 'ok', dropped: this.rebuild() };
  }

  /** The server refused these ops. Their whole batches are removed (batches are all-or-nothing). */
  reject(opIds: string[], reason: string): Dropped[] {
    const ids = new Set(opIds);
    const dropped: Dropped[] = [];
    this.pending = this.pending.filter((batch) => {
      if (!batch.some((o) => ids.has(o.opId))) return true;
      for (const op of batch) dropped.push({ op, reason });
      return false;
    });
    this.rebuild();
    return dropped;
  }

  /** view = confirmed + pending. Batches that no longer apply are dropped and returned. */
  private rebuild(): Dropped[] {
    const dropped: Dropped[] = [];
    let v = this.confirmed;
    const kept: Op[][] = [];
    for (const batch of this.pending) {
      let sim = v;
      let failure: string | null = null;
      for (const op of batch) {
        const r = applyOp(sim, op);
        if (!r.ok) {
          failure = r.reason;
          break;
        }
        sim = r.project;
      }
      if (failure === null) {
        v = sim;
        kept.push(batch);
      } else {
        for (const op of batch) dropped.push({ op, reason: failure });
      }
    }
    this.pending = kept;
    this.view = v;
    return dropped;
  }
}
