import { MODULES } from "./curriculum";

/**
 * The main lessons on the Lessons page. Piano opens the L1-L6 learning path; Kick Drums and Drum sequencer their own courses. The
 * others are ready to be connected to their own lesson pages later; until then they open a clear "not available yet"
 * page that links to the related lessons that do exist.
 */

export type MainLessonId = "piano" | "kick" | "sequencer" | "mixing" | "daw";
export type Accent = "teal" | "purple" | "rose" | "blue" | "amber";

export interface RelatedLesson {
  kind: "sub" | "earlier";
  id: string;
  title: string;
  why: string;
}

export interface MainLesson {
  id: MainLessonId;
  title: string;
  description: string;
  topics: string[];
  accent: Accent;
  /** True when the lesson collection exists and can be opened. */
  available: boolean;
  /** Existing lessons on the same subject, offered while the collection is not available. */
  related: RelatedLesson[];
}

/** "Meet the piano roll (training first)" -> "Meet the piano roll": the Piano card lists the real L1-L6 titles. */
const pianoTopics = MODULES.map((m) => m.title.replace(/\s*\(.*\)\s*$/, ""));

export const MAIN_LESSONS: MainLesson[] = [
  {
    id: "piano",
    title: "Piano",
    description: "Learn the piano roll, notes, scales, chords, progressions and melody. Build your musical foundation step by step.",
    topics: pianoTopics,
    accent: "teal",
    available: true,
    related: [],
  },
  {
    id: "kick",
    title: "Kick Drums",
    description: "Find drum sounds, build beats, and use them to shape a song: breakdown, build-up and drop.",
    topics: ["Meet the sound browser", "Make a simple beat", "Snap, grid and loops", "Breakdown", "Build-up tension", "The drop"],
    accent: "purple",
    available: true,
    related: [],
  },
  {
    id: "sequencer",
    title: "Drum sequencer",
    description: "Program kick patterns on the step sequencer: pads, beats, accents, four-bar patterns, loops and ramps.",
    topics: ["Your first kick", "Four on the floor", "Kick on 1 and 3, off-beats", "Loud and soft kicks", "Four-bar patterns", "Loop and Ramp"],
    accent: "rose",
    available: true,
    related: [],
  },
  {
    id: "mixing",
    title: "Mixing",
    description: "Get your tracks sounding professional. Learn balance, EQ, compression and more.",
    topics: ["Gain staging", "EQ", "Compression", "Reverb and delay", "Automation", "Final mix"],
    accent: "blue",
    available: false,
    related: [],
  },
  {
    id: "daw",
    title: "DAW Features",
    description: "Master the tools and workflow of your DAW. Work faster, stay organised and be more creative.",
    topics: ["Navigation and workspace", "Recording", "Editing", "Plug-ins and instruments", "Automation", "Project management"],
    accent: "amber",
    available: false,
    related: [
      { kind: "sub", id: "m0-what-you-see", title: "L1 · Meet the piano roll", why: "Find your way around the piano roll and its tools." },
      { kind: "earlier", id: "midi-editing-1", title: "MIDI editing", why: "Fix timing, length and loudness of recorded notes." },
    ],
  },
];

export const mainLesson = (id: string) => MAIN_LESSONS.find((l) => l.id === id);
