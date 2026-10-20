import type { ChordAt, SubLesson } from "../types";
import { at, chord, chordAt, g, quick, rows, slotAt } from "./helpers";

/**
 * M4: Chord progressions. Beginner wording: chords take turns, I = home, Roman numerals are scale degrees. Readable copy
 * for review: docs/lessons/CONTENT.md (keep both in sync).
 */

const tools = ["draw", "select", "delete"] as ("draw" | "select" | "delete")[];
const WHITE = ["C", "D", "E", "F", "G", "A", "B"];

// Chord shapes in the middle of the roll, as note names.
const C = ["C4", "E4", "G4"];
const G = ["G3", "B3", "D4"];
const AM = ["A3", "C4", "E4"];
const F = ["F3", "A3", "C4"];
const EM = ["E4", "G4", "B4"];
const D = ["D4", "F#4", "A4"];

const cMaj = chord("C major", "C", "E", "G");
const gMaj = chord("G major", "G", "B", "D");
const aMin = chord("A minor", "A", "C", "E");
const fMaj = chord("F major", "F", "A", "C");
const dMin = chord("D minor", "D", "F", "A");
const eMin = chord("E minor", "E", "G", "B");
const dMaj = chord("D major", "D", "F#", "A");

const atTick = (target: ReturnType<typeof chord>, bar: number, beat: number): ChordAt => ({ ...target, startTick: at(bar, beat) });
/** One chord per bar on beat 1, each lasting `length` beats, labelled with its name. */
const perBar = (shapes: string[][], labels: string[], length = 2) => shapes.flatMap((names, i) => chordAt(i + 1, 1, length, names, { root: labels[i] }));
/** The chords of a whole progression squeezed into bar 1, one beat each (for a quick listen). */
const quickRun = (shapes: string[][]) => shapes.flatMap((names, i) => chordAt(1, i + 1, 1, names));

// ---------------------------------------------------------------------------------------------------------------------
export const m4ChordsInTime: SubLesson = {
  id: "m4-chords-in-time",
  version: 1,
  moduleId: "m4",
  title: "Chords in time",
  summary: "Chords take turns: one plays, then the next takes over.",
  concept: "chords",
  bars: 2,
  hook: {
    headline: "Chords take turns",
    text: ["In a song, chords take turns: one chord plays, then the next one takes over.", "Press Hear it: C, then G, then A minor, then F, one chord every two beats."],
    notes: [...chordAt(1, 1, 2, C), ...chordAt(1, 3, 2, G), ...chordAt(2, 1, 2, AM), ...chordAt(2, 3, 2, F)],
  },
  watch: {
    steps: [
      { caption: "One chord, C major, fills beats 1 and 2.", notes: chordAt(1, 1, 2, C, { root: "C" }) },
      { caption: "On beat 3 the next chord, G major, takes over. The first one has stopped.", notes: [...chordAt(1, 1, 2, C, { root: "C" }), ...chordAt(1, 3, 2, G, { root: "G" })] },
      { caption: "Bar 2 carries on: A minor, then F. Four chords, two beats each.", notes: [...chordAt(1, 1, 2, C, { root: "C" }), ...chordAt(1, 3, 2, G, { root: "G" }), ...chordAt(2, 1, 2, AM, { root: "Am" }), ...chordAt(2, 3, 2, F, { root: "F" })] },
      { caption: "Chords should not overlap: when a new chord starts, the old one ends. That keeps the sound clear.", notes: [...chordAt(1, 1, 2, C), ...chordAt(1, 3, 2, G), ...chordAt(2, 1, 2, AM), ...chordAt(2, 3, 2, F)] },
    ],
  },
  tryIt: {
    instruction: "Build C major on beat 1 and G major on beat 3 of bar 1, each two beats long, so they take turns. Follow the ghost notes.",
    tips: ["Draw one chord, then select it and Duplicate, then move the copy's notes.", "Each chord ends where the next begins.", "Press Listen."],
    ghost: [...chordAt(1, 1, 2, C, { root: "C" }), ...chordAt(1, 3, 2, G, { root: "G" })],
    allowedPitchClasses: ["C", "E", "G", "B", "D"],
    check: { kind: "chordsAtTicks", chords: [atTick(cMaj, 1, 1), atTick(gMaj, 1, 3)] },
    tools,
    commands: true,
  },
  practice: {
    task: "Make four chords, two beats each, with no ghost notes: bar 1 A minor then F major, bar 2 C major then G major.",
    items: ["Bar 1, beat 1: A minor", "Bar 1, beat 3: F major", "Bar 2, beat 1: C major", "Bar 2, beat 3: G major"],
    check: { kind: "chordsAtTicks", chords: [atTick(aMin, 1, 1), atTick(fMaj, 1, 3), atTick(cMaj, 2, 1), atTick(gMaj, 2, 3)] },
    tools,
    commands: true,
    hints: {
      reminder: "Each chord lasts two beats: beats 1-2, then beats 3-4. A minor is A C E, F is F A C, C is C E G, G is G B D.",
      rows: rows(...AM, "F3", ...C, "G3", "B3", "D4"),
      answer: [...chordAt(1, 1, 2, AM), ...chordAt(1, 3, 2, F), ...chordAt(2, 1, 2, C), ...chordAt(2, 3, 2, G)],
    },
  },
  quickCheck: quick("When a new chord starts, what should the previous chord do?", ["Stop", "Get louder", "Move up an octave", "Keep ringing"], 0, "Chords take turns: when the next one starts, the previous one ends, so the two do not blur together."),
  recap: ["In a song, chords take turns over time.", "A chord lasts until the next one starts.", "Two beats per chord is a common, easy speed for changes."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m4HomeTension: SubLesson = {
  id: "m4-home-tension",
  version: 1,
  moduleId: "m4",
  title: "Home and tension",
  summary: "Some chords feel like home; others feel like they want to move.",
  concept: "chords",
  bars: 4,
  hook: {
    headline: "Home and away",
    text: ["Some chords feel like home. Others sound unfinished, as if they want to move. In C major, the C chord is home.", "Press Hear it: G (tense), then C (home), like arriving at your front door."],
    notes: [...chordAt(1, 1, 2, G), ...chordAt(1, 3, 2, C)],
  },
  watch: {
    steps: [
      { caption: "C major is the home chord of C major, called I (one). It sounds settled, like the end of a sentence.", notes: chordAt(1, 1, 2, C, { root: "I" }) },
      { caption: "G major, called V (five), sounds unfinished, as if it is asking a question.", notes: chordAt(1, 1, 2, G, { root: "V" }) },
      { caption: "Play G, then C, and the question is answered: tension, then home.", notes: [...chordAt(1, 1, 2, G, { root: "V" }), ...chordAt(1, 3, 2, C, { root: "I" })] },
      { caption: "Songs travel away from home and come back. Ending on C makes a phrase feel finished.", notes: quickRun([C, F, G, C]) },
    ],
  },
  tryIt: {
    instruction: "Bar 1 has G major: the tense chord. Answer it: build C major, the home chord, on beat 1 of bar 2. Follow the ghost notes.",
    tips: ["C major is C, E, G.", "Press Listen to hear tension, then home.", "A red note is not in G or C."],
    starter: chordAt(1, 1, 2, G),
    ghost: [...chordAt(1, 1, 2, G), ...chordAt(2, 1, 2, C, { root: "I" })],
    allowedPitchClasses: ["G", "B", "D", "C", "E"],
    check: { kind: "chordsPerBar", chords: [gMaj, cMaj] },
    tools,
    commands: true,
  },
  practice: {
    task: "Bars 1 to 3 are written: C, F, G. Finish the phrase: build the chord that sounds like home on beat 1 of bar 4.",
    items: ["Bar 1: C", "Bar 2: F", "Bar 3: G", "Bar 4: the home chord"],
    starter: perBar([C, F, G], ["", "", ""]).map(({ pitch, startTick, durationTicks }) => ({ pitch, startTick, durationTicks })),
    check: { kind: "chordsPerBar", chords: [cMaj, fMaj, gMaj, cMaj] },
    tools,
    commands: true,
    hints: {
      reminder: "In C major the home chord is the one the key is named after.",
      rows: rows(...C),
      answer: [...perBar([C, F, G], ["", "", ""]).map(({ pitch, startTick, durationTicks }) => ({ pitch, startTick, durationTicks })), ...chordAt(4, 1, 2, C)],
    },
  },
  quickCheck: quick("In C major, which chord sounds like home?", ["C", "G", "F", "Dm"], 0, "The chord on degree 1, C major, is home in C major. G (V) is the most tense and pulls back to it."),
  recap: ["The I chord (C in C major) is home: it sounds settled.", "The V chord (G in C major) is tense: it pulls back home.", "Ending a phrase on I makes it sound finished."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m4IVviIV: SubLesson = {
  id: "m4-i-v-vi-iv",
  version: 1,
  moduleId: "m4",
  title: "I–V–vi–IV",
  summary: "The four-chord pattern behind thousands of pop songs.",
  concept: "chords",
  bars: 4,
  hook: {
    headline: "The four-chord song",
    text: ["One progression appears in thousands of pop songs: I – V – vi – IV. In C major that is C, G, A minor, F.", "The numbers are scale degrees. Capital letters mean major, small letters mean minor."],
    notes: quickRun([C, G, AM, F]),
  },
  watch: {
    steps: [
      { caption: "I is the chord on degree 1. In C major that is C. Home.", notes: chordAt(1, 1, 2, C, { root: "I" }) },
      { caption: "V is the chord on degree 5: G major.", notes: [...chordAt(1, 1, 2, C, { root: "I" }), ...chordAt(1, 3, 2, G, { root: "V" })] },
      { caption: "vi, in small letters because it is minor, is on degree 6: A minor. IV is on degree 4: F major.", notes: [...chordAt(1, 1, 2, C, { root: "I" }), ...chordAt(1, 3, 2, G, { root: "V" }), ...chordAt(2, 1, 2, AM, { root: "vi" }), ...chordAt(2, 3, 2, F, { root: "IV" })] },
      { caption: "I – V – vi – IV, then round again. Listen to how F leads back to C at the start.", notes: [...chordAt(1, 1, 2, C), ...chordAt(1, 3, 2, G), ...chordAt(2, 1, 2, AM), ...chordAt(2, 3, 2, F)] },
    ],
  },
  tryIt: {
    instruction: "Build I – V – vi – IV in C major: C, G, A minor, F, one chord per bar on beat 1. Follow the ghost notes.",
    tips: ["All four chords use only white keys.", "Draw one chord, copy it to the next bar, then move its notes.", "Press Listen: you will probably recognise it."],
    ghost: perBar([C, G, AM, F], ["I", "V", "vi", "IV"]),
    allowedPitchClasses: WHITE,
    check: { kind: "chordsPerBar", chords: [cMaj, gMaj, aMin, fMaj] },
    tools,
    commands: true,
  },
  practice: {
    task: "The same pattern in G major, with no ghost notes: I – V – vi – IV is G, D, E minor, C. Build one chord per bar on beat 1.",
    items: ["Bar 1: I = G", "Bar 2: V = D", "Bar 3: vi = Em", "Bar 4: IV = C"],
    check: { kind: "chordsPerBar", chords: [gMaj, dMaj, eMin, cMaj] },
    tools,
    commands: true,
    hints: {
      reminder: "In G major: I = G (G B D), V = D (D F# A), vi = E minor (E G B), IV = C (C E G). D major needs the black key F#.",
      rows: rows(...G, ...D, ...EM, ...C),
      answer: [...chordAt(1, 1, 2, G), ...chordAt(2, 1, 2, D), ...chordAt(3, 1, 2, EM), ...chordAt(4, 1, 2, C)],
    },
  },
  quickCheck: quick("In C major, I – V – vi – IV is…", ["C, G, Am, F", "C, F, G, C", "Am, F, C, G", "C, Dm, Em, F"], 0, "Count the degrees of C major: I = C, V = G, vi = A minor, IV = F."),
  recap: ["I – V – vi – IV is the 'four-chord song' progression.", "In C major: C, G, Am, F. In G major: G, D, Em, C.", "Roman numerals are degrees: capitals are major, small letters are minor."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m4OtherClassics: SubLesson = {
  id: "m4-other-classics",
  version: 1,
  moduleId: "m4",
  title: "Other classics",
  summary: "I–IV–V–I, vi–IV–I–V and I–vi–IV–V: more patterns you will hear everywhere.",
  concept: "chords",
  bars: 4,
  hook: {
    headline: "More famous patterns",
    text: ["A few other progressions turn up again and again.", "I – IV – V – I (C, F, G, C) is the classic folk and rock-and-roll pattern. vi – IV – I – V (Am, F, C, G) sounds more emotional."],
    notes: quickRun([C, F, G, C]),
  },
  watch: {
    steps: [
      { caption: "I – IV – V – I: C, F, G, C. Away from home, then back.", notes: [...chordAt(1, 1, 2, C, { root: "I" }), ...chordAt(1, 3, 2, F, { root: "IV" }), ...chordAt(2, 1, 2, G, { root: "V" }), ...chordAt(2, 3, 2, C, { root: "I" })] },
      { caption: "vi – IV – I – V: A minor, F, C, G. The same chords as the four-chord song, but starting on the minor one.", notes: [...chordAt(1, 1, 2, AM, { root: "vi" }), ...chordAt(1, 3, 2, F, { root: "IV" }), ...chordAt(2, 1, 2, C, { root: "I" }), ...chordAt(2, 3, 2, G, { root: "V" })] },
      { caption: "I – vi – IV – V: C, A minor, F, G. The 1950s doo-wop sound.", notes: [...chordAt(1, 1, 2, C, { root: "I" }), ...chordAt(1, 3, 2, AM, { root: "vi" }), ...chordAt(2, 1, 2, F, { root: "IV" }), ...chordAt(2, 3, 2, G, { root: "V" })] },
      { caption: "They all use chords from the same key, which is why they always fit together.", notes: quickRun([C, AM, F, G]) },
    ],
  },
  tryIt: {
    instruction: "Build I – IV – V – I in C major: C, F, G, C, one chord per bar on beat 1. Follow the ghost notes.",
    tips: ["I = C, IV = F, V = G.", "Only white keys.", "Press Listen."],
    ghost: perBar([C, F, G, C], ["I", "IV", "V", "I"]),
    allowedPitchClasses: WHITE,
    check: { kind: "chordsPerBar", chords: [cMaj, fMaj, gMaj, cMaj] },
    tools,
    commands: true,
  },
  practice: {
    task: "Build vi – IV – I – V in C major, one chord per bar on beat 1, with no ghost notes. Work out each chord from its number: vi is the minor chord on degree 6.",
    items: ["Bar 1: vi", "Bar 2: IV", "Bar 3: I", "Bar 4: V"],
    check: { kind: "chordsPerBar", chords: [aMin, fMaj, cMaj, gMaj] },
    tools,
    commands: true,
    hints: {
      reminder: "Count the C major scale: 1 = C, 4 = F, 5 = G, 6 = A. So vi – IV – I – V is A minor, F, C, G.",
      rows: rows(...AM, "F3", ...C, "G3", "B3", "D4"),
      answer: [...chordAt(1, 1, 2, AM), ...chordAt(2, 1, 2, F), ...chordAt(3, 1, 2, C), ...chordAt(4, 1, 2, G)],
    },
  },
  quickCheck: quick("Which is the classic I – IV – V – I in C major?", ["C, F, G, C", "C, G, Am, F", "Am, F, C, G", "C, Am, F, G"], 0, "I = C, IV = F, V = G, then back to I = C."),
  recap: ["I – IV – V – I: C, F, G, C (folk and rock-and-roll).", "vi – IV – I – V: Am, F, C, G (emotional pop).", "I – vi – IV – V: C, Am, F, G (1950s doo-wop)."],
};

// ---------------------------------------------------------------------------------------------------------------------
export const m4YourOwn: SubLesson = {
  id: "m4-your-own",
  version: 1,
  moduleId: "m4",
  title: "Your own progression",
  summary: "Choose your own chords from the key: start at home, travel, come home.",
  concept: "chords",
  bars: 4,
  hook: {
    headline: "Write your own",
    text: ["You know the chords of C major: C, Dm, Em, F, G and Am. Now you choose the order.", "Start at home on C, travel anywhere in the key, and come back home to C at the end."],
    notes: quickRun([C, AM, G, C]),
  },
  watch: {
    steps: [
      { caption: "Rule 1: start on C, the home chord.", notes: chordAt(1, 1, 2, C, { root: "C" }) },
      { caption: "Rule 2: in the middle, pick any chords from C major. Each change should go somewhere new.", notes: [...chordAt(1, 1, 1, C), ...chordAt(1, 2, 1, F), ...chordAt(1, 3, 1, G)] },
      { caption: "Rule 3: come home to C at the end. Having G just before C makes the ending feel strong.", notes: quickRun([C, F, G, C]) },
      { caption: "There is no single right answer. Try a different middle, such as Em and F, and listen.", notes: quickRun([C, EM, F, C]) },
    ],
  },
  tryIt: {
    instruction: "Bars 1 and 4 are C. Choose the middle: put F or G in bar 2 and the other one in bar 3. The ghost notes show one choice (F, then G).",
    tips: ["F is F A C; G is G B D.", "Try both orders and listen.", "Only white keys."],
    starter: [...chordAt(1, 1, 2, C), ...chordAt(4, 1, 2, C)],
    ghost: [...chordAt(1, 1, 2, C), ...chordAt(2, 1, 2, F, { root: "F" }), ...chordAt(3, 1, 2, G, { root: "G" }), ...chordAt(4, 1, 2, C)],
    allowedPitchClasses: WHITE,
    check: { kind: "chordSet", bars: 4, allowed: [cMaj, fMaj, gMaj], first: "C major", last: "C major", noAdjacentRepeat: true },
    tools,
    commands: true,
  },
  practice: {
    task: "Write your own 4-chord progression, one chord per bar on beat 1: start on C, end on C, use any chords from C major (C, Dm, Em, F, G, Am), and never the same chord twice in a row.",
    items: ["Bar 1: C", "Bars 2-3: your choice", "Bar 4: C", "No chord twice in a row"],
    check: { kind: "chordSet", bars: 4, allowed: [cMaj, dMin, eMin, fMaj, gMaj, aMin], first: "C major", last: "C major", noAdjacentRepeat: true },
    tools,
    commands: true,
    hints: {
      reminder: "Start and end on C. In bars 2 and 3 use any of C, Dm, Em, F, G, Am, but never the same chord twice in a row.",
      rows: rows(...C, ...AM, ...G),
      answer: [...chordAt(1, 1, 2, C), ...chordAt(2, 1, 2, AM), ...chordAt(3, 1, 2, G), ...chordAt(4, 1, 2, C)],
      texts: [
        "Start and end on C. In bars 2 and 3 use any of C, Dm, Em, F, G, Am, but never the same chord twice in a row.",
        "Build each chord with white keys only: start on its letter, skip one white key, take the next, twice. The highlighted rows show one possible choice.",
        "One possible answer is shown as ghost notes: C, Am, G, C. Yours can be different.",
      ],
    },
  },
  quickCheck: quick("Why end a progression on the home chord?", ["It makes it sound finished", "It makes it louder", "It makes it faster", "The piano roll requires it"], 0, "Coming back to I (C in C major) resolves the tension, so the progression sounds complete."),
  recap: ["Start on the home chord, travel through the key, come back home.", "Any chords from the key fit together.", "G (V) right before C (I) makes a strong ending."],
};

// ---------------------------------------------------------------------------------------------------------------------
const HITS = (bar: number, names: string[]) => [...chordAt(bar, 1, 1, names), ...chordAt(bar, 3, 1, names)];
const plainNotes = (notes: ReturnType<typeof chordAt>) => notes.map(({ pitch, startTick, durationTicks }) => ({ pitch, startTick, durationTicks }));

export const m4RhythmBass: SubLesson = {
  id: "m4-rhythm-bass",
  version: 1,
  moduleId: "m4",
  title: "Rhythm and a bass note",
  summary: "Play chords in a rhythm and add a low bass note under them.",
  concept: "chords",
  bars: 2,
  hook: {
    headline: "Rhythm and a bass note",
    text: ["A chord does not have to be one long block. Play it in a rhythm, and add a low bass note underneath.", "Press Hear it: a bass note on beat 1, with the chord hitting on beats 1 and 3."],
    notes: [g("C3", 1, 1, 4), ...HITS(1, C)],
  },
  watch: {
    steps: [
      { caption: "Here is C major as one long block of sound, four beats long.", notes: chordAt(1, 1, 4, C) },
      { caption: "Cut it into short hits on beats 1 and 3, and the chord gets a rhythm.", notes: HITS(1, C) },
      { caption: "Now add the root, C, low down as a bass note. It holds the music up from below.", notes: [g("C3", 1, 1, 4, { root: true, label: "bass" }), ...HITS(1, C)] },
      { caption: "For each chord the bass plays that chord's root: under G major, a low G.", notes: [g("C3", 1, 1, 4, { root: true, label: "bass" }), ...HITS(1, C), g("G2", 2, 1, 4, { root: true, label: "bass" }), ...HITS(2, G)] },
    ],
  },
  tryIt: {
    instruction: "Turn the long C chord into two hits: one on beat 1 and one on beat 3, each one beat long. Follow the ghost notes.",
    tips: ["Shorten the chord by dragging its notes' right edges, then Duplicate to beat 3.", "Or delete it and draw the hits.", "Press Listen to hear the rhythm."],
    starter: chordAt(1, 1, 4, C),
    ghost: HITS(1, C),
    allowedPitchClasses: ["C", "E", "G"],
    check: {
      kind: "slots",
      extra: "fail",
      slots: [1, 3].flatMap((beat) => C.map((name) => slotAt(`${name} on beat ${beat}, one beat long`, 1, beat, { exact: name, len: 1 }))),
    },
    tools,
    commands: true,
  },
  practice: {
    task: "The chord hits are written: C in bar 1, G in bar 2. Add a bass note under each bar: the chord's root, low down (C3 or lower), on beat 1, lasting the whole bar.",
    items: ["Bar 1: the root of C, low, whole bar", "Bar 2: the root of G, low, whole bar"],
    starter: plainNotes([...HITS(1, C), ...HITS(2, G)]),
    check: {
      kind: "slots",
      extra: "allow",
      slots: [slotAt("a low C (C3 or lower) for the whole of bar 1", 1, 1, { names: ["C"], max: "C3", lenMin: 3 }), slotAt("a low G (C3 or lower) for the whole of bar 2", 2, 1, { names: ["G"], max: "C3", lenMin: 3 })],
    },
    tools,
    commands: true,
    hints: {
      reminder: "The bass plays the root of each chord, far below it: C under C major, G under G major. Make each bass note last the whole bar.",
      rows: rows("C3", "G2"),
      answer: [g("C3", 1, 1, 4), g("G2", 2, 1, 4)],
    },
  },
  quickCheck: quick("Which note does the bass usually play under a chord?", ["The root of the chord", "The highest note", "Any black key", "A note from the next chord"], 0, "The bass usually plays the chord's root, low down, which makes the chord sound solid."),
  recap: ["Chords can be played in a rhythm, not just as long blocks.", "A bass note plays the chord's root, low down.", "Bass + rhythm turns a chord list into a groove."],
};

export const M4: SubLesson[] = [m4ChordsInTime, m4HomeTension, m4IVviIV, m4OtherClassics, m4YourOwn, m4RhythmBass];
