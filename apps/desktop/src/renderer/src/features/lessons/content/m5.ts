import type { SubLesson } from "../types";
import { chord, chordAt, g, quick, rows, run, slotAt } from "./helpers";

/**
 * M5: Melody. Beginner wording: melodies come from scales, land on chord tones, have a rhythm, repeat a motif. The
 * accompaniment chords sit low (below C4) and the melody above, so the checks can tell them apart. Readable copy for
 * review: docs/lessons/CONTENT.md (keep both in sync).
 */

const tools = ["draw", "select", "delete"] as ("draw" | "select" | "delete")[];
const WHITE = ["C", "D", "E", "F", "G", "A", "B"];
const plain = (notes: ReturnType<typeof chordAt>) => notes.map(({ pitch, startTick, durationTicks }) => ({ pitch, startTick, durationTicks }));

// Low accompaniment chords (below middle C), one bar each.
const LOW = { C: ["C3", "E3", "G3"], G: ["G2", "B2", "D3"], Am: ["A2", "C3", "E3"], F: ["F2", "A2", "C3"] };
const cMaj = chord("C major", "C", "E", "G");
const gMaj = chord("G major", "G", "B", "D");
const aMin = chord("A minor", "A", "C", "E");
const fMaj = chord("F major", "F", "A", "C");

// ---------------------------------------------------------------------------------------------------------------------
export const m5FromAScale: SubLesson = {
  id: "m5-from-a-scale",
  version: 1,
  moduleId: "m5",
  title: "Melody from a scale",
  summary: "Pick notes from a scale, move mostly by steps, and finish on the home note.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "Melodies come from scales",
    text: ["A melody is a line of single notes. The easiest way to write one is to pick notes from a scale.", "In C major, any white keys you choose will fit. Press Play example."],
    notes: [...run(["E4", "D4", "C4", "D4", "E4", "E4"], 1, 1, 1), g("E4", 2, 3, 2)],
  },
  watch: {
    steps: [
      { caption: "Pick a scale to write in. Here, C major: the white keys.", notes: run(["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"], 1, 1, 0.5, ["C", "D", "E", "F", "G", "A", "B", "C"]) },
      { caption: "Move mostly by steps, to the next scale note up or down. Steps sound smooth and singable.", notes: run(["C4", "D4", "E4", "D4", "C4"], 1, 1, 1) },
      { caption: "Add a small jump now and then for interest, like C up to E or E up to G.", notes: run(["C4", "E4", "G4", "E4", "D4", "C4"], 1, 1, 1) },
      { caption: "Finish on C, the home note of C major. The melody then sounds complete.", notes: [g("E4", 1, 1, 1), g("D4", 1, 2, 1), g("C4", 1, 3, 2, { root: true, label: "home" })] },
    ],
  },
  tryIt: {
    instruction: "Write a melody of at least 6 notes in C major, one note at a time, and end on C. Only white keys: a note turns red if it is out of key. The ghost notes show one idea.",
    tips: ["Move mostly by steps.", "Make each note end before the next starts.", "Finish on a C."],
    ghost: run(["E4", "D4", "C4", "D4", "E4", "C4"], 1, 1, 1),
    allowedPitchClasses: WHITE,
    check: { kind: "melodyInKey", key: "C", scale: "major", minNotes: 6, endOn: "C", monophonic: true },
    tools,
    commands: true,
  },
  practice: {
    task: "Write your own melody in G major (the white keys plus F#), with no ghost notes: at least 8 notes, one note at a time, ending on G.",
    items: ["At least 8 notes", "Only notes of G major: G A B C D E F#", "One note at a time", "End on G"],
    check: { kind: "melodyInKey", key: "G", scale: "major", minNotes: 8, endOn: "G", monophonic: true },
    tools,
    commands: true,
    hints: {
      reminder: "G major uses the white keys plus F# (never F). Move mostly by steps, and finish on G.",
      rows: rows("G4", "A4", "B4", "D5", "F#4"),
      answer: run(["G4", "A4", "B4", "D5", "B4", "A4", "F#4", "G4"], 1, 1, 1),
      texts: [
        "G major uses the white keys plus F# (never F). Move mostly by steps, and finish on G.",
        "The highlighted rows are good notes to use. Any notes of G major are fine, as long as the last one is a G.",
        "One possible melody is shown as ghost notes. Yours can be different.",
      ],
    },
  },
  quickCheck: quick("Which move usually sounds smoothest in a melody?", ["Stepping to the next scale note", "Jumping a whole octave", "Using out-of-key notes", "Playing two notes at once"], 0, "Steps between neighbouring scale notes sound smooth and are easy to sing. Jumps add interest but are used less often."),
  recap: ["Pick the notes of a melody from a scale.", "Move mostly by steps, with a jump now and then.", "End on the home note to make it sound finished."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m5ChordTones: SubLesson = {
  id: "m5-chord-tones",
  version: 1,
  moduleId: "m5",
  title: "Chord tones",
  summary: "On the strong beats, land on a note of the chord that is playing.",
  concept: "melody",
  bars: 2,
  hook: {
    headline: "Notes that fit the chord",
    text: ["When a chord is playing, the melody sounds best if it lands on one of the chord's own notes on the strong beats: beats 1 and 3.", "Those notes are called chord tones. Under C major, the chord tones are C, E and G."],
    notes: [...chordAt(1, 1, 4, LOW.C), g("E4", 1, 1, 2), g("G4", 1, 3, 2)],
  },
  watch: {
    steps: [
      { caption: "Low down, a C major chord plays for the whole bar: C, E and G.", notes: chordAt(1, 1, 4, LOW.C) },
      { caption: "On beat 1 the melody plays E. E is in the chord, so it blends in.", notes: [...chordAt(1, 1, 4, LOW.C), g("E4", 1, 1, 1, { root: true, label: "E" })] },
      { caption: "On beats 2 and 4, notes from the scale can pass in between. Beat 3 lands on G, another chord tone.", notes: [...chordAt(1, 1, 4, LOW.C), g("E4", 1, 1, 1, { root: true, label: "E" }), g("F4", 1, 2, 1), g("G4", 1, 3, 1, { root: true, label: "G" }), g("F4", 1, 4, 1)] },
      { caption: "In bar 2 the chord changes to G major (G, B, D), so the strong-beat notes change too: D and B fit.", notes: [...chordAt(2, 1, 4, LOW.G), g("D4", 2, 1, 2, { root: true, label: "D" }), g("B4", 2, 3, 2, { root: true, label: "B" })] },
    ],
  },
  tryIt: {
    instruction: "The chords are written low down: C major in bar 1, G major in bar 2. Add melody notes above C4 on beats 1 and 3 of each bar, using chord tones. The ghost notes show one choice.",
    tips: ["Bar 1 chord tones: C, E, G. Bar 2: G, B, D.", "Keep the melody above middle C (C4).", "A red note is not in either chord."],
    starter: plain([...chordAt(1, 1, 4, LOW.C), ...chordAt(2, 1, 4, LOW.G)]),
    ghost: [...plain([...chordAt(1, 1, 4, LOW.C), ...chordAt(2, 1, 4, LOW.G)]), g("E4", 1, 1, 2), g("G4", 1, 3, 2), g("D4", 2, 1, 2), g("B4", 2, 3, 2)],
    allowedPitchClasses: ["C", "E", "G", "B", "D"],
    check: { kind: "chordToneMelody", rule: { chords: [cMaj, gMaj], melodyMinPitch: 60, strongBeats: [0, 1920] } },
    tools,
    commands: true,
  },
  practice: {
    task: "Now A minor in bar 1 and F major in bar 2 are playing low down. Write a melody above C4 with a chord tone on beats 1 and 3 of each bar. Passing notes in between are allowed.",
    items: ["Bar 1 (A minor): A, C or E on beats 1 and 3", "Bar 2 (F major): F, A or C on beats 1 and 3"],
    starter: plain([...chordAt(1, 1, 4, LOW.Am), ...chordAt(2, 1, 4, LOW.F)]),
    check: { kind: "chordToneMelody", rule: { chords: [aMin, fMaj], melodyMinPitch: 60, strongBeats: [0, 1920] } },
    tools,
    commands: true,
    hints: {
      reminder: "A minor's notes are A, C, E; F major's are F, A, C. Put one of them on beats 1 and 3, above middle C.",
      rows: rows("A4", "E4", "F4"),
      answer: [g("A4", 1, 1, 2), g("E4", 1, 3, 2), g("F4", 2, 1, 2), g("A4", 2, 3, 2)],
    },
  },
  quickCheck: quick("Which of these is a chord tone of C major?", ["E", "F", "D", "B"], 0, "C major is C, E and G, so E is a chord tone. F, D and B are in the scale but not in the chord."),
  recap: ["Chord tones are the notes of the chord that is playing.", "Put chord tones on the strong beats (1 and 3).", "Other scale notes can pass in between."],
};

// ---------------------------------------------------------------------------------------------------------------------
const SWING = [g("C4", 1, 1, 2), g("D4", 1, 3, 0.5), g("E4", 1, 3.5, 0.5), g("G4", 1, 4, 1)];

export const m5MelodyRhythm: SubLesson = {
  id: "m5-melody-rhythm",
  version: 1,
  moduleId: "m5",
  title: "Melody rhythm",
  summary: "When each note starts and how long it lasts gives a melody its character.",
  concept: "rhythm",
  bars: 2,
  hook: {
    headline: "Same notes, new rhythm",
    text: ["A melody is not only which notes you play, but also when, and for how long. That is its rhythm.", "Press Play example: the same four notes, first all even, then long, short, short, medium."],
    notes: [...run(["C4", "D4", "E4", "G4"], 1, 1, 1), g("C4", 2, 1, 2), g("D4", 2, 3, 0.5), g("E4", 2, 3.5, 0.5), g("G4", 2, 4, 1)],
  },
  watch: {
    steps: [
      { caption: "Four notes, one beat each. Even, but a little plain.", notes: run(["C4", "D4", "E4", "G4"], 1, 1, 1) },
      { caption: "Make the first note long (two beats) and squeeze the next two into one beat. Now it has character.", notes: SWING },
      { caption: "Leave a gap: silence is part of rhythm too. Here the melody rests on beat 2.", notes: [g("C4", 1, 1, 1), g("E4", 1, 3, 1), g("G4", 1, 4, 1)] },
      { caption: "Same pitches, different rhythm, different feel. Rhythm is half of a melody.", notes: SWING },
    ],
  },
  tryIt: {
    instruction: "Give C4, D4, E4 and G4 this rhythm: C4 lasts two beats, D4 and E4 half a beat each on beat 3, and G4 one beat on beat 4. Follow the ghost notes.",
    tips: ["Set the grid to 1/8 so each click is half a beat.", "Drag a note's right edge to change its length.", "Press Listen."],
    ghost: SWING,
    allowedPitchClasses: ["C", "D", "E", "G"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [
        slotAt("C4 on beat 1, two beats long", 1, 1, { exact: "C4", len: 2 }),
        slotAt("D4 on beat 3, half a beat", 1, 3, { exact: "D4", len: 0.5 }),
        slotAt("E4 on the 'and' of beat 3, half a beat", 1, 3.5, { exact: "E4", len: 0.5 }),
        slotAt("G4 on beat 4, one beat", 1, 4, { exact: "G4", len: 1 }),
      ],
    },
    tools,
    commands: true,
  },
  practice: {
    task: "Play G4, E4, D4, C4 in bar 1 with this rhythm, no ghost notes: G4 half a beat, E4 half a beat, D4 one beat, then C4 for two beats from beat 3.",
    items: ["Beat 1: G4 (½ beat)", "Beat 1½: E4 (½ beat)", "Beat 2: D4 (1 beat)", "Beat 3: C4 (2 beats)"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [
        slotAt("G4 on beat 1, half a beat", 1, 1, { exact: "G4", len: 0.5 }),
        slotAt("E4 on the 'and' of beat 1, half a beat", 1, 1.5, { exact: "E4", len: 0.5 }),
        slotAt("D4 on beat 2, one beat", 1, 2, { exact: "D4", len: 1 }),
        slotAt("C4 on beat 3, two beats", 1, 3, { exact: "C4", len: 2 }),
      ],
    },
    tools,
    commands: true,
    hints: {
      reminder: "Half a beat is one grid step at 1/8. G4 and E4 share beat 1, D4 fills beat 2, C4 fills beats 3 and 4.",
      rows: rows("G4", "E4", "D4", "C4"),
      answer: [g("G4", 1, 1, 0.5), g("E4", 1, 1.5, 0.5), g("D4", 1, 2, 1), g("C4", 1, 3, 2)],
    },
  },
  quickCheck: quick("What is a melody's rhythm?", ["When each note starts and how long it lasts", "How high the notes are", "How loud the notes are", "Which instrument plays it"], 0, "Rhythm is about time: when each note starts and how long it lasts. Pitch is how high it is."),
  recap: ["Rhythm is when each note starts and how long it lasts.", "Mix long and short notes to give a melody character.", "Silences (rests) are part of the rhythm too."],
};

// ---------------------------------------------------------------------------------------------------------------------
const MOTIF = (bar: number, names = ["C4", "D4", "E4"]) => [g(names[0]!, bar, 1, 1), g(names[1]!, bar, 2, 1), g(names[2]!, bar, 3, 2)];

export const m5Motif: SubLesson = {
  id: "m5-motif",
  version: 1,
  moduleId: "m5",
  title: "Motif and repetition",
  summary: "A short idea, repeated and then changed a little: how melodies stick in your head.",
  concept: "melody",
  bars: 4,
  hook: {
    headline: "Say it again",
    text: ["A motif is a short musical idea, just a few notes. Melodies repeat their motifs so we remember them.", "Press Play example: a three-note motif, repeated, then changed a little."],
    notes: [...MOTIF(1), ...MOTIF(2), ...MOTIF(3, ["C4", "D4", "G4"])],
  },
  watch: {
    steps: [
      { caption: "Here is a motif: three notes, C, D, E. Short, long enough to remember.", notes: MOTIF(1) },
      { caption: "Repeat it exactly in the next bar. Hearing it twice makes it stick.", notes: [...MOTIF(1), ...MOTIF(2)] },
      { caption: "Then vary it: keep the same rhythm but change one note. Here the E becomes G.", notes: [...MOTIF(1), ...MOTIF(2), ...MOTIF(3, ["C4", "D4", "G4"])] },
      { caption: "Repeat, repeat, vary: you hear it in almost every song. Copy and paste makes it quick.", notes: [...MOTIF(1), ...MOTIF(2), ...MOTIF(3, ["C4", "D4", "G4"])] },
    ],
  },
  tryIt: {
    instruction: "Bar 1 has a motif. Repeat it exactly in bar 2: select its three notes and press Duplicate (Ctrl+D), or copy and paste. Follow the ghost notes.",
    tips: ["The motif fills the whole bar, so Duplicate puts the copy straight into bar 2.", "Drag a box with the Select tool to select the notes.", "Press Listen."],
    starter: MOTIF(1),
    ghost: [...MOTIF(1), ...MOTIF(2)],
    allowedPitchClasses: ["C", "D", "E"],
    check: { kind: "repeatBars", from: 0, to: 1, minNotes: 3 },
    tools,
    commands: true,
  },
  practice: {
    task: "Write your own motif of at least 3 notes in bar 1. Repeat it exactly in bar 2. In bar 3, keep the same rhythm but change at least one note.",
    items: ["Bar 1: your motif (3+ notes)", "Bar 2: an exact copy", "Bar 3: same rhythm, one note changed"],
    check: { kind: "repeatBars", from: 0, to: 1, minNotes: 3, variation: { bar: 2, compareTo: 0 } },
    tools,
    commands: true,
    hints: {
      reminder: "Bar 1: any 3 or more notes. Bar 2: an exact copy. Bar 3: copy it again, then move one note up or down.",
      rows: rows("G4", "A4", "C5"),
      answer: [...MOTIF(1, ["G4", "A4", "G4"]), ...MOTIF(2, ["G4", "A4", "G4"]), ...MOTIF(3, ["G4", "A4", "C5"])],
      texts: [
        "Bar 1: any 3 or more notes. Bar 2: an exact copy. Bar 3: copy it again, then move one note up or down.",
        "If your motif fills bar 1, select it and Duplicate twice. Then drag one note in bar 3 up or down. The highlighted rows show one possible motif.",
        "One possible answer is shown as ghost notes. Yours can be different.",
      ],
    },
  },
  quickCheck: quick("What is a motif?", ["A short musical idea that repeats", "A very long chord", "The speed of a song", "A wrong note"], 0, "A motif is a short idea of a few notes. Repeating it, then varying it, makes a melody memorable."),
  recap: ["A motif is a short idea of a few notes.", "Repeat it so listeners remember it.", "Vary it (same rhythm, a changed note) to keep it interesting."],
};

// ---------------------------------------------------------------------------------------------------------------------
const PROGRESSION = plain([...chordAt(1, 1, 4, LOW.C), ...chordAt(2, 1, 4, LOW.G), ...chordAt(3, 1, 4, LOW.Am), ...chordAt(4, 1, 4, LOW.F)]);
const SONG = [g("E4", 1, 1, 2), g("D4", 1, 3, 1), g("C4", 1, 4, 1), g("D4", 2, 1, 2), g("B4", 2, 3, 2), g("C5", 3, 1, 2), g("A4", 3, 3, 2), g("A4", 4, 1, 2), g("G4", 4, 3, 1), g("C5", 4, 4, 1)];

export const m5Project: SubLesson = {
  id: "m5-project",
  version: 1,
  moduleId: "m5",
  title: "Project: melody over your progression",
  summary: "Put it all together: write a melody over I–V–vi–IV.",
  concept: "melody",
  bars: 4,
  hook: {
    headline: "Your first song",
    text: ["Time to put everything together: a chord progression, with your own melody on top.", "The chords are I – V – vi – IV in C major (C, G, Am, F). You write the tune."],
    notes: [...PROGRESSION.slice(0, 3), g("E4", 1, 1, 2), g("D4", 1, 3, 1), g("C4", 1, 4, 1)],
  },
  watch: {
    steps: [
      { caption: "The chords are already there, low down: C, G, A minor, F, one per bar.", notes: PROGRESSION },
      { caption: "Rule 1: write the melody above middle C, using notes of C major (the white keys).", notes: [...PROGRESSION, g("E4", 1, 1, 2), g("D4", 1, 3, 1), g("C4", 1, 4, 1)] },
      { caption: "Rule 2: on beat 1 of each bar, land on a note of that bar's chord: E over C, D over G, C over Am, A over F.", notes: [...PROGRESSION, g("E4", 1, 1, 2, { label: "E" }), g("D4", 2, 1, 2, { label: "D" }), g("C5", 3, 1, 2, { label: "C" }), g("A4", 4, 1, 2, { label: "A" })] },
      { caption: "Rule 3: end on C, the home note. Then press Play and listen to your song.", notes: [...PROGRESSION, ...SONG] },
    ],
  },
  tryIt: {
    instruction: "Warm up: above C4, put a chord tone on beat 1 of each bar: E in bar 1 (over C), D in bar 2 (over G), C in bar 3 (over Am), A in bar 4 (over F). Follow the ghost notes.",
    tips: ["Chord tones: C = C E G, G = G B D, Am = A C E, F = F A C.", "Keep the melody above middle C (C4).", "A red note is out of key."],
    starter: PROGRESSION,
    ghost: [...PROGRESSION, g("E4", 1, 1, 4), g("D4", 2, 1, 4), g("C5", 3, 1, 4), g("A4", 4, 1, 4)],
    allowedPitchClasses: WHITE,
    check: { kind: "chordToneMelody", rule: { chords: [cMaj, gMaj, aMin, fMaj], melodyMinPitch: 60, strongBeats: [0] } },
    tools,
    commands: true,
  },
  practice: {
    task: "Now write the whole melody, with no ghost notes: at least 8 notes above C4, only white keys, one note at a time, a chord tone on beat 1 of every bar, and end on C.",
    items: ["8+ notes above C4, white keys only", "One note at a time", "Beat 1 of each bar: a chord tone", "End on C"],
    starter: PROGRESSION,
    check: {
      kind: "all",
      checks: [
        { kind: "melodyInKey", key: "C", scale: "major", minNotes: 8, endOn: "C", monophonic: true, minPitch: 60 },
        { kind: "chordToneMelody", rule: { chords: [cMaj, gMaj, aMin, fMaj], melodyMinPitch: 60, strongBeats: [0] } },
      ],
    },
    tools,
    commands: true,
    hints: {
      reminder: "Start each bar on a chord tone (E, D, C, A works), fill the gaps with steps along the white keys, and finish on C.",
      rows: rows("E4", "D4", "C4", "B4", "C5", "A4", "G4"),
      answer: SONG,
      texts: [
        "Start each bar on a chord tone (E, D, C, A works), fill the gaps with steps along the white keys, and finish on C.",
        "The highlighted rows are good melody notes. Remember: one note at a time, above C4.",
        "One possible melody is shown as ghost notes. Yours can be different. Press Play when you are done!",
      ],
    },
  },
  quickCheck: quick("In this project, what should the melody play on beat 1 of each bar?", ["A note of that bar's chord", "A black key", "The same note every time", "Nothing at all"], 0, "Landing on a chord tone on beat 1 makes the melody fit the chord underneath."),
  recap: ["A song = chords underneath + a melody on top.", "Melody notes from the key, chord tones on the strong beats, end on home.", "Press Apply it in the studio to keep working on your song."],
};

export const M5: SubLesson[] = [m5FromAScale, m5ChordTones, m5MelodyRhythm, m5Motif, m5Project];
