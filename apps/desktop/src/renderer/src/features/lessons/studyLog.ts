import { browserStore, readJson, writeJson, type KeyValueStore } from "./storage";

/**
 * Anonymous evaluation log for the user study. Nothing is recorded unless a researcher has started a study session
 * with a participant code. Data stays in local storage on this machine until it is exported.
 */

export interface StudySession {
  participant: string;
  session: string;
  startedAt: string;
}

export type Outcome = "open" | "passed" | "left" | "abandoned";

export interface ExerciseRecord {
  participant: string;
  session: string;
  lessonId: string;
  lessonVersion: number;
  stepId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: Outcome;
  /** Check presses. */
  checks: number;
  /** Score (0..1) at each Check, in order. */
  scores: number[];
  firstScore: number | null;
  finalScore: number | null;
  hintsShown: number;
  resets: number;
  /** Internal: last time anything happened, used to close records left open by a crash. */
  lastActivityAt: string;
}

interface State {
  session: StudySession | null;
  records: ExerciseRecord[];
}

const KEY = "lessons.study.v1";
/** Letters, digits, '-' and '_' only: a code, never a name or an email address. */
export const PARTICIPANT_CODE = /^[A-Za-z0-9_-]{1,16}$/;

export const CSV_COLUMNS = [
  "participant",
  "session",
  "lessonId",
  "lessonVersion",
  "stepId",
  "startedAt",
  "endedAt",
  "durationMs",
  "outcome",
  "checks",
  "firstScore",
  "finalScore",
  "scores",
  "hintsShown",
  "resets",
] as const;

export function createStudyLog(store: KeyValueStore, now: () => Date = () => new Date(), newId: () => string = () => crypto.randomUUID()) {
  let state = readJson<State>(store, KEY, { session: null, records: [] });

  const save = () => writeJson(store, KEY, state);
  const iso = () => now().toISOString();
  const close = (r: ExerciseRecord, outcome: Exclude<Outcome, "open">, at: string) => {
    r.outcome = outcome;
    r.endedAt = at;
    r.durationMs = Date.parse(at) - Date.parse(r.startedAt);
  };
  const openRecord = () => state.records.find((r) => r.outcome === "open" && r.session === state.session?.session);

  // Records still open from an earlier run were interrupted (app closed or crashed): close them at their last activity.
  for (const r of state.records) if (r.outcome === "open") close(r, "abandoned", r.lastActivityAt);
  save();

  const touch = (mutate: (r: ExerciseRecord) => void) => {
    const r = openRecord();
    if (!r) return;
    mutate(r);
    r.lastActivityAt = iso();
    save();
  };

  return {
    session: (): StudySession | null => state.session,
    records: (): ExerciseRecord[] => state.records,

    startSession(participant: string): { ok: true } | { ok: false; reason: string } {
      const code = participant.trim();
      if (!PARTICIPANT_CODE.test(code)) return { ok: false, reason: "Use a short code such as P07 (letters, digits, - or _), never a name." };
      this.endSession();
      state = { ...state, session: { participant: code, session: newId(), startedAt: iso() } };
      save();
      return { ok: true };
    },

    endSession() {
      const r = openRecord();
      if (r) close(r, "left", iso());
      state = { ...state, session: null };
      save();
    },

    /** Called when the learner starts (or comes back to) an exercise. Continues the open record for the same exercise. */
    beginExercise(lessonId: string, lessonVersion: number, stepId: string) {
      const s = state.session;
      if (!s) return;
      const open = openRecord();
      if (open && open.lessonId === lessonId && open.stepId === stepId) return;
      const at = iso();
      if (open) close(open, "left", at);
      state.records.push({
        participant: s.participant,
        session: s.session,
        lessonId,
        lessonVersion,
        stepId,
        startedAt: at,
        endedAt: null,
        durationMs: null,
        outcome: "open",
        checks: 0,
        scores: [],
        firstScore: null,
        finalScore: null,
        hintsShown: 0,
        resets: 0,
        lastActivityAt: at,
      });
      save();
    },

    /** The learner left the exercise without passing it. */
    leaveExercise() {
      const r = openRecord();
      if (!r) return;
      close(r, "left", iso());
      save();
    },

    recordCheck(score: number, pass: boolean) {
      touch((r) => {
        r.checks++;
        r.scores.push(score);
        r.firstScore ??= score;
        r.finalScore = score;
        if (pass) close(r, "passed", iso());
      });
    },
    recordHint: () => touch((r) => r.hintsShown++),
    recordReset: () => touch((r) => r.resets++),

    deleteParticipant(participant: string): number {
      const before = state.records.length;
      state = { ...state, records: state.records.filter((r) => r.participant !== participant.trim()) };
      save();
      return before - state.records.length;
    },

    exportJson(): string {
      const records = state.records.map(({ lastActivityAt: _internal, ...r }) => r);
      return JSON.stringify({ format: "lessons-study-log", schema: 1, exportedAt: iso(), records }, null, 2);
    },

    exportCsv(): string {
      const cell = (v: unknown) => {
        const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(";") : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const rows = state.records.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(","));
      return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
    },
  };
}

export type StudyLog = ReturnType<typeof createStudyLog>;

export const studyLog = createStudyLog(browserStore());
