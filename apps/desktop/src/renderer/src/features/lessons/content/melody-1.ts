import type { Lesson } from "../types";

/** Lesson 2. Readable copy for review: docs/lessons/CONTENT.md (keep both in sync). */
export const melody1: Lesson = {
  id: "melody-1",
  version: 2,
  title: "Melody",
  concept: "melody",
  summary: "Write a short tune that stays in the key of C major and ends on its home note.",
  steps: [
    {
      kind: "explain",
      id: "what-is-a-melody",
      title: "What is a melody?",
      body: [
        "A melody is the tune you could hum: a line of single notes, one after another, each with its own length.",
        "Melodies are built from a key: a small set of notes that sound good together. The key of C major uses just seven notes: C, D, E, F, G, A and B. On the piano roll these are the white keys.",
      ],
      tryIt: "Click a few white keys on the keyboard at the left, one after another, and listen to how they flow.",
      tips: ["The vertical axis shows pitch: higher notes are at the top.", "The horizontal axis shows time.", "Drag the right edge of a note to change its length."],
    },
    {
      kind: "explain",
      id: "home-note",
      title: "Steps, leaps and the home note",
      body: [
        "Most tunes move mostly by steps (to a neighbouring note) with an occasional leap (skipping a note or two). That is what makes a melody easy to sing.",
        "The first note of the key, here C, is the home note. Ending a melody on it makes the tune sound finished, like the end of a sentence.",
        "Notes from outside the key (the black keys, in C major) can sound wrong to a beginner's ear, so for now stay on the white keys.",
      ],
      tips: ["Repeat a short idea twice: repetition makes a tune memorable.", "Mix short and long notes to give the melody a rhythm."],
    },
    {
      kind: "exercise",
      id: "write-melody",
      title: "Write a melody in C major",
      goal: "Add notes to the 2-bar clip to make a melody of at least 8 notes. Use only white keys, play one note at a time, and end on a C.",
      exercise: {
        instrument: "synth",
        bars: 2,
        starterNotes: [{ pitch: 60, startTick: 0, durationTicks: 960 }],
        check: { kind: "melodyInKey", key: "C", scale: "major", minNotes: 8, endOn: "C", monophonic: true },
        hints: [
          "In C major you can use only the white keys: C, D, E, F, G, A and B. Stay off the black keys.",
          "Move mostly by small steps to neighbouring keys, and add a leap now and then so the tune has shape.",
          "Make each note end before the next one starts so only one note sounds at a time. Finish with a C in bar 2.",
        ],
      },
    },
  ],
  recap: [
    "A melody is a line of single notes, one at a time.",
    "The key of C major uses only the white keys: C, D, E, F, G, A, B.",
    "Moving by steps sounds smooth; ending on the home note (C) sounds finished.",
  ],
};
