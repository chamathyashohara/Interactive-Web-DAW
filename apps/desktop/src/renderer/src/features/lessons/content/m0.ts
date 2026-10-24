import { pitchLabel } from "../../../pianoRoll/geometry";
import type { GuideNoteSpec, Slot, SubLesson } from "../types";
import { BAR, BEAT, g, quick, rows, run, slotAt } from "./helpers";
import { m0BeatsBars } from "./m0-beats-bars";

/**
 * M0: Meet the piano roll (training first). Tools are introduced one at a time: each sub-lesson only offers the tools
 * taught so far. Readable copy for review: docs/lessons/CONTENT.md (keep both in sync).
 */

// ---------------------------------------------------------------------------------------------------------------------
export const m0WhatYouSee: SubLesson = {
  id: "m0-what-you-see",
  version: 1,
  moduleId: "m0",
  title: "What you see",
  summary: "Read the piano roll: pitch goes up the grid, time goes along it.",
  concept: "midi-editing",
  bars: 2,
  hook: {
    headline: "A map of music",
    text: ["The piano roll is a grid. Up and down is pitch: higher notes sit higher. Left to right is time.", "Each coloured bar is one note. Press Play example to hear three notes climbing the grid."],
    notes: run(["C4", "E4", "G4"], 1, 1, 1),
  },
  watch: {
    steps: [
      { caption: "The keyboard on the left names every row. A note placed higher up the grid sounds higher.", notes: [g("C4", 1, 1, 4)] },
      { caption: "Here is the note one octave higher. C5 sits higher on the grid, and it sounds higher.", notes: [g("C5", 1, 1, 4)] },
      { caption: "Time runs from left to right. The numbers along the top are bars, and each bar has four beats.", notes: run(["C4", "D4", "E4", "F4"], 1, 1, 1) },
      { caption: "The longer a note's bar, the longer it lasts. This one lasts two beats, the next two just one beat each.", notes: [g("C4", 1, 1, 2), g("E4", 1, 3, 1), g("G4", 1, 4, 1)] },
    ],
  },
  tryIt: {
    instruction: "Click an empty cell on the C4 row, at the very start of bar 1, to place a note. Follow the dashed ghost note.",
    tips: ["The row names are on the keyboard at the left. Middle C is C4.", "Made a mistake? Press Ctrl+Z to undo.", "Click a piano key on the left to hear it."],
    ghost: [g("C4", 1, 1, 1)],
    allowedPitchClasses: ["C"],
    check: { kind: "slots", extra: "fail", slots: [slotAt("a note on C4 at the start of bar 1", 1, 1, { exact: "C4" })] },
    tools: ["draw"],
  },
  practice: {
    task: "Place three notes that climb higher each beat, with no ghost notes to follow: C4 on beat 1, D4 on beat 2 and E4 on beat 3 of bar 1.",
    items: ["Beat 1: C4", "Beat 2: D4", "Beat 3: E4"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [slotAt("C4 on beat 1", 1, 1, { exact: "C4" }), slotAt("D4 on beat 2", 1, 2, { exact: "D4" }), slotAt("E4 on beat 3", 1, 3, { exact: "E4" })],
    },
    tools: ["draw"],
    hints: {
      reminder: "Higher rows are higher notes. Beats run left to right, and beat 1 is the very start of bar 1.",
      rows: rows("C4", "D4", "E4"),
      answer: run(["C4", "D4", "E4"], 1, 1, 1),
    },
  },
  quickCheck: quick("On the piano roll, what happens when you move a note UP the grid?", ["It sounds higher", "It gets louder", "It lasts longer", "It plays later"], 0, "Up and down is pitch. Higher on the grid means a higher sound; louder, longer and later are different things."),
  recap: ["Up and down is pitch: higher on the grid sounds higher.", "Left to right is time: bars along the top, four beats in each bar.", "A note's bar is as long as the note lasts."],
};

// ---------------------------------------------------------------------------------------------------------------------
const PATTERN = run(["C4", "E4", "G4", "E4"], 1, 1, 1);
export const m0PlayLoopTempo: SubLesson = {
  id: "m0-play-loop-tempo",
  version: 1,
  moduleId: "m0",
  title: "Play, loop, tempo",
  summary: "Start the music, hear it loop, and change its speed.",
  concept: "midi-editing",
  bars: 2,
  hook: {
    headline: "Press play, and it loops",
    text: ["Play starts the music from the beginning. At the end it loops: back to the start, again and again.", "Tempo is the speed, counted in beats per minute (BPM). Higher BPM means faster."],
    notes: PATTERN,
  },
  watch: {
    steps: [
      { caption: "Press the Play button to hear the music. A thin line, the playhead, moves from left to right.", notes: PATTERN },
      { caption: "When the playhead reaches the end of the song it jumps back to the start. That is looping.", notes: PATTERN },
      { caption: "Tempo sets the speed in beats per minute. At 60 BPM every beat lasts a whole second.", notes: PATTERN },
      { caption: "At 120 BPM every beat lasts half a second. Same notes, twice as fast. Tempo does not change pitch.", notes: PATTERN },
    ],
  },
  tryIt: {
    instruction: "A four-note pattern is already in the roll. Press Play to hear it loop, then set the Tempo box above the roll to 60 BPM (type 60 and press Enter), and press Play again.",
    tips: ["The Tempo box is next to the Play button.", "Space also starts and stops playback.", "If the engine is offline, use the Listen button instead."],
    starter: PATTERN,
    ghost: [],
    allowedPitchClasses: ["C", "E", "G"],
    check: { kind: "tempo", bpm: 60 },
    tools: ["draw"],
  },
  practice: {
    task: "Set the tempo to 140 BPM, then place a note on every beat of bar 1: four notes in a row, any pitch. Press Play and hear it loop at the new speed.",
    items: ["Tempo: 140 BPM", "A note on beats 1, 2, 3 and 4 of bar 1"],
    check: {
      kind: "all",
      checks: [
        { kind: "tempo", bpm: 140 },
        { kind: "slots", extra: "fail", slots: [1, 2, 3, 4].map((b) => slotAt(`a note on beat ${b}`, 1, b)) },
      ],
    },
    tools: ["draw"],
    hints: {
      reminder: "Two jobs: set the tempo in the Tempo box, and click a note on each of the four beats in bar 1.",
      rows: [],
      answer: run(["C4", "C4", "C4", "C4"], 1, 1, 1),
      texts: [
        "Two jobs: set the tempo in the Tempo box, and click a note on each of the four beats in bar 1.",
        "The Tempo box is next to the Play button above the piano roll. Type 140 and press Enter. The beats are the vertical lines at the start of each quarter of bar 1.",
        "The four notes are shown as ghost notes. Place yours on top of them and set the tempo to 140.",
      ],
    },
  },
  quickCheck: quick("What happens when playback reaches the end of the song?", ["It loops back to the start", "It speeds up", "It deletes the notes", "It stops for good"], 0, "The song loops: it jumps back to bar 1 and plays again until you press Stop."),
  recap: [
    "Play starts from the beginning; Space starts and stops it.",
    "At the end the music loops back to the start.",
    "Tempo is speed in BPM: higher is faster, and the pitch stays the same.",
    "The tempo you set stays in your project. Change it back in the Tempo box any time.",
  ],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m0DrawDelete: SubLesson = {
  id: "m0-draw-delete",
  version: 1,
  moduleId: "m0",
  title: "Draw and delete",
  summary: "Place notes with the Draw tool and remove them with the Delete tool.",
  concept: "midi-editing",
  bars: 2,
  hook: {
    headline: "Draw it, delete it",
    text: ["With the Draw tool, click a cell to place a note. Click and drag to make it longer.", "Made a mistake? The Delete tool (or a right-click on a note) removes it."],
    notes: run(["C4", "D4", "E4", "G4"], 1, 1, 1),
  },
  watch: {
    steps: [
      { caption: "Draw tool: click an empty cell and a note appears right there.", notes: [g("C4", 1, 1, 1)] },
      { caption: "Click and drag to the right before letting go to make a longer note.", notes: [g("C4", 1, 1, 2)] },
      { caption: "Add more notes the same way, wherever you like on the grid.", notes: [g("C4", 1, 1, 2), g("E4", 1, 3, 1), g("G4", 1, 4, 1)] },
      { caption: "Delete tool: click a note to remove it. The E4 is gone; the others stay.", notes: [g("C4", 1, 1, 2), g("G4", 1, 4, 1)] },
    ],
  },
  tryIt: {
    instruction: "Draw four notes on the C4 row, one on each beat of bar 1. Then use the Delete tool to remove the one on beat 3. The ghost notes show the finished result: beats 1, 2 and 4.",
    tips: ["Switch tools with the buttons above the roll, or the keys D (draw) and E (delete).", "Right-clicking a note also deletes it.", "Ctrl+Z undoes a slip."],
    ghost: [g("C4", 1, 1, 1), g("C4", 1, 2, 1), g("C4", 1, 4, 1)],
    allowedPitchClasses: ["C"],
    check: { kind: "slots", extra: "fail", slots: [slotAt("C4 on beat 1", 1, 1, { exact: "C4" }), slotAt("C4 on beat 2", 1, 2, { exact: "C4" }), slotAt("C4 on beat 4", 1, 4, { exact: "C4" })] },
    tools: ["draw", "delete"],
  },
  practice: {
    task: "Four G4 notes are already in bar 1. Delete the notes on beats 2 and 4, then draw a new E4 note at the start of bar 2.",
    items: ["Keep G4 on beats 1 and 3", "Delete G4 on beats 2 and 4", "Draw E4 on beat 1 of bar 2"],
    starter: run(["G4", "G4", "G4", "G4"], 1, 1, 1),
    check: { kind: "slots", extra: "fail", slots: [slotAt("G4 on beat 1", 1, 1, { exact: "G4" }), slotAt("G4 on beat 3", 1, 3, { exact: "G4" }), slotAt("E4 at the start of bar 2", 2, 1, { exact: "E4" })] },
    tools: ["draw", "delete"],
    hints: {
      reminder: "Delete tool: click the notes you do not want. Draw tool: click the empty cell where the new note goes.",
      rows: rows("G4", "E4"),
      answer: [g("G4", 1, 1, 1), g("G4", 1, 3, 1), g("E4", 2, 1, 1)],
    },
  },
  quickCheck: quick("Which tool removes a note?", ["The Delete tool", "The Draw tool", "The Tempo box", "The Play button"], 0, "The Delete tool (or a right-click on the note) removes a note; Draw places new ones."),
  recap: ["Draw tool: click to place a note, drag to make it longer.", "Delete tool (or right-click): remove a note.", "Ctrl+Z undoes your last edit if you slip."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m0MoveResize: SubLesson = {
  id: "m0-move-resize",
  version: 1,
  moduleId: "m0",
  title: "Move and resize",
  summary: "Drag notes to change when they play, how high they sound and how long they last.",
  concept: "midi-editing",
  bars: 2,
  hook: {
    headline: "Drag to move, pull the edge to resize",
    text: ["With the Select tool, drag a note: sideways changes when it plays, up or down changes its pitch.", "Drag a note's right edge to make it longer or shorter."],
    notes: [g("C4", 1, 1, 1), g("E4", 1, 3, 2)],
  },
  watch: {
    steps: [
      { caption: "Select tool: grab the note and drag it to the right. It plays later.", notes: [g("C4", 1, 3, 1)] },
      { caption: "Drag it up the grid and it becomes a higher note. Here it moved up to E4.", notes: [g("E4", 1, 3, 1)] },
      { caption: "Drag the right edge of the note to stretch it. Now it lasts two beats.", notes: [g("E4", 1, 3, 2)] },
      { caption: "Dragging its right edge back shortens it again. Moving and resizing never delete a note.", notes: [g("E4", 1, 3, 1)] },
    ],
  },
  tryIt: {
    instruction: "A C4 note sits on beat 1. With the Select tool, drag it to beat 3, up to E4, and stretch its right edge to make it two beats long. Follow the ghost note.",
    tips: ["Drag from the middle of the note to move it, from its right edge to resize it.", "Snap keeps notes on the grid lines, which makes beats easy to hit.", "Ctrl+Z undoes a slip."],
    starter: [g("C4", 1, 1, 1)],
    ghost: [g("E4", 1, 3, 2)],
    allowedPitchClasses: ["C", "E"],
    check: { kind: "slots", extra: "fail", slots: [slotAt("E4 on beat 3, two beats long", 1, 3, { exact: "E4", len: 2 })] },
    tools: ["draw", "select", "delete"],
  },
  practice: {
    task: "Three notes are in the roll but they are in the wrong places. Move and resize them so the melody is: C4 on beat 1 (one beat), E4 on beat 2 (one beat), G4 on beat 3 (two beats).",
    items: ["C4: beat 1, one beat long", "E4: beat 2, one beat long", "G4: beat 3, two beats long"],
    starter: [g("C4", 1, 1, 2), g("E4", 1, 3, 1), g("G4", 1, 4, 1)],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [slotAt("C4 on beat 1, one beat long", 1, 1, { exact: "C4", len: 1 }), slotAt("E4 on beat 2, one beat long", 1, 2, { exact: "E4", len: 1 }), slotAt("G4 on beat 3, two beats long", 1, 3, { exact: "G4", len: 2 })],
    },
    tools: ["draw", "select", "delete"],
    hints: {
      reminder: "Shorten the first note by dragging its right edge back, and move the other two notes sideways to their beats.",
      rows: rows("C4", "E4", "G4"),
      answer: [g("C4", 1, 1, 1), g("E4", 1, 2, 1), g("G4", 1, 3, 2)],
    },
  },
  quickCheck: quick("Which drag changes a note's pitch?", ["Dragging it up or down", "Dragging it sideways", "Dragging its right edge", "Double-clicking it"], 0, "Up and down is pitch. Sideways changes when the note plays, and the right edge changes how long it lasts."),
  recap: ["Select tool: drag a note sideways to change when it plays.", "Drag it up or down to change its pitch.", "Drag the right edge to change its length."],
};

// ---------------------------------------------------------------------------------------------------------------------
const CE = [g("C4", 1, 1, 1), g("E4", 1, 2, 1)];
export const m0SelectCopyUndo: SubLesson = {
  id: "m0-select-copy-undo",
  version: 1,
  moduleId: "m0",
  title: "Select, copy, undo",
  summary: "Work on many notes at once: select, duplicate, and undo mistakes.",
  concept: "midi-editing",
  bars: 2,
  hook: {
    headline: "Select, copy, undo",
    text: ["Drag a box around notes with the Select tool to select them all. Then Duplicate (Ctrl+D) copies them right after themselves.", "If anything goes wrong, Ctrl+Z undoes it and Ctrl+Y brings it back."],
    notes: [...CE, g("C4", 1, 3, 1), g("E4", 1, 4, 1)],
  },
  watch: {
    steps: [
      { caption: "Two notes to start with: C then E.", notes: CE },
      { caption: "Select tool: drag a box around both notes to select them together.", notes: CE },
      { caption: "Press Duplicate, or Ctrl+D. The copy appears straight after the selection.", notes: [...CE, g("C4", 1, 3, 1), g("E4", 1, 4, 1)] },
      { caption: "Duplicate again and the whole pattern doubles. Slipped up? Ctrl+Z steps back, Ctrl+Y steps forward.", notes: [...CE, g("C4", 1, 3, 1), g("E4", 1, 4, 1), g("C4", 2, 1, 1), g("E4", 2, 2, 1), g("C4", 2, 3, 1), g("E4", 2, 4, 1)] },
    ],
  },
  tryIt: {
    instruction: "Select both notes (drag a box around them) and press Duplicate, or Ctrl+D, to repeat the pair on beats 3 and 4. The ghost notes show the result.",
    tips: ["Select all is Ctrl+A. Copy and Paste are Ctrl+C and Ctrl+V.", "The buttons above the roll do the same as the shortcuts.", "Ctrl+Z undoes, Ctrl+Y redoes."],
    starter: CE,
    ghost: [...CE, g("C4", 1, 3, 1), g("E4", 1, 4, 1)],
    allowedPitchClasses: ["C", "E"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [slotAt("C4 on beat 1", 1, 1, { exact: "C4" }), slotAt("E4 on beat 2", 1, 2, { exact: "E4" }), slotAt("C4 on beat 3", 1, 3, { exact: "C4" }), slotAt("E4 on beat 4", 1, 4, { exact: "E4" })],
    },
    tools: ["draw", "select", "delete"],
    commands: true,
  },
  practice: {
    task: "A two-note pattern, G4 then E4, is in beats 1 and 2. Use Select and Duplicate to repeat it until it fills bars 1 and 2: eight notes in all (G4 E4 G4 E4 | G4 E4 G4 E4). If you copy too far, undo with Ctrl+Z.",
    items: ["Bar 1: G4 E4 G4 E4", "Bar 2: G4 E4 G4 E4"],
    starter: [g("G4", 1, 1, 1), g("E4", 1, 2, 1)],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [1, 2].flatMap((bar) => [1, 2, 3, 4].map((beat) => slotAt(`${beat % 2 ? "G4" : "E4"} on beat ${beat} of bar ${bar}`, bar, beat, { exact: beat % 2 ? "G4" : "E4" }))),
    },
    tools: ["draw", "select", "delete"],
    commands: true,
    hints: {
      reminder: "Select all (Ctrl+A) then Duplicate (Ctrl+D) doubles the pattern. Do it twice: 2 notes, then 4, then 8.",
      rows: rows("G4", "E4"),
      answer: [1, 2].flatMap((bar) => [1, 2, 3, 4].map((beat) => g(beat % 2 ? "G4" : "E4", bar, beat, 1))),
    },
  },
  quickCheck: quick("Which shortcut undoes your last edit?", ["Ctrl+Z", "Ctrl+D", "Ctrl+C", "Ctrl+A"], 0, "Ctrl+Z undoes. Ctrl+Y redoes. Ctrl+D duplicates, Ctrl+C copies and Ctrl+A selects everything."),
  recap: ["Drag a box with the Select tool to select several notes.", "Duplicate (Ctrl+D) or Copy and Paste repeats a pattern.", "Ctrl+Z undoes, Ctrl+Y redoes: you can always step back."],
};

// ---------------------------------------------------------------------------------------------------------------------
const LINE_ONE = [...run(["C4", "C4", "G4", "G4"], 1, 1, 1), ...run(["A4", "A4"], 2, 1, 1), g("G4", 2, 3, 2)];
const LINE_TWO = [...run(["F4", "F4", "E4", "E4"], 3, 1, 1), ...run(["D4", "D4"], 4, 1, 1), g("C4", 4, 3, 2)];
const slotsFor = (notes: GuideNoteSpec[]): Slot[] =>
  notes.map((n) => ({
    label: `${pitchLabel(n.pitch)} at bar ${Math.floor(n.startTick / BAR) + 1}, beat ${Math.floor((n.startTick % BAR) / BEAT) + 1}`,
    pitchMin: n.pitch,
    pitchMax: n.pitch,
    startMin: n.startTick - 120,
    startMax: n.startTick + 120,
  }));

export const m0MiniChallenge: SubLesson = {
  id: "m0-mini-challenge",
  version: 1,
  moduleId: "m0",
  title: "Mini challenge (Twinkle Twinkle)",
  summary: "Put every tool to work: write the first two lines of a famous tune.",
  concept: "midi-editing",
  bars: 4,
  hook: {
    headline: "Your first tune",
    text: ["You can draw, delete, move, resize, select and copy. Time to use them.", "Press Play example: you probably know this one. The first line is C C G G A A G."],
    notes: LINE_ONE,
  },
  watch: {
    steps: [
      { caption: "Line one starts with two Cs, then two Gs, one beat each. Notice the repeated pairs.", notes: LINE_ONE.slice(0, 4) },
      { caption: "Then two As, and a long G that lasts two beats to finish the line.", notes: LINE_ONE },
      { caption: "Line two goes F F E E, then D D, and a long C: the tune comes back home.", notes: [...LINE_ONE, ...LINE_TWO] },
      { caption: "Repeated pairs are a shortcut: draw one note, then copy it. That is where Duplicate helps.", notes: [...LINE_ONE, ...LINE_TWO] },
    ],
  },
  tryIt: {
    instruction: "Write line one in bars 1 and 2: C C G G, then A A and a long G. Follow the dashed ghost notes. Remember Duplicate for repeated notes.",
    tips: ["Each note is one beat long, except the last G, which lasts two beats.", "Resize with the right edge; move with Select.", "Ctrl+Z undoes a slip."],
    ghost: LINE_ONE,
    allowedPitchClasses: ["C", "G", "A"],
    check: { kind: "slots", extra: "fail", slots: slotsFor(LINE_ONE) },
    tools: ["draw", "select", "delete"],
    commands: true,
  },
  practice: {
    task: "Line one is already written. Write line two yourself in bars 3 and 4, with no ghost notes: F F E E, then D D, then a C that lasts two beats.",
    items: ["Bar 3: F4 F4 E4 E4", "Bar 4: D4 D4 C4 (two beats)"],
    starter: LINE_ONE,
    check: { kind: "slots", extra: "fail", slots: slotsFor([...LINE_ONE, ...LINE_TWO]) },
    tools: ["draw", "select", "delete"],
    commands: true,
    hints: {
      reminder: "Line two copies the shape of line one, lower down: pairs of notes, then a long one. The notes are F F E E, D D, C.",
      rows: rows("F4", "E4", "D4", "C4"),
      answer: [...LINE_ONE, ...LINE_TWO],
    },
  },
  quickCheck: quick("You drew a note by mistake. What is the fastest fix?", ["Press Ctrl+Z", "Delete the whole clip", "Restart the program", "Change the tempo"], 0, "Ctrl+Z undoes your last edit, so a slip costs one keypress."),
  recap: ["You can draw, delete, move, resize, select, duplicate and undo.", "Repeated ideas are quick to build with Duplicate.", "Twinkle Twinkle: C C G G A A G, F F E E D D C."],
};

export const M0: SubLesson[] = [m0WhatYouSee, m0BeatsBars, m0PlayLoopTempo, m0DrawDelete, m0MoveResize, m0SelectCopyUndo, m0MiniChallenge];
