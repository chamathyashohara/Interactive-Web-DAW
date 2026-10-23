/**
 * Kick Drums lessons teach the DAW's sounds and arrangement with the same six stages as the Piano sub-lessons (Hook,
 * Watch, Try, Practice, Quick check, Done). The practical work happens inside the lesson, in a workspace with the sound
 * browser and an arrangement of the lesson's own tracks. Ids follow docs/lessons/CURRICULUM.md ("M12.2"), which is also
 * what the DAW's progress and unlock registry use.
 */

/** A sound in the library, as the checks need it. */
export interface SoundInfo {
  category: string;
  /** Finer label: "Closed Hat", "Riser", "Impact", "Drum Loop"... */
  sub: string;
}

export interface StudioCtx {
  /** Category of a library sound (undefined when it is not in this computer's library). */
  soundOf: (sampleId: string) => SoundInfo | undefined;
  /** Library ids of the sounds the learner has listened to (in this stage). */
  auditioned: string[];
}

/** Which sound a task asks for: a category, optionally a finer sub-category. */
export interface SoundWant {
  category: string;
  sub?: string;
  label: string;
}

export type Role = "drums" | "bass" | "chords" | "other";

export type StudioCheck =
  | { kind: "auditioned"; sounds: SoundWant[] }
  /** Any sound dropped on the arrangement. */
  | { kind: "anySample" }
  /** A sample track of each wanted sound with a clip starting inside the bars (1-based, inclusive). */
  | { kind: "sampleClips"; sounds: SoundWant[]; bars: [number, number] }
  /** A clip of the sound starting exactly on this beat of a bar (beat 2-4). */
  | { kind: "onBeat"; sound: SoundWant; beat: number }
  | { kind: "loops"; min: number }
  | { kind: "tempo"; bpm: number }
  | { kind: "fitTempo"; bpm: number }
  /** These roles make no sound from [bar, beat] up to (not including) [bar, beat]. */
  | { kind: "silent"; roles: Role[]; from: [number, number]; to: [number, number] }
  /** Drums and bass silent in these bars, the chords still play. */
  | { kind: "breakdown"; bars: [number, number] }
  /** A riser clip playing somewhere in these bars. */
  | { kind: "riser"; bars: [number, number] }
  /** A snare roll in these bars (more hits each bar, getting louder) with a riser playing under it. */
  | { kind: "buildup"; bars: [number, number] }
  /** Nothing sounds in the last beat before this bar, and the build-up is still there. */
  | { kind: "pause"; dropBar: number }
  | { kind: "impact"; bar: number }
  /** An impact, the kick and the bass all start on this bar. */
  | { kind: "drop"; bar: number }
  /** The final exercise: breakdown, build-up and drop together. */
  | { kind: "fullSection"; breakdown: [number, number]; buildup: [number, number]; dropBar: number }
  // ---- step sequencer (Drum sequencer course): pads count from 1, sixteen per bar ----
  /** Kicks on exactly these pads (`exact`), or at least on these (`has`). */
  | { kind: "kickPads"; exact?: number[]; has?: number[]; pitch?: number }
  /** At least `min` kicks, at least one of them off the beat pads (1, 5, 9, 13). */
  | { kind: "offBeat"; min: number }
  /** The kick on pad 1 is an accent (127) and at least one other kick is softer. */
  | { kind: "accent" }
  /** Snares on these pads, and no kick on them. */
  | { kind: "snareRoom"; pads: number[] }
  /** Every bar of the clip has kicks, and the last bar differs from the first. */
  | { kind: "bars"; bars: number; lastDiffers?: boolean }
  /** The song has a loop region at least this many bars long. */
  | { kind: "loopRegion"; minBars: number }
  /** Kick velocities rise from the first to the last by at least `rise`. */
  | { kind: "kickRamp"; rise: number };

/** The example song a stage starts from (lesson tracks only; the learner's own tracks are never touched). */
export type SongSetup = "full" | "buildup" | "pause" | "drop" | "final";
/**
 * What a Try or Practice stage starts from, the first time it opens: "clear" removes the lesson's tracks (a fresh
 * arrangement), "loop" is a fresh arrangement with one drum loop made at 90 BPM, the others are the example song.
 */
export type Setup = "clear" | "loop" | SongSetup | SeqSetup;

/** A drum track for the step sequencer: `bars` long, with these hits already on it (pads count from 1 across bars). */
export interface SeqSetup {
  seq: { bars: number; hits?: { pitch: number; pad: number; velocity?: number }[] };
}

/** A place in the arrangement shown as a dashed target (where to drop, what to edit). */
export interface Target {
  bar: number;
  /** Start beat (1-4); default 1. */
  beat?: number;
  /** Length in beats; default one bar. */
  beats?: number;
  label: string;
}

export interface Labels {
  sections: { bars: string; energy: number; answer: string }[];
  options: string[];
}

export interface Exercise {
  instruction: string;
  setup?: Setup;
  /** Read from the project. Absent when the exercise is a labelling task (`labels`). */
  check?: StudioCheck;
  labels?: Labels;
  /** Dashed targets on the arrangement (Try always shows them; Practice from hint 3). */
  targets?: Target[];
  /** The exercise edits notes: the notes editor opens for the selected clip. */
  editNotes?: boolean;
  /** Things the project cannot show (Click, TAP): the learner ticks each one when done. */
  confirm?: string[];
}

/** Drum hits shown and played in a demonstration (pads count from 1, sixteen per bar). */
export interface PadDemo {
  pitch: number;
  pads: number[];
  velocity?: number;
}

export interface WatchStep {
  caption: string;
  /** Play this sound and light its category in the browser. */
  sound?: SoundWant;
  /** Light these bars of the arrangement (and play them when the example song is there). */
  bars?: [number, number];
  /** Light these pads on the step sequencer demo and play them. */
  pads?: PadDemo[];
  targets?: Target[];
}

export interface QuickCheck {
  question: string;
  options: string[];
  correct: number;
  explanation: string;
}

export interface StudioLesson {
  /** Curriculum id, e.g. "M12.2" (also the id for progress and unlocks). */
  id: string;
  moduleId: string;
  title: string;
  /** One line under the title. */
  summary: string;
  hook: { headline: string; text: string; sounds?: SoundWant[]; pattern?: PadDemo[] };
  /** Where the practical work happens: the sound browser and arrangement (default) or the drum step sequencer. */
  space?: "arrangement" | "sequencer";
  /** `setup` prepares the arrangement the Watch captions talk about (the example song, a loop). */
  watch: { setup?: Setup; steps: WatchStep[] };
  tryIt: Exercise;
  practice: Exercise & { hints: [string, string, string] };
  quick: QuickCheck;
  recap: string[];
}

export interface StudioModule {
  id: string;
  /** What the learner sees ("K1"). */
  code: string;
  title: string;
  lessons: StudioLesson[];
}
