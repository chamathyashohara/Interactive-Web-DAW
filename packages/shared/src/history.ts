import type { Op } from "./ops";

export interface HistoryEntry {
  /** Ops that, applied in order, revert this entry. */
  inverse: Op[];
  /** Consecutive entries with the same group within `MERGE_WINDOW_MS` collapse into one undo step. */
  group?: string;
  at: number;
}

export const MERGE_WINDOW_MS = 800;

/** Undo/redo stacks of inverse ops. Pure data structure; the caller applies the ops. */
export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  record(inverse: Op[], group: string | undefined, now: number): void {
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];
    if (group && top && top.group === group && now - top.at <= MERGE_WINDOW_MS) {
      top.at = now; // keep the oldest inverse so one undo restores the original value
      return;
    }
    this.undoStack.push({ inverse, group, at: now });
  }

  popUndo(): HistoryEntry | undefined {
    return this.undoStack.pop();
  }
  pushRedo(entry: HistoryEntry): void {
    this.redoStack.push(entry);
  }
  popRedo(): HistoryEntry | undefined {
    return this.redoStack.pop();
  }
  /** Used when redoing: restores an entry to the undo stack without clearing redo. */
  pushUndoKeepRedo(entry: HistoryEntry): void {
    this.undoStack.push(entry);
  }
  /** Forget all undo/redo (used when the editor switches to a different project). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
