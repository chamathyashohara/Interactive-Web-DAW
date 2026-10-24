import type { Lesson } from "../types";

/** Lesson 3. Readable copy for review: docs/lessons/CONTENT.md (keep both in sync). */
export const rhythm1: Lesson = {
  id: "rhythm-1",
  version: 2,
  title: "Rhythm",
  concept: "rhythm",
  summary: "Program a basic drum beat: kick, snare and hi-hat in one bar.",
  steps: [
    {
      kind: "explain",
      id: "beats-and-bars",
      title: "Beats and bars",
      body: [
        "Music is organised in bars, and most pop and dance music has four beats in every bar. Count them out loud: 1, 2, 3, 4.",
        "Between the beats are the offbeats. Counting eighth notes, you say: 1 and 2 and 3 and 4 and.",
      ],
      tryIt: "Tap your foot on 1, 2, 3, 4 and clap on 2 and 4. That clap is where the snare goes.",
      tips: ["The numbers along the top of the piano roll are bars.", "The grid size (1/4, 1/8, 1/16) sets how finely notes snap."],
    },
    {
      kind: "explain",
      id: "basic-beat",
      title: "The basic beat",
      body: [
        "A drum beat layers three sounds. The kick (bass drum) gives the pulse, the snare gives the backbeat, and the closed hi-hat keeps time.",
        "The classic pattern: kick on every beat (1, 2, 3, 4), snare on beats 2 and 4, and closed hi-hat on every eighth note (1 and 2 and 3 and 4 and).",
        "Press Play: the clip loops, so you can hear whether it grooves.",
      ],
      tips: ["On a drum track each row is a drum, not a pitch.", "Drum hits can be short: only the start of the note matters."],
    },
    {
      kind: "exercise",
      id: "program-beat",
      title: "Program the beat",
      goal: "Fill the empty 1-bar drum clip: Kick on beats 1, 2, 3 and 4. Snare on beats 2 and 4. Closed Hat on all eight eighth notes.",
      exercise: {
        instrument: "drums",
        bars: 1,
        starterNotes: [],
        check: {
          kind: "drumPattern",
          tolerance: 60,
          voices: [
            { pitch: 36, label: "Kick", onsets: [0, 960, 1920, 2880] },
            { pitch: 38, label: "Snare", onsets: [960, 2880] },
            { pitch: 42, label: "Closed Hat", onsets: [0, 480, 960, 1440, 1920, 2400, 2880, 3360] },
          ],
        },
        hints: [
          "The rows on the left are named after the drums: find Kick, Snare and Closed Hat. Keep Snap on so notes land exactly on the grid.",
          "Set the grid size to 1/8 so each click lands on an eighth note. The kick needs only every second grid line.",
          "Kick: 1, 2, 3, 4. Snare: 2 and 4 only. Hat: every grid line, eight in the bar. Use the Paint tool to drop the hats quickly.",
        ],
      },
    },
  ],
  recap: [
    "Most pop music has four beats in a bar, with offbeats in between.",
    "Kick on every beat gives the pulse; snare on 2 and 4 gives the backbeat.",
    "Hi-hats on every eighth note keep the time steady.",
  ],
};
