import type { InstrumentKind } from "@daw/shared";
import type { Tool } from "../../pianoRoll/PianoRoll";

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

/** One drum part of a pattern: the drum's MIDI pitch and where it hits inside ONE bar (repeated for every bar of the clip). */
export interface DrumVoice {
  pitch: number;
  /** Shown in feedback, e.g. "Kick". */
  label: string;
  onsets: number[];
}

export type CheckSpec =
  | { kind: "chordsPerBar"; chords: ChordTarget[] }
  | { kind: "melodyInKey"; key: string; scale: "major"; minNotes: number; endOn?: string; monophonic: boolean }
  | { kind: "drumPattern"; voices: DrumVoice[]; tolerance: number }
  | { kind: "matchTarget"; target: StarterNote[]; tolerance: { start: number; duration: number }; velocityRange: [number, number] }
  | { kind: "rootNotes"; chords: RootChord[] };

/** One bar of a "place the root" exercise: the chord's name, its root and its notes (to explain near-misses). */
export interface RootChord {
  name: string;
  root: string;
  notes: string[];
}

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
  | {
      kind: "explain";
      id: string;
      title: string;
      body: string[];
      /** Optional "try this" call-out shown under the text. */
      tryIt?: string;
      /** Optional short tips shown as a list. */
      tips?: string[];
    }
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
  /** What the learner should take away; shown on the Summary tab. */
  recap: string[];
}

export interface CheckResult {
  pass: boolean;
  /** 0..1, reported as "exercise accuracy". */
  score: number;
  /** The first concrete problem in plain words, or a success message. */
  feedback: string;
  items: { label: string; ok: boolean }[];
}

// ---- Sub-lessons: the 7-stage format (hook, watch, try, practice, feedback, quick check, done) ----

/** A note drawn by a guide (never part of the project). `root` marks the root note. */
export interface GuideNoteSpec {
  pitch: number;
  startTick: number;
  durationTicks: number;
  root?: boolean;
  label?: string;
}

export interface WatchStep {
  /** Shown (and optionally spoken) while this step plays. */
  caption: string;
  /** Everything visible on the roll during this step. */
  notes: GuideNoteSpec[];
  /** Pitches to sound when the step appears; defaults to all of `notes`. */
  play?: number[];
}

export interface QuickCheckQuestion {
  question: string;
  options: string[];
  correct: number;
  explanation: string;
}

/** The three hint levels: a reminder, then highlighted rows, then the answer as ghost notes. */
export interface HintPlan {
  reminder: string;
  rows: number[];
  answer: GuideNoteSpec[];
}

export interface SubLesson {
  /** Stable id used in logs and the completed event, e.g. "m3-root-note". */
  id: string;
  version: number;
  moduleId: string;
  title: string;
  summary: string;
  concept: Concept;
  /** Clip length in bars for Try and Practice. */
  bars: number;
  hook: { headline: string; text: string[]; notes: GuideNoteSpec[] };
  watch: { steps: WatchStep[] };
  tryIt: {
    instruction: string;
    tips: string[];
    /** Ghost notes to follow. */
    ghost: GuideNoteSpec[];
    /** Placed notes whose pitch class is not in this list turn red at once. */
    allowedPitchClasses: string[];
    check: CheckSpec;
    tools: Tool[];
  };
  practice: {
    task: string;
    /** What to do in each bar, listed beside the roll. */
    items: string[];
    check: CheckSpec;
    tools: Tool[];
    hints: HintPlan;
  };
  quickCheck: QuickCheckQuestion;
  recap: string[];
}
