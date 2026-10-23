import { randomUUID } from "node:crypto";
import { applyOp, History, invertOp, stamp, type Op, type OpBody, type Project } from "@daw/shared";
import { LocalStore } from "./localStore";

export interface ProjectListener {
  (project: Project, meta: { canUndo: boolean; canRedo: boolean }): void;
}

export type DispatchResult = { ok: true } | { ok: false; reason: string };

/**
 * Owns the authoritative local project state. All edits arrive as ops, are validated by the shared
 * `applyOp`, journalled to disk, and then published to listeners (renderer + audio engine).
 */
export class ProjectService {
  private project: Project;
  private readonly history = new History();
  private listeners: ProjectListener[] = [];

  constructor(
    private store: LocalStore,
    readonly clientId: string = randomUUID(),
    private readonly projectId: string = "default",
    private readonly now: () => number = () => Date.now(),
  ) {
    this.project = store.open(projectId);
  }

  /** Switches the editor to a different project's store: closes the current one, opens the new, and clears undo/redo. */
  load(store: LocalStore): void {
    this.store.close();
    this.store = store;
    this.project = store.open(this.projectId);
    this.history.clear();
    this.publish();
  }

  /** Writes the current state to disk immediately (so a copy/Save As sees the latest edits). */
  flush(): void {
    this.store.snapshot(this.project);
  }

  /** Renames the project (not a musical edit: not journalled, not undoable); persists and publishes at once. */
  setName(name: string): void {
    if (name === this.project.name) return;
    this.project = { ...this.project, name };
    this.store.snapshot(this.project);
    this.publish();
  }

  get current(): Project {
    return this.project;
  }
  get canUndo() {
    return this.history.canUndo;
  }
  get canRedo() {
    return this.history.canRedo;
  }

  subscribe(listener: ProjectListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Apply a user edit. `group` merges rapid successive edits (e.g. a fader drag) into one undo step. */
  dispatch(body: OpBody, group?: string): DispatchResult {
    return this.dispatchBatch([body], group);
  }

  /**
   * Applies several ops as ONE undoable step (paste, slice, quantize, delete selection...).
   * All-or-nothing: the whole batch is validated first, and nothing is applied if any op is rejected.
   */
  dispatchBatch(bodies: OpBody[], group?: string): DispatchResult {
    if (bodies.length === 0) return { ok: true };
    const ops = bodies.map((b) => stamp(b, randomUUID(), this.clientId));

    let simulated = this.project;
    const inverses: Op[] = [];
    for (const op of ops) {
      const result = applyOp(simulated, op);
      if (!result.ok) return result;
      const inverse = invertOp(simulated, op, randomUUID());
      if (inverse) inverses.unshift(inverse); // undo runs in reverse order
      simulated = result.project;
    }

    for (const op of ops) this.applyAndPersist(op);
    if (inverses.length) this.history.record(inverses, group, this.now());
    this.publish();
    return { ok: true };
  }

  undo(): boolean {
    const entry = this.history.popUndo();
    if (!entry) return false;
    this.history.pushRedo({ inverse: this.applyInverse(entry.inverse), at: this.now() });
    this.publish();
    return true;
  }

  redo(): boolean {
    const entry = this.history.popRedo();
    if (!entry) return false;
    this.history.pushUndoKeepRedo({ inverse: this.applyInverse(entry.inverse), at: this.now() });
    this.publish();
    return true;
  }

  close() {
    this.store.snapshot(this.project);
    this.store.close();
  }

  /** Applies an inverse list and returns the inverse of what was applied (for redo/undo). */
  private applyInverse(ops: Op[]): Op[] {
    const reverse: Op[] = [];
    for (const op of ops) {
      const before = this.project;
      const fresh = { ...op, opId: randomUUID() } as Op;
      if (!this.applyAndPersist(fresh).ok) continue;
      const inv = invertOp(before, fresh, randomUUID());
      if (inv) reverse.unshift(inv);
    }
    return reverse;
  }

  private applyAndPersist(op: Op): DispatchResult {
    const result = applyOp(this.project, op);
    if (!result.ok) return result;
    if (result.applied) {
      this.project = result.project;
      this.store.append(op);
      this.store.maybeSnapshot(this.project);
    }
    return { ok: true };
  }

  private publish() {
    const meta = { canUndo: this.history.canUndo, canRedo: this.history.canRedo };
    for (const l of this.listeners) l(this.project, meta);
  }
}
