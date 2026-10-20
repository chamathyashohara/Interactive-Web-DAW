import type { SubLesson } from "../types";
import { g, quick, rows, run, slotAt, slotsForRun } from "./helpers";

/**
 * M2: Scales and keys. Written for complete beginners: scales are built by counting rows (whole step = 2 rows,
 * half step = 1 row), white keys first. Readable copy for review: docs/lessons/CONTENT.md (keep both in sync).
 */

const tools = ["draw", "select", "delete"] as ("draw" | "select" | "delete")[];
const WHITE = ["C", "D", "E", "F", "G", "A", "B"];

const C_MAJOR = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"];
const MAJOR_STEPS = ["1st", "W", "W", "H", "W", "W", "W", "H"];
const MINOR_STEPS = ["1st", "W", "H", "W", "W", "H", "W", "W"];

// ---------------------------------------------------------------------------------------------------------------------
export const m2WhatIsAScale: SubLesson = {
  id: "m2-what-is-a-scale",
  version: 1,
  moduleId: "m2",
  title: "What a scale is",
  summary: "A scale is a ladder of notes, climbing in order from one note to its octave.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "A ladder of notes",
    text: ["A scale is a set of notes climbing in order, like the rungs of a ladder, from one note up to the same note an octave higher.", "Press Hear it: the C major scale, the white keys from C to C."],
    notes: run(C_MAJOR, 1, 1, 0.5),
  },
  watch: {
    steps: [
      { caption: "Start on C4. A scale climbs one note at a time from here.", notes: [g("C4", 1, 1, 1, { label: "C" })] },
      { caption: "Take the next white keys in order: C, D, E, F.", notes: run(["C4", "D4", "E4", "F4"], 1, 1, 0.5, ["C", "D", "E", "F"]) },
      { caption: "Keep going: G, A, B, and you arrive at C again, one octave higher.", notes: run(C_MAJOR, 1, 1, 0.5, [...WHITE, "C"]) },
      { caption: "Eight notes from C to C: the C major scale. A scale can also go back down the ladder.", notes: run([...C_MAJOR].reverse(), 1, 1, 0.5, ["C", "B", "A", "G", "F", "E", "D", "C"]) },
    ],
  },
  tryIt: {
    instruction: "Build the C major scale going up: the white keys from C4 to C5, one note per beat, across bars 1 and 2. Follow the ghost notes.",
    tips: ["Only white keys.", "Duplicate a note, then drag the copy up one key, to go faster.", "Press Listen to hear your ladder."],
    ghost: run(C_MAJOR, 1, 1, 1),
    allowedPitchClasses: WHITE,
    check: { kind: "slots", extra: "fail", slots: slotsForRun(C_MAJOR, 1, 1, 1) },
    tools,
    commands: true,
  },
  practice: {
    task: "Now go down the ladder with no ghost notes: start on C5 at bar 1, beat 1 and play the C major scale downward, one note per beat, ending on C4 at bar 2, beat 4.",
    items: ["Bar 1: C5 B4 A4 G4", "Bar 2: F4 E4 D4 C4"],
    check: { kind: "slots", extra: "fail", slots: slotsForRun([...C_MAJOR].reverse(), 1, 1, 1) },
    tools,
    commands: true,
    hints: {
      reminder: "Same white keys as before, in the opposite order: C, B, A, G, F, E, D, C.",
      rows: rows(...C_MAJOR),
      answer: run([...C_MAJOR].reverse(), 1, 1, 1),
    },
  },
  quickCheck: quick("What is a scale?", ["A set of notes in order, from one note up to its octave", "Three notes played together", "A very loud note", "The speed of the music"], 0, "A scale is a ladder of notes in order, such as C D E F G A B C. Notes played together make a chord."),
  recap: ["A scale is a set of notes in order, from one note to the same note an octave away.", "The C major scale is the white keys from C to C.", "A scale can go up or down."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m2MajorPattern: SubLesson = {
  id: "m2-major-pattern",
  version: 1,
  moduleId: "m2",
  title: "Major scale pattern",
  summary: "Whole, whole, half, whole, whole, whole, half: the recipe of every major scale.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "The secret pattern",
    text: ["Between the notes of a major scale, each step is either a whole step (2 rows) or a half step (1 row).", "The pattern is always: whole, whole, half, whole, whole, whole, half. Say it as W W H W W W H."],
    notes: run(C_MAJOR, 1, 1, 0.5),
  },
  watch: {
    steps: [
      { caption: "C to D is two rows: a whole step, W.", notes: [g("C4", 1, 1, 1, { label: "1st" }), g("D4", 1, 2, 1, { label: "W" })] },
      { caption: "D to E is whole too. But E to F is only one row: a half step, H.", notes: run(["C4", "D4", "E4", "F4"], 1, 1, 1, MAJOR_STEPS) },
      { caption: "F to G, G to A and A to B are whole steps. B to C is a half step.", notes: run(C_MAJOR, 1, 1, 1, MAJOR_STEPS) },
      { caption: "W W H W W W H. Any eight notes that follow this pattern make a major scale.", notes: run(C_MAJOR, 1, 1, 0.5, MAJOR_STEPS) },
    ],
  },
  tryIt: {
    instruction: "Build C major once more, counting each step as you go: C4, then W, W, H, W, W, W, H. The ghost notes show the step names.",
    tips: ["W (whole) = 2 rows up. H (half) = 1 row up.", "Black keys count as rows.", "In C major every step lands on a white key."],
    ghost: run(C_MAJOR, 1, 1, 1, MAJOR_STEPS),
    allowedPitchClasses: WHITE,
    check: { kind: "slots", extra: "fail", slots: slotsForRun(C_MAJOR, 1, 1, 1) },
    tools,
    commands: true,
  },
  practice: {
    task: "G4 is on beat 1. Use the pattern W W H W W W H to build a major scale up to G5, one note per beat. Count rows: W = 2 rows, H = 1 row.",
    items: ["Start: G4", "Then: W W H W W W H", "End: G5 at bar 2, beat 4"],
    starter: [g("G4", 1, 1, 1)],
    check: { kind: "slots", extra: "fail", slots: slotsForRun(["G4", "A4", "B4", "C5", "D5", "E5", "F#5", "G5"], 1, 1, 1) },
    tools,
    commands: true,
    hints: {
      reminder: "From G: +2 rows (A), +2 (B), +1 (C), +2 (D), +2 (E), +2 (F#), +1 (G). The seventh note is a black key.",
      rows: rows("A4", "B4", "C5", "D5", "E5", "F#5", "G5"),
      answer: run(["G4", "A4", "B4", "C5", "D5", "E5", "F#5", "G5"], 1, 1, 1),
    },
  },
  quickCheck: quick("What is the major scale pattern?", ["W W H W W W H", "W H W W H W W", "H H W W H H W", "W W W W W W W"], 0, "Whole, whole, half, whole, whole, whole, half. (W H W W H W W is the natural minor pattern.)"),
  recap: ["Whole step (W) = 2 rows; half step (H) = 1 row.", "Major scale pattern: W W H W W W H.", "In C major the half steps are E-F and B-C."],
};

// ---------------------------------------------------------------------------------------------------------------------
const D_MAJOR = ["D4", "E4", "F#4", "G4", "A4", "B4", "C#5", "D5"];
const F_MAJOR = ["F4", "G4", "A4", "Bb4", "C5", "D5", "E5", "F5"];

export const m2MajorAnyNote: SubLesson = {
  id: "m2-major-any-note",
  version: 1,
  moduleId: "m2",
  title: "Major scale from any note",
  summary: "Start the pattern on any note: black keys appear where the pattern needs them.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "Same pattern, any start",
    text: ["Start the W W H W W W H pattern on any note and you get that note's major scale.", "Starting on a note other than C, you will need some black keys. Press Hear it: D major."],
    notes: run(D_MAJOR, 1, 1, 0.5),
  },
  watch: {
    steps: [
      { caption: "Start on D and count the pattern: D, E, then two rows up from E is F#, a black key.", notes: run(["D4", "E4", "F#4"], 1, 1, 1, ["D", "W", "W"]) },
      { caption: "Continue: G (half), A, B, C# (whole, whole, whole), D (half). That is D major.", notes: run(D_MAJOR, 1, 1, 1, MAJOR_STEPS) },
      { caption: "Start on F: F, G, A, then only a half step to B♭. F major has one black key, B♭.", notes: run(F_MAJOR, 1, 1, 1, MAJOR_STEPS) },
      { caption: "Every major scale has the same shape, just starting higher or lower. That is why they all sound 'major'.", notes: run(D_MAJOR, 1, 1, 0.5) },
    ],
  },
  tryIt: {
    instruction: "Build D major from D4 to D5, one note per beat, with W W H W W W H. Follow the ghost notes; two of them are black keys.",
    tips: ["W = 2 rows, H = 1 row.", "D major's black keys are F# and C#.", "A red note is not in D major."],
    ghost: run(D_MAJOR, 1, 1, 1, MAJOR_STEPS),
    allowedPitchClasses: ["D", "E", "F#", "G", "A", "B", "C#"],
    check: { kind: "slots", extra: "fail", slots: slotsForRun(D_MAJOR, 1, 1, 1) },
    tools,
    commands: true,
  },
  practice: {
    task: "Build F major from F4 to F5 with no ghost notes: start on F4 and follow W W H W W W H, one note per beat. There is exactly one black key.",
    items: ["Start: F4", "Then: W W H W W W H", "End: F5 at bar 2, beat 4"],
    check: { kind: "slots", extra: "fail", slots: slotsForRun(F_MAJOR, 1, 1, 1) },
    tools,
    commands: true,
    hints: {
      reminder: "From F: +2 (G), +2 (A), +1 (B♭, a black key), +2 (C), +2 (D), +2 (E), +1 (F).",
      rows: rows(...F_MAJOR),
      answer: run(F_MAJOR, 1, 1, 1),
    },
  },
  quickCheck: quick("Which black key is in the F major scale?", ["B♭", "F#", "C#", "E♭"], 0, "F, G, A, then a half step up to B♭. F major's only black key is B♭."),
  recap: ["Start W W H W W W H on any note to build its major scale.", "Black keys appear wherever the pattern needs them.", "D major has F# and C#; F major has B♭."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m2Degrees: SubLesson = {
  id: "m2-degrees",
  version: 1,
  moduleId: "m2",
  title: "Degrees and the key",
  summary: "Number the notes of a scale 1 to 7. Degree 1 is home, and the key is named after it.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "Numbers for notes",
    text: ["Each note of a scale gets a number, called a degree: the first note is 1, the next is 2, and so on up to 7.", "Degree 1 is the home of the key. In C major, home is C."],
    notes: run(C_MAJOR, 1, 1, 0.5, ["1", "2", "3", "4", "5", "6", "7", "1"]),
  },
  watch: {
    steps: [
      { caption: "In C major, C is degree 1, D is 2, E is 3, and so on up to B, which is 7.", notes: run(C_MAJOR.slice(0, 7), 1, 1, 0.5, ["1", "2", "3", "4", "5", "6", "7"]) },
      { caption: "Degree 1 is home. Melodies often end there, because it sounds finished.", notes: [g("C4", 1, 1, 2, { label: "1" })] },
      { caption: "Degree 5 (G in C major) is the next strongest note. It pulls back towards home.", notes: [g("G4", 1, 1, 2, { label: "5" }), g("C4", 1, 3, 2, { label: "1" })] },
      { caption: "The key is named after degree 1. The notes of the C major scale are 'in the key of C major'.", notes: run(C_MAJOR, 1, 1, 0.5, ["1", "2", "3", "4", "5", "6", "7", "1"]) },
    ],
  },
  tryIt: {
    instruction: "In C major, place degree 1 on beat 1, degree 3 on beat 2 and degree 5 on beat 3: that is C4, E4 and G4. Follow the ghost notes.",
    tips: ["Count up the C major scale: C is 1, D is 2, E is 3, F is 4, G is 5.", "Degrees 1, 3 and 5 together make the C major chord.", "Press Listen."],
    ghost: [g("C4", 1, 1, 1, { label: "1" }), g("E4", 1, 2, 1, { label: "3" }), g("G4", 1, 3, 1, { label: "5" })],
    allowedPitchClasses: ["C", "E", "G"],
    check: { kind: "slots", extra: "fail", slots: [slotAt("degree 1 (C4) on beat 1", 1, 1, { exact: "C4" }), slotAt("degree 3 (E4) on beat 2", 1, 2, { exact: "E4" }), slotAt("degree 5 (G4) on beat 3", 1, 3, { exact: "G4" })] },
    tools,
    commands: true,
  },
  practice: {
    task: "Now the key of G major (G A B C D E F#). Place these degrees in any octave, one per beat of bar 1: degree 1, degree 4, degree 5, and degree 1 again at bar 2, beat 1.",
    items: ["Bar 1, beat 1: degree 1", "Beat 2: degree 4", "Beat 3: degree 5", "Bar 2, beat 1: degree 1"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [slotAt("degree 1 of G major on beat 1", 1, 1, { names: ["G"] }), slotAt("degree 4 of G major on beat 2", 1, 2, { names: ["C"] }), slotAt("degree 5 of G major on beat 3", 1, 3, { names: ["D"] }), slotAt("degree 1 again at bar 2, beat 1", 2, 1, { names: ["G"] })],
    },
    tools,
    commands: true,
    hints: {
      reminder: "Count along G major: 1 = G, 2 = A, 3 = B, 4 = C, 5 = D, 6 = E, 7 = F#.",
      rows: rows("G4", "C5", "D5"),
      answer: [g("G4", 1, 1, 1), g("C5", 1, 2, 1), g("D5", 1, 3, 1), g("G4", 2, 1, 1)],
    },
  },
  quickCheck: quick("In the key of C major, what is degree 5?", ["G", "F", "A", "E"], 0, "Count up from C: C 1, D 2, E 3, F 4, G 5."),
  recap: ["Degrees number the notes of a scale from 1 to 7.", "Degree 1 is home; the key is named after it.", "In G major, degree 1 is G, 4 is C and 5 is D."],
};

// ---------------------------------------------------------------------------------------------------------------------
const A_MINOR = ["A3", "B3", "C4", "D4", "E4", "F4", "G4", "A4"];
const E_MINOR = ["E4", "F#4", "G4", "A4", "B4", "C5", "D5", "E5"];

export const m2NaturalMinor: SubLesson = {
  id: "m2-natural-minor",
  version: 1,
  moduleId: "m2",
  title: "Natural minor",
  summary: "The darker scale: W H W W H W W. A minor uses only white keys.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "The minor scale",
    text: ["The natural minor scale sounds darker or sadder. Its pattern is W H W W H W W.", "A minor uses only the white keys, from A to A. Press Hear it."],
    notes: run(A_MINOR, 1, 1, 0.5),
  },
  watch: {
    steps: [
      { caption: "Start on A and play only white keys up to the next A: A, B, C, D, E, F, G, A.", notes: run(A_MINOR, 1, 1, 0.5, ["A", "B", "C", "D", "E", "F", "G", "A"]) },
      { caption: "The steps are W H W W H W W. The half steps land in different places than in major.", notes: run(A_MINOR, 1, 1, 1, MINOR_STEPS) },
      { caption: "A minor and C major use exactly the same notes. Starting on A instead of C changes the mood.", notes: run(C_MAJOR, 1, 1, 0.5, ["C", "D", "E", "F", "G", "A", "B", "C"]) },
      { caption: "Any note can start a minor scale. E minor: E, F#, G, A, B, C, D, E. One black key.", notes: run(E_MINOR, 1, 1, 1, MINOR_STEPS) },
    ],
  },
  tryIt: {
    instruction: "Build A natural minor from A3 to A4, one note per beat. Only white keys. Follow the ghost notes.",
    tips: ["Start on A3, below middle C.", "Pattern: W H W W H W W.", "A red note is not in A minor."],
    ghost: run(A_MINOR, 1, 1, 1, MINOR_STEPS),
    allowedPitchClasses: WHITE,
    check: { kind: "slots", extra: "fail", slots: slotsForRun(A_MINOR, 1, 1, 1) },
    tools,
    commands: true,
  },
  practice: {
    task: "Build E natural minor from E4 to E5 with no ghost notes, one note per beat, using W H W W H W W. It has exactly one black key.",
    items: ["Start: E4", "Then: W H W W H W W", "End: E5 at bar 2, beat 4"],
    check: { kind: "slots", extra: "fail", slots: slotsForRun(E_MINOR, 1, 1, 1) },
    tools,
    commands: true,
    hints: {
      reminder: "From E: +2 (F#), +1 (G), +2 (A), +2 (B), +1 (C), +2 (D), +2 (E).",
      rows: rows(...E_MINOR),
      answer: run(E_MINOR, 1, 1, 1),
    },
  },
  quickCheck: quick("Which scale uses exactly the same notes as C major?", ["A natural minor", "E natural minor", "D major", "F major"], 0, "A natural minor is the white keys from A to A: the same seven notes as C major, starting somewhere else."),
  recap: ["Natural minor pattern: W H W W H W W.", "It sounds darker than major.", "A minor uses the same notes as C major (all white keys)."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m2InKey: SubLesson = {
  id: "m2-in-key",
  version: 1,
  moduleId: "m2",
  title: "In key vs out of key",
  summary: "Notes from the scale fit; other notes stick out.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "Fitting in",
    text: ["Notes from the scale are 'in key'. Other notes are 'out of key': they stick out and can sound wrong.", "In C major, every white key is in key and every black key is out of key."],
    notes: run(["C4", "E4", "G4", "E4", "D4", "C4"], 1, 1, 0.5),
  },
  watch: {
    steps: [
      { caption: "This melody uses only notes of C major. It sounds settled.", notes: run(["C4", "E4", "G4", "E4", "D4", "C4"], 1, 1, 0.5) },
      { caption: "Now one note is F# instead of F. F# is not in C major, so it sticks out.", notes: [g("E4", 1, 1, 1), g("F#4", 1, 2, 1, { label: "out" }), g("G4", 1, 3, 1)] },
      { caption: "To fix an out-of-key note, move it one row up or down onto a note of the scale.", notes: [g("E4", 1, 1, 1), g("F4", 1, 2, 1, { label: "in" }), g("G4", 1, 3, 1)] },
      { caption: "Out-of-key notes are not forbidden, but while you are learning, staying in key keeps things sounding good.", notes: run(["C4", "D4", "E4", "F4", "G4"], 1, 1, 0.5) },
    ],
  },
  tryIt: {
    instruction: "Write a melody of at least 6 notes in C major, one note at a time: use only white keys. A note turns red the moment it is out of key. The ghost notes show one possible melody.",
    tips: ["Any order of white keys works.", "Make each note end before the next starts.", "Press Listen when you are done."],
    ghost: run(["C4", "D4", "E4", "G4", "E4", "C4"], 1, 1, 1),
    allowedPitchClasses: WHITE,
    check: { kind: "melodyInKey", key: "C", scale: "major", minNotes: 6, monophonic: true },
    tools,
    commands: true,
  },
  practice: {
    task: "This melody has two notes that are out of key in C major. Find them (Listen helps) and move each one a single row up or down so every note fits C major.",
    items: ["Find the 2 notes that are not in C major", "Move each one row up or down"],
    starter: run(["C4", "D4", "F#4", "G4", "A4", "C#5", "B4", "C5"], 1, 1, 1),
    check: { kind: "melodyInKey", key: "C", scale: "major", minNotes: 8, monophonic: true },
    tools,
    commands: true,
    hints: {
      reminder: "In C major only white keys are in key. Look for the notes on black-key rows and move each one row to the nearest white key.",
      rows: rows("F4", "C5"),
      answer: run(["C4", "D4", "F4", "G4", "A4", "C5", "B4", "C5"], 1, 1, 1),
    },
  },
  quickCheck: quick("In C major, which of these notes is out of key?", ["F#", "F", "G", "B"], 0, "C major uses only the white keys. F# is a black key, so it is out of key."),
  recap: ["Notes of the scale are in key; other notes are out of key.", "In C major, black keys are out of key.", "Fix an out-of-key note by moving it one row onto a scale note."],
};

// ---------------------------------------------------------------------------------------------------------------------
const PENTA = ["C4", "D4", "E4", "G4", "A4", "C5"];
export const m2Pentatonic: SubLesson = {
  id: "m2-pentatonic",
  version: 1,
  moduleId: "m2",
  title: "Pentatonic",
  summary: "Five easy notes that almost always sound good together.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "Five easy notes",
    text: ["A pentatonic scale has only five notes. In C they are C, D, E, G and A: the major scale without F and B.", "With no half steps between its notes, almost any order sounds good."],
    notes: run(PENTA, 1, 1, 0.5),
  },
  watch: {
    steps: [
      { caption: "Take C major and leave out F and B. What is left is C pentatonic: C, D, E, G, A.", notes: run(PENTA.slice(0, 5), 1, 1, 0.5, ["C", "D", "E", "G", "A"]) },
      { caption: "No two of these notes are just one row apart, so nothing clashes.", notes: run(PENTA, 1, 1, 0.5) },
      { caption: "Folk songs, blues and many pop hooks use just these five notes.", notes: run(["E4", "G4", "A4", "G4", "E4", "D4", "C4"], 1, 1, 0.5) },
      { caption: "Try any order you like: the notes of C pentatonic nearly always sound good together.", notes: run(["A4", "G4", "E4", "D4", "C4"], 1, 1, 1) },
    ],
  },
  tryIt: {
    instruction: "Play C pentatonic going up: C4, D4, E4, G4, A4 and C5, one note per beat. Follow the ghost notes; F and B turn red.",
    tips: ["Skip F and B.", "Press Listen.", "Ctrl+Z undoes a slip."],
    ghost: run(PENTA, 1, 1, 1),
    allowedPitchClasses: ["C", "D", "E", "G", "A"],
    check: { kind: "slots", extra: "fail", slots: slotsForRun(PENTA, 1, 1, 1) },
    tools,
    commands: true,
  },
  practice: {
    task: "Make up your own melody of at least 8 notes using only C pentatonic (C, D, E, G, A), one note at a time, and end on a C.",
    items: ["At least 8 notes", "Only C D E G A", "End on C"],
    check: { kind: "inSet", label: "C pentatonic scale", allowed: ["C", "D", "E", "G", "A"], minNotes: 8, endOn: "C", monophonic: true },
    tools,
    commands: true,
    hints: {
      reminder: "Use only C, D, E, G and A (any octave), make each note end before the next, and finish on C.",
      rows: rows("C4", "D4", "E4", "G4", "A4"),
      answer: run(["E4", "G4", "A4", "G4", "E4", "D4", "E4", "C4"], 1, 1, 1),
    },
  },
  quickCheck: quick("Which two notes of C major are left out of C pentatonic?", ["F and B", "C and G", "D and A", "E and B"], 0, "C pentatonic is C, D, E, G, A: the C major scale without F and B."),
  recap: ["A pentatonic scale has five notes.", "C pentatonic: C, D, E, G, A (C major without F and B).", "Its notes almost always sound good together."],
};

export const M2: SubLesson[] = [m2WhatIsAScale, m2MajorPattern, m2MajorAnyNote, m2Degrees, m2NaturalMinor, m2InKey, m2Pentatonic];
