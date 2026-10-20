import type { SubLesson } from "../types";
import { ALL_PITCH_CLASSES, g, quick, rows, run, slotAt } from "./helpers";

/**
 * L1 (internal m0), sub-lesson 2: beats, bars and note lengths, taught before any other lesson asks the learner to put
 * a note "on beat 3 of bar 2" or to make it "2 beats long". Every exercise position is also highlighted in green on the
 * roll and drawn in the "Where your notes go" counter. Readable copy for review: docs/lessons/CONTENT.md.
 */

const COUNT = ["1", "2", "3", "4"];

export const m0BeatsBars: SubLesson = {
  id: "m0-beats-bars",
  version: 1,
  moduleId: "m0",
  title: "Beats and bars",
  summary: "Count the music: beats are steady steps of time, and four beats make a bar.",
  concept: "rhythm",
  bars: 2,
  hook: {
    headline: "Feel the beat",
    text: [
      "Music has a steady pulse, like a heartbeat or footsteps. Each step of that pulse is called a beat.",
      "Beats come in groups of four, called bars. Press Play example and count along: 1, 2, 3, 4, then 1, 2, 3, 4 again.",
    ],
    notes: run(["C4", "C4", "C4", "C4", "C4", "C4", "C4", "C4"], 1, 1, 1, [...COUNT, ...COUNT]),
  },
  watch: {
    steps: [
      { caption: "This is one beat: a short, steady step of time. On the piano roll, one beat is the space between two thin lines.", notes: [g("C4", 1, 1, 1, { label: "1" })] },
      { caption: "Four beats in a row make one bar. Count them: 1, 2, 3, 4. The small numbers along the top count the beats too.", notes: run(["C4", "C4", "C4", "C4"], 1, 1, 1, COUNT) },
      { caption: "Then a new bar starts and you count from 1 again. The big numbers along the top are the bar numbers: bar 1, bar 2.", notes: run(["C4", "C4", "C4", "C4", "C4", "C4", "C4", "C4"], 1, 1, 1, [...COUNT, ...COUNT]) },
      { caption: "A note can last longer than one beat. This note starts on beat 1 and lasts 2 beats: it covers two beats' space.", notes: [g("C4", 1, 1, 2, { label: "2 beats" })] },
      { caption: "A note that fills a whole bar lasts 4 beats. Long or short, you count how many beats it covers.", notes: [g("C4", 1, 1, 4, { label: "4 beats" })] },
    ],
  },
  tryIt: {
    instruction: "Place a note on beat 3 of bar 1 that lasts 1 beat. The green column shows exactly where beat 3 is. Click at the start of the green column and drag right until the note fills it.",
    tips: ["Count the beats in bar 1: 1, 2, 3. The third beat is green.", "Any pitch is fine: only the timing matters here.", "Made a mistake? Press Ctrl+Z to undo."],
    ghost: [g("C4", 1, 3, 1, { label: "1 beat" })],
    allowedPitchClasses: ALL_PITCH_CLASSES,
    check: { kind: "slots", extra: "fail", slots: [slotAt("a 1-beat note on beat 3 of bar 1", 1, 3, { len: 1 })] },
    tools: ["draw"],
  },
  practice: {
    task: "Two notes, any pitch. In bar 1, a note that starts on beat 1 and lasts 2 beats. In bar 2, a note on beat 4 that lasts 1 beat. The green columns show where.",
    items: ["Bar 1, beat 1: 2 beats long", "Bar 2, beat 4: 1 beat long"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [slotAt("a 2-beat note on beat 1 of bar 1", 1, 1, { len: 2 }), slotAt("a 1-beat note on beat 4 of bar 2", 2, 4, { len: 1 })],
    },
    tools: ["draw"],
    hints: {
      reminder: "Count from the start of each bar: 1, 2, 3, 4. Drag each note to the right until it covers the right number of beats.",
      rows: rows("C4", "E4"),
      answer: [g("C4", 1, 1, 2), g("E4", 2, 4, 1)],
      texts: [
        "Count from the start of each bar: 1, 2, 3, 4. Drag each note to the right until it covers the right number of beats.",
        "The green columns are the beats to fill. The highlighted rows are only a suggestion: any pitch is fine.",
        "The answer is shown as ghost notes. Place yours on top of them.",
      ],
    },
  },
  quickCheck: quick("How many beats are in one bar in these lessons?", ["4", "2", "8", "1"], 0, "Each bar has four beats: count 1, 2, 3, 4, then start again at 1 in the next bar."),
  recap: [
    "A beat is one steady step of time; count them 1, 2, 3, 4.",
    "Four beats make a bar, and the bars are numbered along the top.",
    "A note's length is how many beats it covers: 1 beat, 2 beats, a whole bar (4 beats).",
  ],
};
