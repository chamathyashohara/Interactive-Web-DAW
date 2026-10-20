import type { Lesson } from "../types";

const BAR = 3840;

/** Lesson 1. Readable copy for review: docs/lessons/CONTENT.md (keep both in sync). */
export const chords1: Lesson = {
  id: "chords-1",
  version: 2,
  title: "Chords",
  concept: "chords",
  summary: "Build the four chords of the most common pop progression: C – G – Am – F.",
  steps: [
    {
      kind: "explain",
      id: "what-is-a-chord",
      title: "What is a chord?",
      body: [
        "A chord is several notes played at the same time. The most common chord is a triad: three notes stacked a third apart.",
        "To build a triad on the piano roll, start on a note (the root), skip one white key and take the next, then skip one more and take the next. From C that gives C, E and G: a C major chord.",
        "The notes can be in any order or octave: E-G-C is still a C major chord (an inversion).",
      ],
      tryIt: "Find C, E and G on the keyboard at the left of the piano roll. They are three white keys with one white key between each.",
      tips: ["Higher notes are higher up in the piano roll.", "Notes that start at the same time sound together as a chord.", "Click a key on the keyboard to hear that note."],
    },
    {
      kind: "explain",
      id: "progression",
      title: "Chords in a key",
      body: [
        "Songs move between a few chords from the same key. In the key of C major, four chords appear in thousands of pop songs:",
        "C major (C-E-G), G major (G-B-D), A minor (A-C-E) and F major (F-A-C). Musicians call this progression I – V – vi – IV.",
        "Each chord usually lasts one bar. Press Play to hear how it moves away from C and comes back.",
      ],
      tips: ["Major chords sound bright, minor chords sound darker.", "Roman numerals (I, V, vi, IV) name a chord by its place in the key, so the same pattern works in any key."],
    },
    {
      kind: "exercise",
      id: "build-progression",
      title: "Build I – V – vi – IV",
      goal: "Bar 1 already has C major. Put G major in bar 2, A minor in bar 3 and F major in bar 4, each starting on beat 1.",
      exercise: {
        instrument: "synth",
        bars: 4,
        starterNotes: [
          { pitch: 60, startTick: 0, durationTicks: BAR },
          { pitch: 64, startTick: 0, durationTicks: BAR },
          { pitch: 67, startTick: 0, durationTicks: BAR },
        ],
        check: {
          kind: "chordsPerBar",
          chords: [
            { name: "C major", notes: ["C", "E", "G"] },
            { name: "G major", notes: ["G", "B", "D"] },
            { name: "A minor", notes: ["A", "C", "E"] },
            { name: "F major", notes: ["F", "A", "C"] },
          ],
        },
        hints: [
          "Look at bar 1: C, then skip a white key to E, then skip another to G. Build the other chords the same way from their own root.",
          "G major is G-B-D, A minor is A-C-E, F major is F-A-C. Use only white keys.",
          "Select the three notes in bar 1, copy and paste them, then drag the copy to bar 2 and move each note up or down to the new chord.",
        ],
      },
    },
  ],
  recap: [
    "A triad is three notes a third apart: root, third and fifth.",
    "Inversions and octaves don't change which chord it is.",
    "In C major, C – G – Am – F (I – V – vi – IV) is a progression used in countless songs.",
  ],
};
