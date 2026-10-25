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
  /** Peaks measured while the song played (mixing lessons), linear. */
  peaks?: { tracks: Record<string, number>; master: number; samples: number };
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
  | { kind: "kickRamp"; rise: number }
  /** Exact pads for each drum row (step sequencer). */
  | { kind: "pattern"; rows: { pitch: number; pads: number[]; name: string; exact?: boolean }[] }
  // ---- Make a Song (songChecks.ts); bars count from 1, inclusive ----
  | { kind: "tempoLoop"; bpm: number }
  /** The progression repeated: three-note chords on every bar of [from, to], in a comfortable range. */
  | { kind: "repeated"; bars: [number, number] }
  /** A second instrument plays the same chords in these bars. */
  | { kind: "layered"; bars: [number, number] }
  /** No kick in `quiet`, a kick in every bar of `loud`; piano and pads all through. */
  | { kind: "intro"; quiet: [number, number]; loud: [number, number] }
  /** A transition: a build-up sweep ending on `bar` ("into"), a down filter starting on it ("after"), both ("pair") or either. */
  | { kind: "transition"; bar: number; type: "into" | "after" | "either" | "pair" }
  /** One bass note per bar, the chord's root, in the bass range. */
  | { kind: "bassRoots"; bars: [number, number] }
  /** Rhythmic bass: at least `min` root notes per bar. */
  | { kind: "bassChopped"; bars: [number, number]; min: number }
  /** An arpeggio: one chord note at a time, at least four per bar, all from the bar's chord. */
  | { kind: "arp"; bars: [number, number] }
  /** At most `max` elements and no kick in these bars. */
  | { kind: "stripBack"; bars: [number, number]; max: number }
  /** A low-pass filter curve at `hz` (within 20 %) on `bar`. */
  | { kind: "filterAt"; bar: number; hz: number }
  /** A filter curve that opens from about 1000 Hz on `from` to fully open on `to`, never closing on the way. */
  | { kind: "filterRise"; from: number; to: number; kickBack?: [number, number]; transitionAt?: number }
  /** The note on beat 1 of `bar` (melody) is a tone of that bar's chord. */
  | { kind: "downbeatTone"; bar: number }
  /** Melody clips from `from` in 4-bar blocks follow the pattern ("AA", "ABAC"...). */
  | { kind: "melodyPattern"; from: number; pattern: string }
  /** Every element plays in every 8-bar block of these bars. */
  | { kind: "dropFull"; bars: [number, number]; elements: string[] }
  /** Elements drop out every 4 bars while the filter closes. */
  | { kind: "outro"; bars: [number, number]; needFilter?: boolean }
  /** Every element on its own track, named after it. */
  | { kind: "ownChannels"; namesToo: boolean }
  /** Measured while playing: the kick peaks between `kick` dB, the others between `others` dB. */
  | { kind: "gainStage"; kick: [number, number]; others: [number, number] }
  /** Hats and arp panned apart; kick and bass in the centre. */
  | { kind: "pan" }
  /** Measured while playing: the master peaks between these dB (and the master fader is untouched, when given). */
  | { kind: "headroom"; range: [number, number]; masterVolume?: number }
  /** The song's chords (Am F C G) on the piano, one per bar, in these bars. */
  | { kind: "progression"; bars: [number, number] }
  /** The melody in the 4 bars from `from` is exactly phrase A (or B, C). */
  | { kind: "phrase"; from: number; letter: "A" | "B" | "C" }
  /** An element has notes in every bar of these bars. */
  | { kind: "hasNotes"; element: string; bars: [number, number] }
  /** The learner's song has every part from the Special tasks. */
  | { kind: "parts" }
  /** The song is at least this many bars long. */
  | { kind: "songBars"; bars: number }
  /** The capstone checklist on the learner's own song. */
  | { kind: "capstone" };

/** The example song a stage starts from (lesson tracks only; the learner's own tracks are never touched). */
export type SongSetup = "full" | "buildup" | "pause" | "drop" | "final";
/**
 * What a Try or Practice stage starts from, the first time it opens: "clear" removes the lesson's tracks (a fresh
 * arrangement), "loop" is a fresh arrangement with one drum loop made at 90 BPM, the others are the example song.
 */
export type Setup = "clear" | "loop" | SongSetup | SeqSetup | SongSpec;

/** "The song so far" for a Make a Song lesson (songParts.ts): which parts play in which bars ([from, to] inclusive, in 4-bar clips). */
export interface SongSpec {
  song: {
    bars: number;
    parts: Partial<Record<"piano" | "pads" | "kick" | "hats" | "clap" | "bass" | "arp" | "melody", [number, number][]>>;
    /** Bass as copied chords (5.1), long roots (5.2) or chopped eighths (default). */
    bass?: "chords" | "long" | "chopped";
    /** Melody clips in this pattern of phrases, repeated ("A", "ABAC"); "unsettled" for Lesson 8.2. */
    melodyPattern?: string;
    melody?: "unsettled";
    /** Kick, hats and clap on one shared "Drums" track (10.1). */
    sharedDrums?: boolean;
    /** Synth tracks named "Synth 1", "Synth 2"... (10.1). */
    genericNames?: boolean;
    /** Every track's level (10.2, 10.5 start too loud). */
    volume?: number;
    masterVolume?: number;
    /** Tracks with one empty 4-bar clip on bar 1, ready to be drawn in (Special tasks). */
    empty?: ("piano" | "pads" | "kick" | "hats" | "clap" | "bass" | "arp" | "melody")[];
    /** Parts that only play along for reference: never applied to the Studio. */
    reference?: Partial<Record<"piano" | "pads" | "kick" | "hats" | "clap" | "bass" | "arp" | "melody", [number, number][]>>;
  };
}

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
  /** `notes` makes a section playable (a short example to listen to before labelling it). */
  sections: { bars: string; energy: number; answer: string; notes?: { pitch: number; beat: number; beats: number }[] }[];
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
  /** Extra tools in the workspace for this exercise. */
  tools?: Tool[];
  /** "song": check the learner's own song (their tracks in the Studio) instead of the lesson's workspace (capstone). */
  scope?: "song";
}

/** Workspace tools a Make a Song exercise switches on (lessonTools.ts and the workspace panels). */
export type Tool = "addTrack" | "loop" | "octave" | "chop" | "arp" | "copyToTrack" | "automation" | "mixer" | "rename" | "separateDrums" | "export" | "songLength" | "useMix";

/** Notes drawn faintly in the notes editor to copy (Special tasks): on `element`'s clip that starts on `bar`. */
export interface Ghost {
  element: string;
  bar: number;
  notes: { pitch: number; startTick: number; durationTicks: number }[];
}

/** One guided step of a Special task. */
export interface SpecialStep {
  title: string;
  instruction: string;
  /** All of them must pass. */
  check: StudioCheck | StudioCheck[];
  hints: string[];
  targets?: Target[];
  ghosts?: Ghost[];
  tools?: Tool[];
  editNotes?: boolean;
  confirm?: string[];
}

/**
 * A Special task: at the end of a course, one part of the course song (Am - F - C - G, 124 BPM) built step by step and
 * then applied to the Studio. The last one ("Build the whole song") works on the learner's own song instead.
 */
export interface SpecialTask {
  id: string;
  title: string;
  summary: string;
  /** What this part of the song is and what the learner will make. */
  brief: string[];
  space: "arrangement" | "sequencer";
  /** The lesson workspace starts from this; absent for the whole-song task, which works on the learner's song. */
  setup?: Setup;
  scope?: "song";
  steps: SpecialStep[];
  /** What Apply does: copy the parts to the Studio named after them, or save the mix for the whole song. */
  apply: { kind: "parts"; label: string } | { kind: "mix"; label: string } | null;
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
  /** What the learner sees instead of the id ("0.1" in Make a Song). */
  code?: string;
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
  /**
   * The module's list in order when it also points to lessons that live in another course (a Piano sub-lesson, a
   * Drum sequencer lesson): those open where they are, with one progress. Default: `lessons`.
   */
  items?: { id: string; title: string }[];
}
