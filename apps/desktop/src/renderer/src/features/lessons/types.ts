import type { InstrumentKind } from "@daw/shared";

/**
 * Lessons are plain data (no functions), so they could equally be JSON. Behaviour lives in the check kinds
 * (`checks/`), which a lesson names and parameterises through its `CheckSpec`.
 */

export type Concept = "chords" | "melody" | "rhythm" | "midi-editing";

/** A note placed in the exercise clip at start or reset. Times are ticks relative to the clip start. */
export interface StarterNote {
  pitch: number;
  startTick: number;
  durationTicks: number;
  /** Defaults to the piano roll's drawing velocity. */
  velocity?: number;
}

export interface ChordTarget {
  /** Shown to the learner, e.g. "G major". */
  name: string;
  /** Pitch-class names, e.g. ["G", "B", "D"]. Octave and order do not matter. */
  notes: string[];
}

export type CheckSpec = { kind: "chordsPerBar"; chords: ChordTarget[] };

export interface Exercise {
  instrument: InstrumentKind;
  /** Clip length in bars. */
  bars: number;
  starterNotes: StarterNote[];
  check: CheckSpec;
  /** Authored hints, revealed one at a time by the Hint button. */
  hints: string[];
}

export type Step =
  | { kind: "explain"; id: string; title: string; body: string[] }
  | { kind: "exercise"; id: string; title: string; goal: string; exercise: Exercise };

export interface Lesson {
  /** Stable id used in logs and the lesson-completed event. */
  id: string;
  /** Bumped whenever the content changes, so logged results stay interpretable. */
  version: number;
  title: string;
  concept: Concept;
  summary: string;
  steps: Step[];
}

export interface CheckResult {
  pass: boolean;
  /** 0..1, reported as "exercise accuracy". */
  score: number;
  /** The first concrete problem in plain words, or a success message. */
  feedback: string;
  items: { label: string; ok: boolean }[];
}
