import type { GuideNoteSpec, SubLesson } from "../types";

const BAR = 3840;
const BEAT = 960;

/** A chord held for two beats at the start of a bar; the first note listed is the root and is marked. */
const chord = (bar: number, pitches: number[], rootLabel = "root"): GuideNoteSpec[] =>
  pitches.map((pitch, i) => ({ pitch, startTick: bar * BAR, durationTicks: 2 * BEAT, ...(i === 0 ? { root: true, label: rootLabel } : {}) }));

/** The root, in the middle of the piano roll, for one bar. */
const rootAt = (bar: number, pitch: number): GuideNoteSpec => ({ pitch, startTick: bar * BAR, durationTicks: 2 * BEAT, root: true, label: "root" });

/** M3, sub-lesson 2. Readable copy for review: docs/lessons/CONTENT.md (keep both in sync). */
export const m3RootNote: SubLesson = {
  id: "m3-root-note",
  version: 1,
  moduleId: "m3",
  title: "The root note",
  summary: "Every chord is named after one note: its root. Learn to find it.",
  concept: "chords",
  bars: 4,

  hook: {
    headline: "Every chord has a boss",
    text: [
      "It is called the root note, and it gives the chord its name.",
      "Press Play example. This is C major, and its root is C.",
    ],
    notes: chord(0, [60, 64, 67]),
  },

  watch: {
    steps: [
      { caption: "A chord is several notes played at the same time. This one is made of three notes.", notes: chord(0, [60, 64, 67]).map(({ pitch, startTick, durationTicks }) => ({ pitch, startTick, durationTicks })) },
      { caption: "One of them is the root. Here it is C: the chord is named after it, so this is C major.", notes: chord(0, [60, 64, 67]), play: [60, 64, 67] },
      { caption: "Change the root and you change the chord's name. With G as the root, we get G major.", notes: chord(0, [55, 59, 62]) },
      { caption: "Same idea again: F is the root, so this chord is F major.", notes: chord(0, [53, 57, 60]) },
      { caption: "Even for A minor, look at the first letter of the name: A. That is the root.", notes: chord(0, [57, 60, 64]) },
      { caption: "So to find a chord's root, read the first letter of its name. Now you try.", notes: [rootAt(0, 60)], play: [60] },
    ],
  },

  tryIt: {
    instruction: "Build C major on beat 1 of bar 1. Start with the root, C, then add E and G. Follow the dashed ghost notes. A red note does not belong in the chord.",
    tips: ["Click on the grid to place a note.", "To remove a note, use the Delete tool or right-click it.", "Click a piano key on the left to hear it."],
    ghost: [
      { pitch: 60, startTick: 0, durationTicks: 2 * BEAT, root: true, label: "root" },
      { pitch: 64, startTick: 0, durationTicks: 2 * BEAT },
      { pitch: 67, startTick: 0, durationTicks: 2 * BEAT },
    ],
    allowedPitchClasses: ["C", "E", "G"],
    check: { kind: "chordsPerBar", chords: [{ name: "C major", notes: ["C", "E", "G"] }] },
    tools: ["draw", "select", "delete"],
  },

  practice: {
    task: "Place just the root note of each chord: one note per bar, on beat 1. There are no ghost notes this time.",
    items: ["Bar 1: C major", "Bar 2: G major", "Bar 3: F major", "Bar 4: A minor"],
    check: {
      kind: "rootNotes",
      chords: [
        { name: "C major", root: "C", notes: ["C", "E", "G"] },
        { name: "G major", root: "G", notes: ["G", "B", "D"] },
        { name: "F major", root: "F", notes: ["F", "A", "C"] },
        { name: "A minor", root: "A", notes: ["A", "C", "E"] },
      ],
    },
    tools: ["draw", "select", "delete"],
    hints: {
      reminder: "The root is the note a chord is named after. Read the first letter of each chord's name.",
      rows: [60, 65, 67, 69],
      answer: [rootAt(0, 60), rootAt(1, 67), rootAt(2, 65), rootAt(3, 69)],
    },
  },

  quickCheck: {
    question: "A chord is called F minor. Which note is its root?",
    options: ["F", "A♭", "C", "E"],
    correct: 0,
    explanation: "The root is the first letter of the chord's name, so F minor has the root F. (A♭ and C are the other notes in the chord.)",
  },

  recap: [
    "The root is the note a chord is named after.",
    "Read the first letter of the chord's name to find it: G major → G, A minor → A.",
    "Change the root and you change the chord, even if the pattern of notes stays the same.",
  ],
};
