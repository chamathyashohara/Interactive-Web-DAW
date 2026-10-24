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
  /** Pitch-class names, root first, e.g. ["G", "B", "D"]. Octave and order do not matter (unless `bass` is set). */
  notes: string[];
  /** When set, the lowest sounding note must be this pitch class (an inversion, for example). */
  bass?: string;
}

/** A chord expected at a given moment, in ticks from the clip start. */
export interface ChordAt extends ChordTarget {
  startTick: number;
  /** How far after `startTick` a note may start and still count (default half a beat). */
  window?: number;
}

/**
 * One note a learner must place. Every field narrows what counts; a note matches when it satisfies all that are set.
 * Times are ticks from the clip start.
 */
export interface Slot {
  /** Shown as a checklist line and in feedback, e.g. "C4 on beat 1". */
  label: string;
  pitchClasses?: string[];
  pitchMin?: number;
  pitchMax?: number;
  startMin?: number;
  startMax?: number;
  durationMin?: number;
  durationMax?: number;
}

/** A melody-over-chords rule: on each strong beat the melody note must be a tone of that bar's chord. */
export interface ChordToneRule {
  chords: ChordTarget[];
  /** Notes below this pitch are the accompaniment and are ignored. */
  melodyMinPitch: number;
  /** Ticks within the bar that must carry a chord tone, e.g. [0, 1920] for beats 1 and 3. */
  strongBeats: number[];
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
  | { kind: "melodyInKey"; key: string; scale: "major"; minNotes: number; endOn?: string; monophonic: boolean; minPitch?: number }
  | { kind: "drumPattern"; voices: DrumVoice[]; tolerance: number }
  | { kind: "matchTarget"; target: StarterNote[]; tolerance: { start: number; duration: number }; velocityRange: [number, number] }
  | { kind: "rootNotes"; chords: RootChord[] }
  | { kind: "chordsAtTicks"; chords: ChordAt[] }
  | { kind: "slots"; slots: Slot[]; /** "fail": notes that fill no slot are mistakes. */ extra: "fail" | "allow" }
  | { kind: "tempo"; bpm: number }
  | { kind: "inSet"; /** Name of the set, e.g. "C pentatonic". */ label: string; allowed: string[]; minNotes: number; mustUse?: string[]; endOn?: string; monophonic: boolean; minPitch?: number }
  | { kind: "chordSet"; bars: number; allowed: ChordTarget[]; first?: string; last?: string; noAdjacentRepeat?: boolean }
  | { kind: "chordToneMelody"; rule: ChordToneRule }
  | { kind: "repeatBars"; from: number; to: number; minNotes: number; /** Bar that must repeat the rhythm of `compareTo` but change at least one pitch. */ variation?: { bar: number; compareTo: number } }
  | { kind: "all"; checks: CheckSpec[] };

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
  /** A model solution: it must pass the Practice check. */
  answer: GuideNoteSpec[];
  /** Optional wording of the three levels, when the generic wording does not fit (for example no rows to highlight). */
  texts?: [string, string, string];
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
    /** Notes already in the clip when Try starts (for example a note to move). */
    starter?: GuideNoteSpec[];
    /** Ghost notes to follow: the finished state (so it must pass `check`). */
    ghost: GuideNoteSpec[];
    /** Placed notes whose pitch class is not in this list turn red at once. */
    allowedPitchClasses: string[];
    check: CheckSpec;
    tools: Tool[];
    /** Show the select-all / copy / paste / duplicate / quantize / delete strip (once those are taught). */
    commands?: boolean;
  };
  practice: {
    task: string;
    /** What to do in each bar, listed beside the roll. */
    items: string[];
    /** Notes already in the clip when Practice starts (something to fix or build on). */
    starter?: GuideNoteSpec[];
    check: CheckSpec;
    tools: Tool[];
    commands?: boolean;
    hints: HintPlan;
  };
  quickCheck: QuickCheckQuestion;
  recap: string[];
}
