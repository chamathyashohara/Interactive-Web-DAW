import type { SubLesson } from "../types";
import { chord, chordAt, g, quick, rows, run, slotAt } from "./helpers";
import { m3RootNote } from "./m3-root-note";

/**
 * M3: Chords. Written for complete beginners: one new idea per sub-lesson, short sentences, white keys first, and every
 * chord built by counting rows. Readable copy for review: docs/lessons/CONTENT.md (keep both in sync).
 */

const tools = ["draw", "select", "delete"] as ("draw" | "select" | "delete")[];

// ---------------------------------------------------------------------------------------------------------------------
export const m3WhatIsAChord: SubLesson = {
  id: "m3-what-is-a-chord",
  version: 1,
  moduleId: "m3",
  title: "What a chord is",
  summary: "A chord is several notes played at the same time.",
  concept: "chords",
  bars: 2,
  hook: {
    headline: "Notes together",
    text: ["A melody plays notes one after another. A chord plays several notes at the same time.", "Press Play example: three notes one by one, then the same three together."],
    notes: [...run(["C4", "E4", "G4"], 1, 1, 1), ...chordAt(2, 1, 2, ["C4", "E4", "G4"])],
  },
  watch: {
    steps: [
      { caption: "One note on its own is a single sound.", notes: [g("C4", 1, 1, 2)] },
      { caption: "Add a second note at the same moment, and the two sounds blend together.", notes: chordAt(1, 1, 2, ["C4", "E4"]) },
      { caption: "Three notes that start together make a chord. This one is called C major.", notes: chordAt(1, 1, 2, ["C4", "E4", "G4"]) },
      { caption: "The same three notes one after another are not a chord. They are a little melody.", notes: run(["C4", "E4", "G4"], 1, 1, 1) },
      { caption: "So what makes a chord is time: the notes start at the same moment, stacked up the grid.", notes: chordAt(1, 1, 2, ["C4", "E4", "G4"]) },
    ],
  },
  tryIt: {
    instruction: "Build your first chord: stack C4, E4 and G4 so they all start on beat 1 of bar 1. Follow the ghost notes.",
    tips: ["Notes that start at the same moment sit in a vertical line.", "Press Listen to hear them together.", "A red note does not belong in this chord."],
    ghost: chordAt(1, 1, 2, ["C4", "E4", "G4"]),
    allowedPitchClasses: ["C", "E", "G"],
    check: { kind: "chordsPerBar", chords: [chord("C major", "C", "E", "G")] },
    tools,
    commands: true,
  },
  practice: {
    task: "Show the difference. In bar 1, make a chord: any three notes that all start on beat 1. In bar 2, make a melody: three notes one after another, on beats 1, 2 and 3.",
    items: ["Bar 1: three notes together on beat 1", "Bar 2: three notes on beats 1, 2 and 3"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [
        slotAt("bar 1: the first note of the chord on beat 1", 1, 1),
        slotAt("bar 1: a second note of the chord on beat 1", 1, 1),
        slotAt("bar 1: a third note of the chord on beat 1", 1, 1),
        slotAt("bar 2: a melody note on beat 1", 2, 1),
        slotAt("bar 2: a melody note on beat 2", 2, 2),
        slotAt("bar 2: a melody note on beat 3", 2, 3),
      ],
    },
    tools,
    commands: true,
    hints: {
      reminder: "A chord: notes stacked on the same beat. A melody: notes side by side, one per beat.",
      rows: rows("D4", "F4", "A4", "E4", "G4", "C5"),
      answer: [...chordAt(1, 1, 2, ["D4", "F4", "A4"]), ...run(["E4", "G4", "C5"], 2, 1, 1)],
    },
  },
  quickCheck: quick("What makes a group of notes a chord?", ["They start at the same time", "They are all high notes", "They are all long notes", "They are all black keys"], 0, "A chord is several notes sounding at the same moment. Notes one after another make a melody instead."),
  recap: ["A chord is several notes played at the same time.", "On the piano roll, a chord is a vertical stack of notes.", "The same notes one after another make a melody, not a chord."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m3Intervals: SubLesson = {
  id: "m3-intervals",
  version: 1,
  moduleId: "m3",
  title: "Intervals",
  summary: "The distance between two notes, counted in rows. Chords are built from a few favourite distances.",
  concept: "chords",
  bars: 2,
  hook: {
    headline: "Distance between notes",
    text: ["An interval is the distance between two notes. Count it in semitones: the number of rows from one note to the other.", "Press Play example: C with E (4 rows apart), then C with G (7 rows apart)."],
    notes: [...chordAt(1, 1, 2, ["C4", "E4"]), ...chordAt(1, 3, 2, ["C4", "G4"])],
  },
  watch: {
    steps: [
      { caption: "Count the rows from C up to E: four. A distance of 4 rows is called a major third.", notes: [g("C4", 1, 1, 2, { label: "C" }), g("E4", 1, 1, 2, { label: "+4" })] },
      { caption: "One row less, C up to E♭, is 3 rows: a minor third. It sounds a little darker.", notes: [g("C4", 1, 1, 2, { label: "C" }), g("Eb4", 1, 1, 2, { label: "+3" })] },
      { caption: "From C up to G is 7 rows: a perfect fifth. It sounds strong and open.", notes: [g("C4", 1, 1, 2, { label: "C" }), g("G4", 1, 1, 2, { label: "+7" })] },
      { caption: "Thirds (3 or 4 rows) and the fifth (7 rows) are the building blocks of chords.", notes: [g("C4", 1, 1, 2, { label: "C" }), g("E4", 1, 1, 2, { label: "+4" }), g("G4", 1, 1, 2, { label: "+7" })] },
    ],
  },
  tryIt: {
    instruction: "C4 is on beat 1. Add E4 at the same moment (4 rows up: a major third). Then on beat 3 play C4 together with G4 (7 rows up: a fifth). Follow the ghost notes.",
    tips: ["Count every row, black keys included.", "Copy the C4 to beat 3 with Duplicate if you like.", "Press Listen to compare the two sounds."],
    starter: [g("C4", 1, 1, 2)],
    ghost: [g("C4", 1, 1, 2), g("E4", 1, 1, 2), g("C4", 1, 3, 2), g("G4", 1, 3, 2)],
    allowedPitchClasses: ["C", "E", "G"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [slotAt("C4 on beat 1", 1, 1, { exact: "C4" }), slotAt("E4 on beat 1 (a major third above)", 1, 1, { exact: "E4" }), slotAt("C4 on beat 3", 1, 3, { exact: "C4" }), slotAt("G4 on beat 3 (a fifth above)", 1, 3, { exact: "G4" })],
    },
    tools,
    commands: true,
  },
  practice: {
    task: "Three notes are already there. At the same moment as each one, add the note above it: on bar 1, beat 1 a major third (4 rows) above D4; on bar 1, beat 3 a fifth (7 rows) above A3; on bar 2, beat 1 a minor third (3 rows) above E4.",
    items: ["Bar 1, beat 1: 4 rows above D4", "Bar 1, beat 3: 7 rows above A3", "Bar 2, beat 1: 3 rows above E4"],
    starter: [g("D4", 1, 1, 2), g("A3", 1, 3, 2), g("E4", 2, 1, 2)],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [
        slotAt("D4 on bar 1, beat 1", 1, 1, { exact: "D4" }),
        slotAt("a major third above D4 (F#4)", 1, 1, { exact: "F#4" }),
        slotAt("A3 on bar 1, beat 3", 1, 3, { exact: "A3" }),
        slotAt("a fifth above A3 (E4)", 1, 3, { exact: "E4" }),
        slotAt("E4 on bar 2, beat 1", 2, 1, { exact: "E4" }),
        slotAt("a minor third above E4 (G4)", 2, 1, { exact: "G4" }),
      ],
    },
    tools,
    commands: true,
    hints: {
      reminder: "Start on the given note and count rows upward, black keys included: 4 rows for a major third, 7 for a fifth, 3 for a minor third.",
      rows: rows("F#4", "E4", "G4"),
      answer: [g("D4", 1, 1, 2), g("F#4", 1, 1, 2), g("A3", 1, 3, 2), g("E4", 1, 3, 2), g("E4", 2, 1, 2), g("G4", 2, 1, 2)],
    },
  },
  quickCheck: quick("How many semitones (rows) is a perfect fifth?", ["7", "4", "3", "12"], 0, "A perfect fifth is 7 rows, like C up to G. A major third is 4 and a minor third is 3."),
  recap: ["An interval is the distance between two notes, counted in rows (semitones).", "Major third = 4 rows, minor third = 3 rows, perfect fifth = 7 rows.", "Chords are built by stacking these distances."],
};

// ---------------------------------------------------------------------------------------------------------------------
const MAJOR_LABELS = (root: string, mid: string, top: string, names: [string, string, string]) => [
  g(names[0], 1, 1, 2, { root: true, label: root }),
  g(names[1], 1, 1, 2, { label: mid }),
  g(names[2], 1, 1, 2, { label: top }),
];

export const m3MajorTriad: SubLesson = {
  id: "m3-major-triad",
  version: 1,
  moduleId: "m3",
  title: "Major triad",
  summary: "The bright, happy chord: root, 4 rows up, 7 rows up.",
  concept: "chords",
  bars: 4,
  hook: {
    headline: "The happy chord",
    text: ["A major triad has three notes: the root, the note 4 rows above it, and the note 7 rows above it.", "Press Play example: C major. Bright and happy."],
    notes: chordAt(1, 1, 2, ["C4", "E4", "G4"], { root: true }),
  },
  watch: {
    steps: [
      { caption: "Start with the root. Here it is C.", notes: [g("C4", 1, 1, 2, { root: true, label: "root" })] },
      { caption: "Count 4 rows up from the root and add that note: E. That is the major third.", notes: [g("C4", 1, 1, 2, { root: true, label: "root" }), g("E4", 1, 1, 2, { label: "+4" })] },
      { caption: "Count 7 rows up from the root and add that note: G. Root, +4, +7: C major.", notes: MAJOR_LABELS("root", "+4", "+7", ["C4", "E4", "G4"]) },
      { caption: "The recipe works from any root. From F: 4 rows up is A, 7 rows up is C. That is F major.", notes: MAJOR_LABELS("F", "+4", "+7", ["F4", "A4", "C5"]) },
      { caption: "From D, 4 rows up lands on a black key, F#. That is fine: D major is D, F#, A.", notes: MAJOR_LABELS("D", "+4", "+7", ["D4", "F#4", "A4"]) },
    ],
  },
  tryIt: {
    instruction: "Build G major on beat 1 with the recipe: the root G4, the note 4 rows above it, and the note 7 rows above G4. Follow the ghost notes.",
    tips: ["Count every row, black keys included.", "The root is marked in amber.", "A red note is not part of G major."],
    ghost: chordAt(1, 1, 2, ["G4", "B4", "D5"], { root: true }),
    allowedPitchClasses: ["G", "B", "D"],
    check: { kind: "chordsPerBar", chords: [chord("G major", "G", "B", "D")] },
    tools,
    commands: true,
  },
  practice: {
    task: "Build a major triad on beat 1 of each bar, with no ghost notes: bar 1 C major, bar 2 F major, bar 3 D major, bar 4 A major. Use the recipe: root, +4 rows, +7 rows.",
    items: ["Bar 1: C major", "Bar 2: F major", "Bar 3: D major", "Bar 4: A major"],
    check: { kind: "chordsPerBar", chords: [chord("C major", "C", "E", "G"), chord("F major", "F", "A", "C"), chord("D major", "D", "F#", "A"), chord("A major", "A", "C#", "E")] },
    tools,
    commands: true,
    hints: {
      reminder: "Recipe: the root, then count 4 rows up, then 7 rows up from the root. D major and A major each need one black key.",
      rows: rows("C4", "E4", "G4", "F4", "A4", "C5", "D4", "F#4", "A3", "C#4"),
      answer: [...chordAt(1, 1, 2, ["C4", "E4", "G4"]), ...chordAt(2, 1, 2, ["F4", "A4", "C5"]), ...chordAt(3, 1, 2, ["D4", "F#4", "A4"]), ...chordAt(4, 1, 2, ["A3", "C#4", "E4"])],
    },
  },
  quickCheck: quick("Which three notes make C major?", ["C, E, G", "C, D, E", "C, F, A", "C, E♭, G"], 0, "C major is the root C, E (4 rows up) and G (7 rows up). C, E♭, G is C minor."),
  recap: ["Major triad recipe: root, +4 rows, +7 rows.", "It sounds bright and happy.", "The recipe works from any root; some roots need a black key (D major: D, F#, A)."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m3MinorTriad: SubLesson = {
  id: "m3-minor-triad",
  version: 1,
  moduleId: "m3",
  title: "Minor triad",
  summary: "The darker, sadder chord: move the middle note down one row.",
  concept: "chords",
  bars: 4,
  hook: {
    headline: "The sad chord",
    text: ["A minor triad is the major recipe with one change: the middle note is one row lower. Root, +3 rows, +7 rows.", "Press Play example: C major, then C minor. Can you hear the mood change?"],
    notes: [...chordAt(1, 1, 2, ["C4", "E4", "G4"]), ...chordAt(1, 3, 2, ["C4", "Eb4", "G4"])],
  },
  watch: {
    steps: [
      { caption: "Here is C major again: C, E, G. Bright.", notes: MAJOR_LABELS("root", "+4", "+7", ["C4", "E4", "G4"]) },
      { caption: "Move the middle note down one row, from E to E♭. Now the chord sounds darker: C minor.", notes: MAJOR_LABELS("root", "+3", "+7", ["C4", "Eb4", "G4"]) },
      { caption: "The minor recipe: the root, 3 rows up, and 7 rows up from the root.", notes: MAJOR_LABELS("root", "+3", "+7", ["C4", "Eb4", "G4"]) },
      { caption: "A minor uses only white keys: A, C, E. Count it: C is 3 rows above A, E is 7.", notes: MAJOR_LABELS("A", "+3", "+7", ["A3", "C4", "E4"]) },
    ],
  },
  tryIt: {
    instruction: "This is C major. Turn it into C minor: drag the middle note, E4, down one row to E♭4 (the row labelled D#4). The red note shows what to change.",
    tips: ["Only the middle note moves. C and G stay.", "One row down is one semitone.", "Press Listen before and after to hear the difference."],
    starter: chordAt(1, 1, 2, ["C4", "E4", "G4"]),
    ghost: chordAt(1, 1, 2, ["C4", "Eb4", "G4"], { root: true }),
    allowedPitchClasses: ["C", "Eb", "G"],
    check: { kind: "chordsPerBar", chords: [chord("C minor", "C", "Eb", "G")] },
    tools,
    commands: true,
  },
  practice: {
    task: "Build a minor triad on beat 1 of each bar, with no ghost notes: bar 1 A minor, bar 2 D minor, bar 3 E minor, bar 4 C minor. Recipe: root, +3 rows, +7 rows.",
    items: ["Bar 1: A minor", "Bar 2: D minor", "Bar 3: E minor", "Bar 4: C minor"],
    check: { kind: "chordsPerBar", chords: [chord("A minor", "A", "C", "E"), chord("D minor", "D", "F", "A"), chord("E minor", "E", "G", "B"), chord("C minor", "C", "Eb", "G")] },
    tools,
    commands: true,
    hints: {
      reminder: "Minor recipe: the root, 3 rows up, then 7 rows up from the root. A, D and E minor use only white keys; C minor needs E♭.",
      rows: rows("A3", "C4", "E4", "D4", "F4", "A4", "G4", "B4", "Eb4"),
      answer: [...chordAt(1, 1, 2, ["A3", "C4", "E4"]), ...chordAt(2, 1, 2, ["D4", "F4", "A4"]), ...chordAt(3, 1, 2, ["E4", "G4", "B4"]), ...chordAt(4, 1, 2, ["C4", "Eb4", "G4"])],
    },
  },
  quickCheck: quick("How do you turn a major triad into a minor triad?", ["Move the middle note down one row", "Move the top note up one row", "Move the root down one row", "Add a fourth note"], 0, "Only the middle note (the third) changes: 4 rows above the root is major, 3 rows above is minor."),
  recap: ["Minor triad recipe: root, +3 rows, +7 rows.", "It is a major triad with the middle note one row lower.", "Minor chords sound darker or sadder than major ones."],
};

// ---------------------------------------------------------------------------------------------------------------------
const named = (bar: number, beat: number, names: string[], label: string) => chordAt(bar, beat, 2, names, { root: label });

export const m3ChordNames: SubLesson = {
  id: "m3-chord-names",
  version: 1,
  moduleId: "m3",
  title: "Reading chord names",
  summary: "Read chord charts: the letter is the root, a small m means minor.",
  concept: "chords",
  bars: 4,
  hook: {
    headline: "Reading chord names",
    text: ["Chord names are short. The letter is the root. A letter on its own means major; a small m after it means minor.", "So C means C major, and Am means A minor."],
    notes: [...chordAt(1, 1, 2, ["C4", "E4", "G4"]), ...chordAt(1, 3, 2, ["A3", "C4", "E4"])],
  },
  watch: {
    steps: [
      { caption: "\"C\" on its own means C major: C, E, G.", notes: named(1, 1, ["C4", "E4", "G4"], "C") },
      { caption: "\"Am\" means A minor. The letter A is the root, and the small m means minor: A, C, E.", notes: named(1, 1, ["A3", "C4", "E4"], "Am") },
      { caption: "\"G\" is G major: G, B, D.", notes: named(1, 1, ["G3", "B3", "D4"], "G") },
      { caption: "\"Dm\" is D minor: D, F, A. Letter = root. m = minor. Nothing = major.", notes: named(1, 1, ["D4", "F4", "A4"], "Dm") },
    ],
  },
  tryIt: {
    instruction: "Build the chord named Dm on beat 1 of bar 1. The letter tells you the root; the m tells you it is minor. Follow the ghost notes.",
    tips: ["Dm = D minor: root D, +3 rows, +7 rows.", "It uses only white keys.", "A red note is not part of Dm."],
    ghost: named(1, 1, ["D4", "F4", "A4"], "Dm"),
    allowedPitchClasses: ["D", "F", "A"],
    check: { kind: "chordsPerBar", chords: [chord("Dm, D minor", "D", "F", "A")] },
    tools,
    commands: true,
  },
  practice: {
    task: "A chord chart says: | C | Am | F | G |. Build each chord on beat 1 of its bar, with no ghost notes.",
    items: ["Bar 1: C", "Bar 2: Am", "Bar 3: F", "Bar 4: G"],
    check: { kind: "chordsPerBar", chords: [chord("C, C major", "C", "E", "G"), chord("Am, A minor", "A", "C", "E"), chord("F, F major", "F", "A", "C"), chord("G, G major", "G", "B", "D")] },
    tools,
    commands: true,
    hints: {
      reminder: "Read each name: the letter is the root. No m means major (+4, +7). An m means minor (+3, +7). All four use only white keys.",
      rows: rows("C4", "E4", "G4", "A3", "F4", "A4", "C5", "G3", "B3", "D4"),
      answer: [...chordAt(1, 1, 2, ["C4", "E4", "G4"]), ...chordAt(2, 1, 2, ["A3", "C4", "E4"]), ...chordAt(3, 1, 2, ["F4", "A4", "C5"]), ...chordAt(4, 1, 2, ["G3", "B3", "D4"])],
    },
  },
  quickCheck: quick("What does the chord name \"Em\" mean?", ["E minor", "E major", "E with a melody", "E played twice"], 0, "The letter is the root (E) and the small m means minor: E minor, which is E, G, B."),
  recap: ["In a chord name, the letter is the root.", "A letter on its own means major; a small m means minor.", "C = C major, Am = A minor, Dm = D minor."],
};

// ---------------------------------------------------------------------------------------------------------------------
const WK = (bar: number, beat: number, names: string[], label: string, length = 2) => chordAt(bar, beat, length, names, { root: label });

export const m3ChordsOfAKey: SubLesson = {
  id: "m3-chords-of-a-key",
  version: 1,
  moduleId: "m3",
  title: "Chords of a key",
  summary: "Build a chord on each white key, using only white keys: the chord family of C major.",
  concept: "chords",
  bars: 4,
  hook: {
    headline: "A family of chords",
    text: ["Start on any white key, then skip one white key and take the next, twice. Using only white keys, you get the chords of C major.", "They all sound good together. That is why songs mix them."],
    notes: [...WK(1, 1, ["C4", "E4", "G4"], "C", 1), ...WK(1, 2, ["D4", "F4", "A4"], "Dm", 1), ...WK(1, 3, ["E4", "G4", "B4"], "Em", 1), ...WK(1, 4, ["F4", "A4", "C5"], "F", 1)],
  },
  watch: {
    steps: [
      { caption: "On C, stack white keys, skipping one each time: C, E, G. That is C major.", notes: WK(1, 1, ["C4", "E4", "G4"], "C") },
      { caption: "Do the same on D: D, F, A. Only white keys, and it comes out minor: D minor.", notes: WK(1, 1, ["D4", "F4", "A4"], "Dm") },
      { caption: "On E: E, G, B is E minor. On F: F, A, C is F major.", notes: [...WK(1, 1, ["E4", "G4", "B4"], "Em"), ...WK(1, 3, ["F4", "A4", "C5"], "F")] },
      { caption: "On G: G, B, D is G major. On A: A, C, E is A minor.", notes: [...WK(1, 1, ["G3", "B3", "D4"], "G"), ...WK(1, 3, ["A3", "C4", "E4"], "Am")] },
      { caption: "So the main chords of C major are C, Dm, Em, F, G and Am: three major, three minor.", notes: WK(1, 1, ["C4", "E4", "G4"], "C") },
    ],
  },
  tryIt: {
    instruction: "Using only white keys, build the chord that starts on E: E4, then skip a white key to G4, then skip again to B4. All on beat 1. Follow the ghost notes.",
    tips: ["Skip one white key each time: E (F) G (A) B.", "No black keys in this lesson.", "A red note is not in the chord."],
    ghost: WK(1, 1, ["E4", "G4", "B4"], "Em"),
    allowedPitchClasses: ["E", "G", "B"],
    check: { kind: "chordsPerBar", chords: [chord("E minor", "E", "G", "B")] },
    tools,
    commands: true,
  },
  practice: {
    task: "Using only white keys (start on the given note, skip one white key, take the next, twice), build the chord on beat 1 of each bar: bar 1 starting on F, bar 2 on A, bar 3 on D, bar 4 on G.",
    items: ["Bar 1: start on F", "Bar 2: start on A", "Bar 3: start on D", "Bar 4: start on G"],
    check: { kind: "chordsPerBar", chords: [chord("F major", "F", "A", "C"), chord("A minor", "A", "C", "E"), chord("D minor", "D", "F", "A"), chord("G major", "G", "B", "D")] },
    tools,
    commands: true,
    hints: {
      reminder: "Start on the given note, then skip one white key and take the next, two times. Only white keys.",
      rows: rows("F4", "A4", "C5", "A3", "C4", "E4", "D4", "G3", "B3"),
      answer: [...chordAt(1, 1, 2, ["F4", "A4", "C5"]), ...chordAt(2, 1, 2, ["A3", "C4", "E4"]), ...chordAt(3, 1, 2, ["D4", "F4", "A4"]), ...chordAt(4, 1, 2, ["G3", "B3", "D4"])],
    },
  },
  quickCheck: quick("Which of these chords belongs to the key of C major?", ["A minor (A, C, E)", "D major (D, F#, A)", "E major (E, G#, B)", "B♭ major (B♭, D, F)"], 0, "A minor uses only white keys, so it belongs to C major. The others need black keys that are not in C major."),
  recap: ["Stack white keys, skipping one each time, to build the chords of C major.", "C major's main chords: C, Dm, Em, F, G, Am.", "Chords from the same key sound good together."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m3Inversions: SubLesson = {
  id: "m3-inversions",
  version: 1,
  moduleId: "m3",
  title: "Inversions",
  summary: "Same chord, different order: put another note at the bottom.",
  concept: "chords",
  bars: 4,
  hook: {
    headline: "Same chord, new order",
    text: ["You can play a chord's notes in a different order. When a note other than the root is at the bottom, it is called an inversion.", "It is still the same chord. It just sounds a little different, and it can make changing chords smoother."],
    notes: [...chordAt(1, 1, 2, ["C4", "E4", "G4"]), g("E4", 1, 3, 2), g("G4", 1, 3, 2), g("C5", 1, 3, 2)],
  },
  watch: {
    steps: [
      { caption: "C major in root position: C at the bottom, then E, then G.", notes: chordAt(1, 1, 2, ["C4", "E4", "G4"], { root: true }) },
      { caption: "Move the C up an octave: E, G, C. Still C major, now with E at the bottom. That is the first inversion.", notes: [g("E4", 1, 1, 2), g("G4", 1, 1, 2), g("C5", 1, 1, 2, { root: true, label: "root" })] },
      { caption: "Move the E up too: G, C, E. Still C major, with G at the bottom: the second inversion.", notes: [g("G4", 1, 1, 2), g("C5", 1, 1, 2, { root: true, label: "root" }), g("E5", 1, 1, 2)] },
      { caption: "Inversions keep chords close together. C (C E G) to F with C at the bottom (C F A) only moves two notes a little.", notes: [...chordAt(1, 1, 2, ["C4", "E4", "G4"]), ...chordAt(1, 3, 2, ["C4", "F4", "A4"])] },
    ],
  },
  tryIt: {
    instruction: "This is C major in root position. Make the first inversion: move the C4 up an octave to C5, so that E is the lowest note. Follow the ghost notes.",
    tips: ["Drag the C4 note up 12 rows to C5.", "The chord stays C major; only the bottom note changes.", "Press Listen before and after."],
    starter: chordAt(1, 1, 2, ["C4", "E4", "G4"]),
    ghost: [g("E4", 1, 1, 2), g("G4", 1, 1, 2), g("C5", 1, 1, 2, { root: true, label: "root" })],
    allowedPitchClasses: ["C", "E", "G"],
    check: { kind: "chordsPerBar", chords: [{ ...chord("C major", "C", "E", "G"), bass: "E" }] },
    tools,
    commands: true,
  },
  practice: {
    task: "Build each chord with the given note at the bottom (lowest): bar 1 F major with A at the bottom, bar 2 G major with B at the bottom, bar 3 C major with G at the bottom, bar 4 A minor with C at the bottom.",
    items: ["Bar 1: F major, A lowest", "Bar 2: G major, B lowest", "Bar 3: C major, G lowest", "Bar 4: A minor, C lowest"],
    check: {
      kind: "chordsPerBar",
      chords: [
        { ...chord("F major", "F", "A", "C"), bass: "A" },
        { ...chord("G major", "G", "B", "D"), bass: "B" },
        { ...chord("C major", "C", "E", "G"), bass: "G" },
        { ...chord("A minor", "A", "C", "E"), bass: "C" },
      ],
    },
    tools,
    commands: true,
    hints: {
      reminder: "First build the chord, then move notes up an octave until the given note is the lowest one.",
      rows: rows("A3", "C4", "F4", "B3", "D4", "G4", "G3", "E4", "A4"),
      answer: [...chordAt(1, 1, 2, ["A3", "C4", "F4"]), ...chordAt(2, 1, 2, ["B3", "D4", "G4"]), ...chordAt(3, 1, 2, ["G3", "C4", "E4"]), ...chordAt(4, 1, 2, ["C4", "E4", "A4"])],
    },
  },
  quickCheck: quick("E, G and C played together (E at the bottom) is…", ["C major, first inversion", "E minor", "G major", "Not a chord"], 0, "The notes are C, E and G, so it is C major. With E at the bottom instead of C, it is the first inversion."),
  recap: ["An inversion puts a note other than the root at the bottom.", "It is still the same chord: C, E, G in any order is C major.", "Inversions keep chord changes smooth and close together."],
};

export const M3: SubLesson[] = [m3WhatIsAChord, m3RootNote, m3Intervals, m3MajorTriad, m3MinorTriad, m3ChordNames, m3ChordsOfAKey, m3Inversions];
