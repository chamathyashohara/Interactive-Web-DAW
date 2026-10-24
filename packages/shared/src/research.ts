import { FEATURES, type FeatureId } from "./features";

/**
 * Evaluation data: what the DAW records (locally, anonymously, only after consent) and how it is turned into numbers.
 * Events carry no names, no file paths and no musical content beyond "was this note in the key". Pure functions, no I/O.
 */

export type EventValue = string | number | boolean | null;

export interface TelemetryEvent {
  /** Event name, e.g. "edit", "note.added", "ui.tool", "lesson.completed". */
  t: string;
  /** Unix ms. */
  at: number;
  /** App session (one launch). */
  s?: string;
  /** The study condition when it happened: "beginner" (features gated by lessons) or "all". */
  mode?: "beginner" | "all";
  [field: string]: EventValue | undefined;
}

export const MAX_ACTIVE_GAP_MS = 60_000;

/** Time spent working: the gaps between consecutive events, ignoring pauses longer than a minute (the learner was away). */
export function activeMs(events: TelemetryEvent[]): number {
  const at = events.map((e) => e.at).sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < at.length; i++) {
    const gap = at[i]! - at[i - 1]!;
    if (gap <= MAX_ACTIVE_GAP_MS) total += gap;
  }
  return total;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const rate = (part: number, whole: number): number | null => (whole ? part / whole : null);

/** Which events show that a gated feature was used. Features without an entry have no usage signal. */
export const FEATURE_EVIDENCE: Partial<Record<FeatureId, (e: TelemetryEvent) => boolean>> = {
  "tool.select": (e) => e.t === "ui.tool" && e.tool === "select",
  "tool.paint": (e) => e.t === "ui.tool" && e.tool === "paint",
  "tool.mute": (e) => e.t === "ui.tool" && e.tool === "mute",
  "tool.slice": (e) => e.t === "ui.tool" && e.tool === "slice",
  "key.help": (e) => e.t === "ui.keyHelp" && e.on === true,
  "tracks.multiple": (e) => e.t === "edit" && e.op === "addTrack",
  "tracks.drums": (e) => e.t === "edit" && e.op === "addTrack" && e.kind === "drums",
  "browser.samples": (e) => e.t === "ui.panel" && e.panel === "samples" && e.open === true,
  "seq.steps": (e) => e.t === "ui.view" && e.view === "steps",
  "velocity.ramp": (e) => e.t === "ui.ramp",
  "arrangement.clips": (e) => e.t === "edit" && (e.op === "addClip" || e.op === "deleteClip" || e.op === "setSongLength"),
  "arrangement.loop": (e) => e.t === "edit" && e.op === "setLoop",
  "arrangement.markers": (e) => e.t === "edit" && e.op === "setMarkers",
  "automation.lanes": (e) => e.t === "edit" && e.op === "setAutomation",
  "mixer.panel": (e) => e.t === "ui.panel" && e.panel === "mixer" && e.open === true,
  "mixer.muteSolo": (e) => e.t === "edit" && e.op === "updateTrack" && (e.fields === "mute" || e.fields === "solo"),
  "export.wav": (e) => e.t === "ui.export",
};

export interface ModeMetrics {
  activeMinutes: number;
  edits: number;
  editsPerActiveMinute: number | null;
  notesAdded: number;
  keyedNotes: number;
  outOfKeyNotes: number;
  outOfKeyRate: number | null;
  /** Out-of-key rate over the first and the last third of the keyed notes (needs at least 6): does it fall with practice? */
  outOfKeyRateFirstThird: number | null;
  outOfKeyRateLastThird: number | null;
  corrected: number;
  correctedShare: number | null;
  medianCorrectionMs: number | null;
  undos: number;
  redos: number;
  lockedAttempts: number;
}

export interface Metrics extends ModeMetrics {
  sessions: number;
  events: number;
  lockedByLesson: Record<string, number>;
  correctionsByVia: Record<string, number>;
  lessonsCompleted: string[];
  /** For every feature a completed lesson unlocked: when, and how long until the learner first used it. */
  adoption: { feature: FeatureId; lesson: string; unlockedAt: number; firstUseAt: number | null; latencyMs: number | null }[];
  byMode: Partial<Record<"beginner" | "all", ModeMetrics>>;
}

function modeMetrics(events: TelemetryEvent[]): ModeMetrics {
  const ms = activeMs(events);
  const edits = events.filter((e) => e.t === "edit");
  const added = events.filter((e) => e.t === "note.added").sort((a, b) => a.at - b.at);
  const keyed = added.filter((e) => e.inKey === true || e.inKey === false);
  const bad = keyed.filter((e) => e.inKey === false);
  const third = Math.ceil(keyed.length / 3);
  const first = keyed.slice(0, third), last = keyed.slice(keyed.length - third);
  const corrections = events.filter((e) => e.t === "note.corrected");
  const fixedIn = corrections.filter((e) => typeof e.ms === "number").map((e) => e.ms as number);
  return {
    activeMinutes: ms / 60_000,
    edits: edits.length,
    editsPerActiveMinute: ms > 0 ? edits.length / (ms / 60_000) : null,
    notesAdded: added.length,
    keyedNotes: keyed.length,
    outOfKeyNotes: bad.length,
    outOfKeyRate: rate(bad.length, keyed.length),
    outOfKeyRateFirstThird: keyed.length >= 6 ? rate(first.filter((e) => e.inKey === false).length, first.length) : null,
    outOfKeyRateLastThird: keyed.length >= 6 ? rate(last.filter((e) => e.inKey === false).length, last.length) : null,
    corrected: corrections.length,
    correctedShare: rate(corrections.length, bad.length),
    medianCorrectionMs: median(fixedIn),
    undos: events.filter((e) => e.t === "history" && e.kind === "undo").length,
    redos: events.filter((e) => e.t === "history" && e.kind === "redo").length,
    lockedAttempts: events.filter((e) => e.t === "ui.locked").length,
  };
}

/** The headline numbers for one participant's merged event log (lessons and DAW events together). */
export function computeMetrics(events: TelemetryEvent[]): Metrics {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const lockedByLesson: Record<string, number> = {};
  for (const e of sorted) if (e.t === "ui.locked" && typeof e.lesson === "string") lockedByLesson[e.lesson] = (lockedByLesson[e.lesson] ?? 0) + 1;
  const correctionsByVia: Record<string, number> = {};
  for (const e of sorted) if (e.t === "note.corrected") correctionsByVia[String(e.via)] = (correctionsByVia[String(e.via)] ?? 0) + 1;

  const completions = sorted.filter((e) => e.t === "lesson.completed" && typeof e.lessonId === "string");
  const lessonsCompleted = [...new Set(completions.map((e) => e.lessonId as string))];
  const adoption: Metrics["adoption"] = [];
  for (const c of completions) {
    const firstDone = completions.find((x) => x.lessonId === c.lessonId)!;
    if (firstDone !== c) continue;
    for (const f of FEATURES.filter((x) => x.unlockedBy === c.lessonId)) {
      const test = FEATURE_EVIDENCE[f.id as FeatureId];
      const use = test ? sorted.find((e) => e.at >= c.at && test(e)) : undefined;
      adoption.push({ feature: f.id as FeatureId, lesson: c.lessonId as string, unlockedAt: c.at, firstUseAt: use?.at ?? null, latencyMs: use ? use.at - c.at : null });
    }
  }

  const byMode: Metrics["byMode"] = {};
  for (const mode of ["beginner", "all"] as const) {
    const subset = sorted.filter((e) => e.mode === mode);
    if (subset.length) byMode[mode] = modeMetrics(subset);
  }
  return {
    ...modeMetrics(sorted),
    sessions: new Set(sorted.map((e) => e.s).filter(Boolean)).size,
    events: sorted.length,
    lockedByLesson,
    correctionsByVia,
    lessonsCompleted,
    adoption,
    byMode,
  };
}

const CSV_COLUMNS = ["at", "iso", "s", "mode", "t"];
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per event: fixed columns first, then every other field that appears (as its own column), for a spreadsheet. */
export function eventsToCsv(events: TelemetryEvent[]): string {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const extra = [...new Set(sorted.flatMap((e) => Object.keys(e)))].filter((k) => !CSV_COLUMNS.includes(k)).sort();
  const cols = [...CSV_COLUMNS, ...extra];
  const lines = [cols.join(",")];
  for (const e of sorted) lines.push(cols.map((c) => csvCell(c === "iso" ? new Date(e.at).toISOString() : e[c])).join(","));
  return lines.join("\n") + "\n";
}

/** The metrics as two-column rows (name, value), for a quick look or a table in the report. */
export function metricsToCsv(m: Metrics): string {
  const rows: [string, unknown][] = [
    ["sessions", m.sessions], ["events", m.events], ["active_minutes", round(m.activeMinutes)], ["edits", m.edits], ["edits_per_active_minute", round(m.editsPerActiveMinute)],
    ["notes_added", m.notesAdded], ["keyed_notes", m.keyedNotes], ["out_of_key_notes", m.outOfKeyNotes], ["out_of_key_rate", round(m.outOfKeyRate)],
    ["out_of_key_rate_first_third", round(m.outOfKeyRateFirstThird)], ["out_of_key_rate_last_third", round(m.outOfKeyRateLastThird)],
    ["corrected", m.corrected], ["corrected_share", round(m.correctedShare)], ["median_correction_seconds", round(m.medianCorrectionMs === null ? null : m.medianCorrectionMs / 1000)],
    ["undos", m.undos], ["redos", m.redos], ["locked_attempts", m.lockedAttempts], ["lessons_completed", m.lessonsCompleted.length],
  ];
  for (const [mode, mm] of Object.entries(m.byMode)) {
    rows.push([`${mode}.active_minutes`, round(mm.activeMinutes)], [`${mode}.out_of_key_rate`, round(mm.outOfKeyRate)], [`${mode}.median_correction_seconds`, round(mm.medianCorrectionMs === null ? null : mm.medianCorrectionMs / 1000)], [`${mode}.edits_per_active_minute`, round(mm.editsPerActiveMinute)]);
  }
  for (const a of m.adoption) rows.push([`adoption.${a.feature}.seconds_to_first_use`, round(a.latencyMs === null ? null : a.latencyMs / 1000)]);
  return "metric,value\n" + rows.map(([k, v]) => `${csvCell(k)},${csvCell(v)}`).join("\n") + "\n";
}
const round = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
