import type { Clip } from "@daw/shared";
import type { GuideNote } from "../../pianoRoll/PianoRoll";
import { notesToEvents, type PreviewEvent } from "./audio";
import type { ExerciseStep } from "./useExercise";
import { pitchClass, pitchClassOf } from "./theory";
import type { GuideNoteSpec, SubLesson, WatchStep } from "./types";

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

export const tryStep = (sub: SubLesson): ExerciseStep => ({
  kind: "exercise",
  id: "try",
  title: "Try it",
  goal: sub.tryIt.instruction,
  exercise: { instrument: "synth", bars: sub.bars, starterNotes: [], check: sub.tryIt.check, hints: [] },
});

/** The three hint levels, in the order they are revealed. */
export const HINT_LABELS = ["Reminder", "Show me the rows", "Show me the answer"] as const;

export const practiceStep = (sub: SubLesson): ExerciseStep => ({
  kind: "exercise",
  id: "practice",
  title: "Practice",
  goal: sub.practice.task,
  exercise: {
    instrument: "synth",
    bars: sub.bars,
    starterNotes: [],
    check: sub.practice.check,
    hints: [sub.practice.hints.reminder, "The highlighted rows are where the right notes live.", "The answer is shown as ghost notes. Place your notes on top of them."],
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
