import type { SubLesson } from "../types";
import { ALL_PITCH_CLASSES, g, quick, rows, run, slotAt } from "./helpers";

/**
 * M1: Notes. Everything from M0 is available (draw, select, delete, copy, undo). Readable copy for review:
 * docs/lessons/CONTENT.md (keep both in sync).
 */

const TOOLS = ["draw", "select", "delete"] as const;
const tools = [...TOOLS];

// ---------------------------------------------------------------------------------------------------------------------
export const m1HighLow: SubLesson = {
  id: "m1-high-low",
  version: 1,
  moduleId: "m1",
  title: "High and low",
  summary: "Every note has a pitch: how high or low it sounds.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "High and low",
    text: ["Every note has a pitch: how high or low it sounds. On the piano roll, higher rows are higher pitches.", "Press Play example: a low note, then a high one."],
    notes: [g("C3", 1, 1, 2), g("C5", 1, 3, 2)],
  },
  watch: {
    steps: [
      { caption: "A low note sits near the bottom of the grid. It sounds deep, like a bass guitar.", notes: [g("C3", 1, 1, 4)] },
      { caption: "A high note sits near the top. It sounds bright, like a whistle.", notes: [g("C5", 1, 1, 4)] },
      { caption: "A note in the middle sounds in between. Most melodies live around here.", notes: [g("C4", 1, 1, 4)] },
      { caption: "Step by step from low to high, the sound climbs: low, middle, high.", notes: run(["C3", "C4", "C5"], 1, 1, 1) },
    ],
  },
  tryIt: {
    instruction: "Place one low note (C3 or lower) on beat 1 and one high note (C5 or higher) on beat 3. The ghost notes show one way to do it.",
    tips: ["Scroll the piano roll up and down to reach high and low rows.", "Zoom V makes the rows taller.", "Click a key on the left to hear how high it is."],
    ghost: [g("C3", 1, 1, 1), g("C5", 1, 3, 1)],
    allowedPitchClasses: ALL_PITCH_CLASSES,
    check: { kind: "slots", extra: "fail", slots: [slotAt("a low note (C3 or lower) on beat 1", 1, 1, { max: "C3" }), slotAt("a high note (C5 or higher) on beat 3", 1, 3, { min: "C5" })] },
    tools,
    commands: true,
  },
  practice: {
    task: "Put a note in each zone, one per beat of bar 1: beat 1 low (C3 or lower), beat 2 middle (C4 to B4), beat 3 high (C5 or higher), beat 4 low again.",
    items: ["Beat 1: low", "Beat 2: middle", "Beat 3: high", "Beat 4: low"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [
        slotAt("beat 1: a low note (C3 or lower)", 1, 1, { max: "C3" }),
        slotAt("beat 2: a middle note (C4 to B4)", 1, 2, { min: "C4", max: "B4" }),
        slotAt("beat 3: a high note (C5 or higher)", 1, 3, { min: "C5" }),
        slotAt("beat 4: a low note (C3 or lower)", 1, 4, { max: "C3" }),
      ],
    },
    tools,
    commands: true,
    hints: {
      reminder: "Low notes are near the bottom of the grid, high notes near the top. C3, C4 and C5 are named on the keyboard.",
      rows: rows("C3", "E4", "C5", "G2"),
      answer: [g("C3", 1, 1, 1), g("E4", 1, 2, 1), g("C5", 1, 3, 1), g("G2", 1, 4, 1)],
    },
  },
  quickCheck: quick("Which of these notes is the highest?", ["C3", "C5", "C4", "C2"], 1, "The bigger the number, the higher the note: C5 is above C4, which is above C3 and C2."),
  recap: ["Pitch is how high or low a note sounds.", "Higher rows on the piano roll are higher pitches.", "The number in a note's name grows as you go up: C3, C4, C5."],
};

// ---------------------------------------------------------------------------------------------------------------------
const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
export const m1NoteNames: SubLesson = {
  id: "m1-note-names",
  version: 1,
  moduleId: "m1",
  title: "Note names A–G",
  summary: "Seven letters name all the white keys, over and over.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "Seven letters",
    text: ["Notes are named with just seven letters: A B C D E F G. After G, the letters start again at A.", "Press Play example: the white keys from C up to the next C."],
    notes: run(["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"], 1, 1, 0.5, [...LETTERS, "C"]),
  },
  watch: {
    steps: [
      { caption: "The white keys are named with letters. Starting from C they go C, D, E, F, G, A, B.", notes: run(["C4", "D4", "E4", "F4", "G4", "A4", "B4"], 1, 1, 0.5, LETTERS) },
      { caption: "After B the letters start again: the next white key is C, just higher up.", notes: [g("B4", 1, 1, 1, { label: "B" }), g("C5", 1, 2, 1, { label: "C" })] },
      { caption: "On a keyboard, C is the white key just to the left of each pair of black keys.", notes: [g("C4", 1, 1, 2, { label: "C" })] },
      { caption: "The number after the letter says which group the note is in. C4 is middle C; C5 is the next C up.", notes: [g("C4", 1, 1, 1, { label: "C4" }), g("C5", 1, 2, 1, { label: "C5" })] },
    ],
  },
  tryIt: {
    instruction: "Spell the white keys upward from middle C: C4, D4, E4 and F4 on beats 1 to 4 of bar 1, then G4 at the start of bar 2. Follow the ghost notes.",
    tips: ["The keyboard at the left names every row.", "Only white keys are needed.", "Ctrl+Z undoes a slip."],
    ghost: run(["C4", "D4", "E4", "F4", "G4"], 1, 1, 1),
    allowedPitchClasses: ["C", "D", "E", "F", "G"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: ["C4", "D4", "E4", "F4", "G4"].map((name, i) => slotAt(`${name} on ${i < 4 ? `beat ${i + 1}` : "bar 2, beat 1"}`, 1, i + 1, { exact: name })),
    },
    tools,
    commands: true,
  },
  practice: {
    task: "Place the notes named by these letters, one per beat of bar 1, in any octave: beat 1 A, beat 2 F, beat 3 D, beat 4 B.",
    items: ["Beat 1: A", "Beat 2: F", "Beat 3: D", "Beat 4: B"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: ["A", "F", "D", "B"].map((name, i) => slotAt(`${name} on beat ${i + 1}`, 1, i + 1, { names: [name] })),
    },
    tools,
    commands: true,
    hints: {
      reminder: "Count up the white keys from C: C D E F G A B. Any octave is fine.",
      rows: rows("A4", "F4", "D4", "B4"),
      answer: [g("A4", 1, 1, 1), g("F4", 1, 2, 1), g("D4", 1, 3, 1), g("B4", 1, 4, 1)],
    },
  },
  quickCheck: quick("Which letter comes straight after G in note names?", ["A", "H", "C", "F"], 0, "Note names only use A to G. After G they start again at A."),
  recap: ["Seven letters name the white keys: A B C D E F G, then again from A.", "C is the white key just left of each pair of black keys.", "The number says which octave: middle C is C4."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m1SharpsFlats: SubLesson = {
  id: "m1-sharps-flats",
  version: 1,
  moduleId: "m1",
  title: "Sharps and flats",
  summary: "The black keys: one key up is sharp, one key down is flat.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "The black keys",
    text: ["The black keys sit between the white ones. Each has two names: C# (C sharp) is the same key as D♭ (D flat).", "Sharp (#) means one key higher; flat (♭) means one key lower."],
    notes: run(["C4", "C#4", "D4"], 1, 1, 1),
  },
  watch: {
    steps: [
      { caption: "Sharp means one key higher. C# is the black key just above C.", notes: [g("C4", 1, 1, 1, { label: "C" }), g("C#4", 1, 2, 1, { label: "C#" })] },
      { caption: "Flat means one key lower. D♭ is the black key just below D: the very same key as C#.", notes: [g("D4", 1, 1, 1, { label: "D" }), g("C#4", 1, 2, 1, { label: "D♭" })] },
      { caption: "E and F have no black key between them. Neither do B and C.", notes: [g("E4", 1, 1, 1), g("F4", 1, 2, 1), g("B4", 1, 3, 1), g("C5", 1, 4, 1)] },
      { caption: "So there are five black keys in each octave: C#, D#, F#, G# and A#, also called D♭, E♭, G♭, A♭ and B♭.", notes: run(["C#4", "D#4", "F#4", "G#4", "A#4"], 1, 1, 0.5, ["C#", "D#", "F#", "G#", "A#"]) },
    ],
  },
  tryIt: {
    instruction: "Place C#4 on beat 1 and E♭4 on beat 3. Both are black keys. Follow the ghost notes.",
    tips: ["The piano roll names black keys with sharps: E♭ is the row labelled D#.", "Black-key rows are the darker ones.", "Click a key on the left to hear it."],
    ghost: [g("C#4", 1, 1, 1), g("Eb4", 1, 3, 1)],
    allowedPitchClasses: ["C#", "D#"],
    check: { kind: "slots", extra: "fail", slots: [slotAt("C#4 on beat 1", 1, 1, { exact: "C#4" }), slotAt("E♭4 (D#4) on beat 3", 1, 3, { exact: "Eb4" })] },
    tools,
    commands: true,
  },
  practice: {
    task: "Place these black keys, one per beat of bar 1, in any octave: beat 1 F#, beat 2 B♭, beat 3 G#, beat 4 D♭.",
    items: ["Beat 1: F#", "Beat 2: B♭ (= A#)", "Beat 3: G#", "Beat 4: D♭ (= C#)"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [slotAt("F# on beat 1", 1, 1, { names: ["F#"] }), slotAt("B♭ on beat 2", 1, 2, { names: ["Bb"] }), slotAt("G# on beat 3", 1, 3, { names: ["G#"] }), slotAt("D♭ on beat 4", 1, 4, { names: ["Db"] })],
    },
    tools,
    commands: true,
    hints: {
      reminder: "Sharp: one key above the letter. Flat: one key below it. The roll labels black keys with sharps, so B♭ is A# and D♭ is C#.",
      rows: rows("F#4", "Bb4", "G#4", "Db4"),
      answer: [g("F#4", 1, 1, 1), g("Bb4", 1, 2, 1), g("G#4", 1, 3, 1), g("Db4", 1, 4, 1)],
    },
  },
  quickCheck: quick("C# and D♭ are…", ["The same key", "Two different black keys", "Both white keys", "An octave apart"], 0, "C# is one key above C and D♭ is one key below D: that is the same black key, with two names."),
  recap: ["Sharp (#) means one key higher; flat (♭) means one key lower.", "Each black key has two names, such as C# and D♭.", "There is no black key between E and F, or between B and C."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m1Octaves: SubLesson = {
  id: "m1-octaves",
  version: 1,
  moduleId: "m1",
  title: "Octaves and middle C",
  summary: "Notes with the same name, higher or lower: octaves, and the C in the middle.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "Same name, higher up",
    text: ["An octave is the jump to the next note with the same name, like C4 up to C5.", "Notes an octave apart sound alike, one just higher. Middle C, in the centre of the piano, is C4."],
    notes: [g("C4", 1, 1, 2), g("C5", 1, 3, 2)],
  },
  watch: {
    steps: [
      { caption: "This is middle C, called C4. It sits in the middle of the piano keyboard.", notes: [g("C4", 1, 1, 2, { label: "C4" })] },
      { caption: "Count twelve rows up, every white and black key, and you reach C5: one octave higher.", notes: [g("C4", 1, 1, 1, { label: "C4" }), g("C5", 1, 2, 1, { label: "C5" })] },
      { caption: "Twelve rows down from C4 is C3, one octave lower. All three are called C.", notes: [g("C3", 1, 1, 1, { label: "C3" }), g("C4", 1, 2, 1, { label: "C4" }), g("C5", 1, 3, 1, { label: "C5" })] },
      { caption: "Every note works the same way: A3, A4 and A5 are octaves of A.", notes: run(["A3", "A4", "A5"], 1, 1, 1, ["A3", "A4", "A5"]) },
    ],
  },
  tryIt: {
    instruction: "Place middle C (C4) on beat 1, the C one octave higher on beat 2, and the C one octave lower on beat 3. Follow the ghost notes.",
    tips: ["C rows have a stronger line under them.", "An octave is 12 rows.", "Click the keys to hear how alike octaves sound."],
    ghost: run(["C4", "C5", "C3"], 1, 1, 1),
    allowedPitchClasses: ["C"],
    check: { kind: "slots", extra: "fail", slots: [slotAt("middle C (C4) on beat 1", 1, 1, { exact: "C4" }), slotAt("C5 on beat 2", 1, 2, { exact: "C5" }), slotAt("C3 on beat 3", 1, 3, { exact: "C3" })] },
    tools,
    commands: true,
  },
  practice: {
    task: "Place G4 on beat 1, the G one octave higher on beat 2, and the E one octave below E4 on beat 3.",
    items: ["Beat 1: G4", "Beat 2: G an octave above G4", "Beat 3: E an octave below E4"],
    check: { kind: "slots", extra: "fail", slots: [slotAt("G4 on beat 1", 1, 1, { exact: "G4" }), slotAt("G5 on beat 2", 1, 2, { exact: "G5" }), slotAt("E3 on beat 3", 1, 3, { exact: "E3" })] },
    tools,
    commands: true,
    hints: {
      reminder: "An octave up keeps the letter and adds one to the number: G4 up an octave is G5. Down an octave: E4 becomes E3.",
      rows: rows("G4", "G5", "E3"),
      answer: run(["G4", "G5", "E3"], 1, 1, 1),
    },
  },
  quickCheck: quick("How many rows (keys, white and black) up is one octave?", ["12", "7", "8", "2"], 0, "An octave is 12 keys up, counting white and black: C4 to C5 crosses 12 rows."),
  recap: ["An octave is 12 keys: the next note with the same name.", "Octaves sound alike, one higher or lower.", "Middle C is C4; C5 is an octave above, C3 an octave below."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m1Semitones: SubLesson = {
  id: "m1-semitones",
  version: 1,
  moduleId: "m1",
  title: "Semitones and whole tones",
  summary: "The two step sizes that build every scale.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "The smallest steps",
    text: ["A semitone is the smallest step: to the very next key, white or black. One row on the piano roll.", "A whole tone is two semitones: two rows."],
    notes: [g("C4", 1, 1, 1), g("C#4", 1, 2, 1), g("D4", 1, 3, 1)],
  },
  watch: {
    steps: [
      { caption: "From C to C# is one semitone: the very next row up.", notes: [g("C4", 1, 1, 1, { label: "C" }), g("C#4", 1, 2, 1, { label: "C#" })] },
      { caption: "From C to D is a whole tone: two semitones, two rows.", notes: [g("C4", 1, 1, 1, { label: "C" }), g("D4", 1, 2, 1, { label: "D" })] },
      { caption: "E to F is only a semitone, because there is no black key between them.", notes: [g("E4", 1, 1, 1, { label: "E" }), g("F4", 1, 2, 1, { label: "F" })] },
      { caption: "B to C is a semitone too. Every other step from one white key to the next is a whole tone.", notes: [g("B3", 1, 1, 1, { label: "B" }), g("C4", 1, 2, 1, { label: "C" })] },
    ],
  },
  tryIt: {
    instruction: "C4 is on beat 1. Place the note one semitone higher on beat 2, and the note one whole tone higher than C4 on beat 3. Follow the ghost notes.",
    tips: ["One semitone = one row. One whole tone = two rows.", "Black keys count as rows too.", "Ctrl+Z undoes a slip."],
    starter: [g("C4", 1, 1, 1)],
    ghost: [g("C4", 1, 1, 1), g("C#4", 1, 2, 1), g("D4", 1, 3, 1)],
    allowedPitchClasses: ["C", "C#", "D"],
    check: { kind: "slots", extra: "fail", slots: [slotAt("C4 on beat 1", 1, 1, { exact: "C4" }), slotAt("C#4 (a semitone up) on beat 2", 1, 2, { exact: "C#4" }), slotAt("D4 (a whole tone up) on beat 3", 1, 3, { exact: "D4" })] },
    tools,
    commands: true,
  },
  practice: {
    task: "E4 is on beat 1. Place: on beat 2 the note a semitone above E4, on beat 3 the note a whole tone above E4, and on beat 4 the note a semitone below E4.",
    items: ["Beat 2: a semitone above E4", "Beat 3: a whole tone above E4", "Beat 4: a semitone below E4"],
    starter: [g("E4", 1, 1, 1)],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [slotAt("E4 on beat 1", 1, 1, { exact: "E4" }), slotAt("a semitone above E4 on beat 2", 1, 2, { exact: "F4" }), slotAt("a whole tone above E4 on beat 3", 1, 3, { exact: "F#4" }), slotAt("a semitone below E4 on beat 4", 1, 4, { exact: "D#4" })],
    },
    tools,
    commands: true,
    hints: {
      reminder: "Count rows from E4: one row up is a semitone, two rows up a whole tone, one row down a semitone below. Watch out: E to F has no black key between.",
      rows: rows("F4", "F#4", "D#4"),
      answer: [g("E4", 1, 1, 1), g("F4", 1, 2, 1), g("F#4", 1, 3, 1), g("D#4", 1, 4, 1)],
    },
  },
  quickCheck: quick("How many semitones make one whole tone?", ["2", "1", "3", "12"], 0, "A whole tone is two semitones: two rows on the piano roll."),
  recap: ["A semitone is one key (one row) up or down.", "A whole tone is two semitones.", "E–F and B–C are semitones, because no black key sits between them."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m1NoteLengths: SubLesson = {
  id: "m1-note-lengths",
  version: 1,
  moduleId: "m1",
  title: "Note lengths and beats",
  summary: "Whole, half, quarter and eighth notes: how long each note lasts.",
  concept: "rhythm",
  bars: 2,
  hook: {
    headline: "How long does it last?",
    text: ["A whole note lasts four beats, a half note two, a quarter note one, and an eighth note half a beat.", "Press Play example: the same pitch, held for different lengths."],
    notes: [g("C4", 1, 1, 2), g("C4", 1, 3, 1), g("C4", 1, 4, 0.5), g("C4", 1, 4.5, 0.5)],
  },
  watch: {
    steps: [
      { caption: "A whole note fills a whole bar: four beats.", notes: [g("C4", 1, 1, 4, { label: "whole" })] },
      { caption: "Two half notes fit in a bar, two beats each.", notes: [g("C4", 1, 1, 2, { label: "half" }), g("C4", 1, 3, 2, { label: "half" })] },
      { caption: "Four quarter notes, one beat each: the steady pulse you count 1, 2, 3, 4.", notes: run(["C4", "C4", "C4", "C4"], 1, 1, 1, ["1", "2", "3", "4"]) },
      { caption: "Eighth notes last half a beat: two for every beat. Count 1 and 2 and 3 and 4 and.", notes: run(["C4", "C4", "C4", "C4", "C4", "C4", "C4", "C4"], 1, 1, 0.5) },
    ],
  },
  tryIt: {
    instruction: "On the C4 row, make bar 1: a half note (two beats) on beat 1, then two quarter notes on beats 3 and 4. Follow the ghost notes.",
    tips: ["Click and drag to draw a longer note, or drag the right edge after.", "With the grid at 1/8, each grid step is half a beat.", "Listen to check the lengths."],
    ghost: [g("C4", 1, 1, 2), g("C4", 1, 3, 1), g("C4", 1, 4, 1)],
    allowedPitchClasses: ["C"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [slotAt("a half note (2 beats) on beat 1", 1, 1, { exact: "C4", len: 2 }), slotAt("a quarter note on beat 3", 1, 3, { exact: "C4", len: 1 }), slotAt("a quarter note on beat 4", 1, 4, { exact: "C4", len: 1 })],
    },
    tools,
    commands: true,
  },
  practice: {
    task: "On the E4 row: bar 1 is one whole note. Bar 2 has four eighth notes across beats 1 and 2, then a half note on beat 3.",
    items: ["Bar 1: a whole note", "Bar 2, beats 1-2: four eighth notes", "Bar 2, beat 3: a half note"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [
        slotAt("a whole note in bar 1", 1, 1, { exact: "E4", len: 4 }),
        slotAt("an eighth note on bar 2, beat 1", 2, 1, { exact: "E4", len: 0.5 }),
        slotAt("an eighth note on the 'and' of beat 1", 2, 1.5, { exact: "E4", len: 0.5 }),
        slotAt("an eighth note on bar 2, beat 2", 2, 2, { exact: "E4", len: 0.5 }),
        slotAt("an eighth note on the 'and' of beat 2", 2, 2.5, { exact: "E4", len: 0.5 }),
        slotAt("a half note on bar 2, beat 3", 2, 3, { exact: "E4", len: 2 }),
      ],
    },
    tools,
    commands: true,
    hints: {
      reminder: "Whole = 4 beats, half = 2, quarter = 1, eighth = half a beat. Set the grid to 1/8 so each click is an eighth note.",
      rows: rows("E4"),
      answer: [g("E4", 1, 1, 4), ...run(["E4", "E4", "E4", "E4"], 2, 1, 0.5), g("E4", 2, 3, 2)],
    },
  },
  quickCheck: quick("How many quarter notes fit in one whole note?", ["4", "2", "8", "1"], 0, "A whole note lasts four beats and a quarter note one beat, so four quarter notes fill one whole note."),
  recap: ["Whole note: 4 beats. Half: 2. Quarter: 1. Eighth: half a beat.", "On the piano roll, a note's length is the length of its bar.", "Count eighth notes as 1 and 2 and 3 and 4 and."],
};

export const M1: SubLesson[] = [m1HighLow, m1NoteNames, m1SharpsFlats, m1Octaves, m1Semitones, m1NoteLengths];
