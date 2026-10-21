import fs from "node:fs";
import path from "node:path";
import { defaultProgress, isLessonId, type Progress, type ProgressMode } from "@daw/shared";

export type CompleteResult = { ok: true; progress: Progress; newlyCompleted: boolean } | { ok: false; reason: string };

const MODES: ProgressMode[] = ["beginner", "all"];

/**
 * Per-user learning progress: which lessons are done and whether features are gated.
 * Stored beside (not inside) the project, because it belongs to the learner, not to a song, and must never be synced to collaborators.
 * Every change is also appended to an anonymous event log (for the evaluation); no names or project content.
 * No Electron imports, so it is unit-testable in plain Node.
 */
export class ProgressStore {
  private progress: Progress;

  constructor(
    private readonly dir: string,
    defaultMode: ProgressMode = "all",
    private readonly now: () => number = () => Date.now(),
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.progress = this.load(defaultMode);
  }

  private get file() {
    return path.join(this.dir, "progress.json");
  }
  private get eventsFile() {
    return path.join(this.dir, "progress-events.ndjson");
  }

  private load(defaultMode: ProgressMode): Progress {
    const fallback = { ...defaultProgress(), mode: defaultMode };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Progress>;
      return {
        mode: MODES.includes(raw.mode as ProgressMode) ? (raw.mode as ProgressMode) : defaultMode,
        completedLessons: Array.isArray(raw.completedLessons) ? [...new Set(raw.completedLessons.filter(isLessonId))] : [],
      };
    } catch {
      return fallback; // missing or corrupt: start fresh rather than crash
    }
  }

  get(): Progress {
    return { mode: this.progress.mode, completedLessons: [...this.progress.completedLessons] };
  }

  /** Records a finished lesson. Idempotent: completing the same lesson again changes nothing. */
  completeLesson(lessonId: unknown): CompleteResult {
    if (!isLessonId(lessonId)) return { ok: false, reason: `"${String(lessonId)}" is not a lesson id like "M2.6"` };
    const newlyCompleted = !this.progress.completedLessons.includes(lessonId);
    if (newlyCompleted) {
      this.progress = { ...this.progress, completedLessons: [...this.progress.completedLessons, lessonId] };
      this.persist();
      this.log({ t: "lesson.completed", lessonId });
    }
    return { ok: true, progress: this.get(), newlyCompleted };
  }

  setMode(mode: unknown): Progress {
    if (MODES.includes(mode as ProgressMode) && mode !== this.progress.mode) {
      this.progress = { ...this.progress, mode: mode as ProgressMode };
      this.persist();
      this.log({ t: "mode.changed", mode });
    }
    return this.get();
  }

  /** Forget all completed lessons (used by the developer tools and tests). */
  reset(): Progress {
    this.progress = { ...this.progress, completedLessons: [] };
    this.persist();
    this.log({ t: "progress.reset" });
    return this.get();
  }

  private persist() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.progress, null, 2));
    fs.renameSync(tmp, this.file);
  }

  private log(event: Record<string, unknown>) {
    try {
      fs.appendFileSync(this.eventsFile, JSON.stringify({ ...event, at: this.now() }) + "\n");
    } catch {
      /* logging must never break the app */
    }
  }
}
