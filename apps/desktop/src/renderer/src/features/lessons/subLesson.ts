import type { Clip } from "@daw/shared";
import type { GuideNote } from "../../pianoRoll/PianoRoll";
import { notesToEvents, type PreviewEvent } from "./audio";
import type { ExerciseStep } from "./useExercise";
import { pitchClass, pitchClassOf } from "./theory";
import type { GuideNoteSpec, StarterNote, SubLesson, WatchStep } from "./types";

/** Pure helpers for the 7-stage player: turning sub-lesson data into what the piano roll and the exercise hook need. */

export type StageId = "hook" | "watch" | "try" | "practice" | "quick" | "done";
export const STAGES: { id: StageId; label: string }[] = [
  { id: "hook", label: "Hook" },
  { id: "watch", label: "Watch" },
  { id: "try", label: "Try" },
  { id: "practice", label: "Practice" },
  { id: "quick", label: "Quick check" },
  { id: "done", label: "Done" },
];

export const WRONG_NOTE_COLOR = "#ef4444";

/**
 * Every sub-lesson uses one shared practice track and clip in the project (the project can only hold 16 tracks, and the
 * course has about 40 sub-lessons). Starting a stage resets that clip to the stage's length and starting notes.
 */
export const WORKSPACE = { id: "practice", title: "Practice" } as const;

const starters = (specs?: GuideNoteSpec[]): StarterNote[] => (specs ?? []).map(({ pitch, startTick, durationTicks }) => ({ pitch, startTick, durationTicks }));

export const tryStep = (sub: SubLesson): ExerciseStep => ({
  kind: "exercise",
  id: "try",
  title: "Try it",
  goal: sub.tryIt.instruction,
  exercise: { instrument: "synth", bars: sub.bars, starterNotes: starters(sub.tryIt.starter), check: sub.tryIt.check, hints: [] },
});

/** The three hint levels, in the order they are revealed. */
export const HINT_LABELS = ["Reminder", "Show me the rows", "Show me the answer"] as const;

/** Level 2 only says "rows" when there are rows to highlight. */
export const hintLabel = (sub: SubLesson, index: number): string => (index === 1 && sub.practice.hints.rows.length === 0 ? "More help" : (HINT_LABELS[index] ?? ""));

export const practiceStep = (sub: SubLesson): ExerciseStep => ({
  kind: "exercise",
  id: "practice",
  title: "Practice",
  goal: sub.practice.task,
  exercise: {
    instrument: "synth",
    bars: sub.bars,
    starterNotes: starters(sub.practice.starter),
    check: sub.practice.check,
    hints: sub.practice.hints.texts ?? [sub.practice.hints.reminder, "The highlighted rows are where the right notes live.", "The answer is shown as ghost notes. Place your notes on top of them."],
  },
});

/** Guide-note specs as piano-roll guide notes. `ghost` draws dashed outlines to follow; otherwise solid demo notes. */
export function toGuideNotes(specs: GuideNoteSpec[], ghost: boolean): GuideNote[] {
  return specs.map((n) => ({
    pitch: n.pitch,
    startTick: n.startTick,
    durationTicks: n.durationTicks,
    style: ghost ? (n.root ? "ghost-root" : "ghost") : n.root ? "root" : "demo",
    ...(n.label ? { label: n.label } : {}),
  }));
}

/** Real notes whose pitch class is outside `allowed` get the wrong-note colour straight away. Muted notes are ignored. */
export function wrongNoteColors(clip: Clip, allowed: string[]): Record<string, string> {
  const ok = new Set(allowed.map((n) => pitchClassOf(n)));
  const out: Record<string, string> = {};
  for (const n of Object.values(clip.notes)) if (!n.muted && !ok.has(pitchClass(n.pitch))) out[n.id] = WRONG_NOTE_COLOR;
  return out;
}

/** What the roll shows for hint level 0-3: level 2 adds highlighted rows, level 3 adds the answer as ghost notes. */
export function hintGuide(sub: SubLesson, level: number): { rows?: number[]; notes?: GuideNote[] } {
  return {
    ...(level >= 2 ? { rows: sub.practice.hints.rows } : {}),
    ...(level >= 3 ? { notes: toGuideNotes(sub.practice.hints.answer, true) } : {}),
  };
}

/** Events a watch step sounds: the listed pitches, or all of its notes. */
export function watchEvents(step: WatchStep, tempo: number): PreviewEvent[] {
  const sounding = step.play ? step.notes.filter((n) => step.play!.includes(n.pitch)) : step.notes;
  return notesToEvents(sounding, tempo);
}

/** Seconds to stay on a watch step: long enough to hear the chord and read the caption. */
export const watchStepMs = (step: WatchStep) => Math.max(3000, step.caption.length * 55);

/** Text read aloud for a stage (voice guidance). */
export function stageSpeech(sub: SubLesson, stage: StageId, watchIndex = 0): string {
  switch (stage) {
    case "hook":
      return [sub.hook.headline, ...sub.hook.text].join(". ");
    case "watch":
      return sub.watch.steps[watchIndex]?.caption ?? "";
    case "try":
      return sub.tryIt.instruction;
    case "practice":
      return sub.practice.task;
    case "quick":
      return sub.quickCheck.question;
    case "done":
      return `Well done. ${sub.recap.join(" ")}`;
  }
}

// ---- Where notes go: time targets for the beat/bar guide ----

/** A span of time the learner must fill, for highlighting on the roll and in the beat counter. */
export interface TimeTarget {
  startTick: number;
  durationTicks: number;
  /** Short label for the ruler, e.g. "2 beats" or "chord". */
  label: string;
  /** True when the length is part of the task (so it is drawn as a length, not just a position). */
  hasLength: boolean;
}

const BEAT_TICKS = 960;
const BAR_TICKS = 3840;

/** "1 beat", "2 beats", "½ beat", "1½ beats". */
export function beatsLabel(ticks: number): string {
  const b = Math.round((ticks / BEAT_TICKS) * 2) / 2;
  const whole = Math.floor(b);
  const half = b - whole === 0.5;
  const text = `${whole ? whole : ""}${half ? "½" : ""}` || "0";
  return `${text} beat${b === 1 || b === 0.5 ? "" : "s"}`;
}

/**
 * Where (and for how long) the notes of an exercise go, read from its own check, so the roll can highlight the right
 * bars and beats and the beat counter can show what a length looks like. Checks that leave timing free give none.
 */
export function timeTargets(spec: SubLesson["practice"]["check"], bars: number): TimeTarget[] {
  const out: TimeTarget[] = [];
  const add = (t: TimeTarget) => {
    const same = out.find((o) => o.startTick === t.startTick);
    if (!same) out.push(t);
    else if (t.durationTicks > same.durationTicks) Object.assign(same, t);
  };
  const perBar = (n: number, label: string, beatTick = 0) => {
    for (let bar = 0; bar < n; bar++) add({ startTick: bar * BAR_TICKS + beatTick, durationTicks: BEAT_TICKS, label, hasLength: false });
  };
  switch (spec.kind) {
    case "slots":
      for (const s of spec.slots) {
        if (s.startMin === undefined || s.startMax === undefined) continue;
        const start = Math.round((s.startMin + s.startMax) / 2);
        const hasLength = s.durationMin !== undefined && s.durationMax !== undefined;
        const duration = hasLength ? Math.round((s.durationMin! + s.durationMax!) / 2) : (s.durationMin ?? BEAT_TICKS);
        add({ startTick: start, durationTicks: duration, label: hasLength || s.durationMin !== undefined ? beatsLabel(duration) : "note", hasLength: hasLength || s.durationMin !== undefined });
      }
      break;
    case "chordsPerBar":
      perBar(spec.chords.length, "chord");
      break;
    case "rootNotes":
      perBar(spec.chords.length, "root");
      break;
    case "chordSet":
      perBar(spec.bars, "chord");
      break;
    case "chordsAtTicks":
      for (const c of spec.chords) add({ startTick: c.startTick, durationTicks: BEAT_TICKS, label: "chord", hasLength: false });
      break;
    case "chordToneMelody":
      for (let bar = 0; bar < spec.rule.chords.length; bar++) for (const b of spec.rule.strongBeats) add({ startTick: bar * BAR_TICKS + b, durationTicks: BEAT_TICKS, label: "chord tone", hasLength: false });
      break;
    case "matchTarget":
      for (const t of spec.target) add({ startTick: t.startTick, durationTicks: t.durationTicks, label: beatsLabel(t.durationTicks), hasLength: true });
      break;
    case "all":
      for (const c of spec.checks) for (const t of timeTargets(c, bars)) add(t);
      break;
    default:
      break;
  }
  return out.filter((t) => t.startTick >= 0 && t.startTick < bars * BAR_TICKS).sort((a, b) => a.startTick - b.startTick);
}
