import type { Lesson } from "../types";

/** Lesson 4. Readable copy for review: docs/lessons/CONTENT.md (keep both in sync). */
export const midiEditing1: Lesson = {
  id: "midi-editing-1",
  version: 2,
  title: "MIDI editing",
  concept: "midi-editing",
  summary: "Clean up a played-in melody: fix timing, length, loudness and a doubled note.",
  steps: [
    {
      kind: "explain",
      id: "what-is-midi",
      title: "What is MIDI?",
      body: [
        "MIDI does not record sound. It records which notes you played: the pitch, when each one started, how long it lasted, and how hard you hit it (the velocity).",
        "Because it is just data, every note can be edited after you play it: moved, stretched, made louder or quieter, or deleted.",
      ],
      tryIt: "Look at the velocity lane under the piano roll: each note has a bar, and taller bars are louder notes.",
      tips: ["Undo (Ctrl+Z) reverses any edit.", "Select several notes by dragging a box around them with the Select tool."],
    },
    {
      kind: "explain",
      id: "common-fixes",
      title: "The four common fixes",
      body: [
        "Timing: notes played slightly early or late can be pulled onto the beat with Quantize. Choose the grid size first (1/4 snaps to beats), then press Quantize.",
        "Length: drag the right edge of a note to shorten or lengthen it.",
        "Loudness: the velocity lane under the notes shows one bar per note. Drag a bar to make that note louder or quieter.",
        "Clean-up: a note played twice sits exactly on top of itself. Select it and press Delete to remove the extra one.",
      ],
    },
    {
      kind: "exercise",
      id: "fix-recording",
      title: "Fix the recording",
      goal: "This 2-bar melody was played in by hand and has four mistakes: one note is off the beat, one is too long, one is too loud, and one is doubled. Fix all four.",
      exercise: {
        instrument: "synth",
        bars: 2,
        starterNotes: [
          { pitch: 60, startTick: 0, durationTicks: 960, velocity: 90 },
          { pitch: 64, startTick: 1060, durationTicks: 960, velocity: 90 }, // late: should start on beat 2
          { pitch: 67, startTick: 1920, durationTicks: 2880, velocity: 90 }, // too long: should be one beat
          { pitch: 64, startTick: 2880, durationTicks: 960, velocity: 90 },
          { pitch: 65, startTick: 3840, durationTicks: 960, velocity: 90 },
          { pitch: 69, startTick: 4800, durationTicks: 960, velocity: 127 }, // too loud
          { pitch: 67, startTick: 5760, durationTicks: 1920, velocity: 90 },
          { pitch: 67, startTick: 5760, durationTicks: 1920, velocity: 90 }, // doubled
        ],
        check: {
          kind: "matchTarget",
          tolerance: { start: 30, duration: 60 },
          velocityRange: [60, 110],
          target: [
            { pitch: 60, startTick: 0, durationTicks: 960 },
            { pitch: 64, startTick: 960, durationTicks: 960 },
            { pitch: 67, startTick: 1920, durationTicks: 960 },
            { pitch: 64, startTick: 2880, durationTicks: 960 },
            { pitch: 65, startTick: 3840, durationTicks: 960 },
            { pitch: 69, startTick: 4800, durationTicks: 960 },
            { pitch: 67, startTick: 5760, durationTicks: 1920 },
          ],
        },
        hints: [
          "Press Play and listen first: one note is late, one rings on too long, one jumps out as too loud, and one sounds thicker because it is played twice.",
          "Set the grid to 1/4, select the late note and press Quantize. Drag the right edge of the long note back to one beat.",
          "Drag the tallest bar in the velocity lane down to a moderate height. Where two notes sit exactly on top of each other, select one and press Delete.",
        ],
      },
    },
  ],
  recap: [
    "MIDI stores notes, not sound, so every note can be fixed after it is played.",
    "Quantize pulls notes onto the grid; dragging a note's edge changes its length.",
    "The velocity lane controls how loud each note is; Delete removes doubled notes.",
  ],
};
