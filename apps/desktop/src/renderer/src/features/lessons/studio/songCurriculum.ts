import { PHRASES } from "./songParts";
import type { SeqSetup, SongSpec, StudioLesson, StudioModule } from "./types";

/**
 * The song-making lessons (docs/lessons/SONG-WORKFLOW-GAPS.md), taught on one song: Am - F - C - G, one chord per bar,
 * 4-bar clips, 124 BPM. They are placed in the courses where they belong (courses.ts): piano roll ones in Piano (L5-L7),
 * drum ones in Drum sequencer, arranging ones in Kick Drums, mixing ones in Mixing. Ids M30.x-M40.x.
 */

type Parts = SongSpec["song"]["parts"];
const song = (bars: number, parts: Parts, extra: Omit<SongSpec["song"], "bars" | "parts"> = {}): SongSpec => ({ song: { bars, parts, ...extra } });
const seq = (bars: number, hits: SeqSetup["seq"]["hits"] = []): SeqSetup => ({ seq: { bars, hits } });
const pads = (pitch: number, list: number[]) => list.map((pad) => ({ pitch, pad }));
const FOUR = [1, 5, 9, 13];
const OFF = [3, 7, 11, 15];
const ALL: string[] = ["piano", "pads", "kick", "hats", "clap", "bass", "arp", "melody"];

/** Where each part plays in the finished song (intro 1-16, arp section 17-32, build-up 33-64, drop 65-96, outro 97-112). */
const INTRO: Parts = { piano: [[1, 16]], pads: [[1, 16]], kick: [[9, 16]], bass: [[9, 16]] };
const ARP_SECTION: Parts = { piano: [[1, 32]], pads: [[1, 32]], kick: [[9, 32]], bass: [[9, 32]], hats: [[17, 32]], clap: [[17, 32]], arp: [[17, 32]] };
const TO_48: Parts = { piano: [[1, 48]], pads: [[1, 48]], kick: [[9, 48]], bass: [[9, 48]], hats: [[17, 48]], clap: [[17, 48]], arp: [[17, 48]] };
const BUILD: Parts = { piano: [[1, 64]], pads: [[1, 64]], kick: [[9, 32]], bass: [[9, 32]], hats: [[17, 32]], clap: [[17, 32]], arp: [[17, 32]] };
const FULL: Parts = { piano: [[1, 112]], pads: [[1, 112]], kick: [[9, 32], [49, 112]], bass: [[9, 32], [65, 112]], hats: [[17, 32], [65, 112]], clap: [[17, 32], [65, 112]], arp: [[17, 32], [65, 112]], melody: [[65, 112]] };
const DROP_LOOP: Parts = { piano: [[1, 8]], pads: [[1, 8]], kick: [[1, 8]], hats: [[1, 8]], clap: [[1, 8]], bass: [[1, 8]], arp: [[1, 8]], melody: [[1, 8]] };

/** A phrase as listening notes (beats from 1 across four bars). */
const listen = (phrase: [number, number, number, number][]) => phrase.map(([bar, beat, beats, pitch]) => ({ pitch, beat: (bar - 1) * 4 + beat, beats }));
const UNSETTLED_EXAMPLE: [number, number, number, number][] = [...PHRASES.A.slice(0, 8), [4, 1.5, 3.5, 69]];

const UNIT0: StudioLesson[] = [
  {
    id: "M30.1",
    moduleId: "u0",
    title: "Tour the DAW and set up the song project",
    summary: "Transport, BPM, arrangement, piano roll and mixer: where everything is.",
    hook: {
      headline: "One project, one song",
      text: "Every course ends with a Special task that builds one part of the same song. First, find your way around: the transport plays, stops and loops; the BPM box sets the speed; the arrangement holds tracks and clips; the piano roll edits notes; the mixer sets each part's level.",
    },
    watch: {
      setup: "loop",
      steps: [
        { caption: "The transport: Play starts the song, Stop ends it, Loop repeats a part while you work." },
        { caption: "The BPM box sets the tempo. This song will run at 124 BPM, a dance tempo." },
        { caption: "The arrangement: tracks run left to right in bars; each coloured block is a clip.", bars: [1, 2] },
        { caption: "Select a clip to edit its notes in the piano roll. The mixer balances the tracks." },
      ],
    },
    tryIt: { instruction: "Set the BPM to 124.", setup: "loop", check: { kind: "tempo", bpm: 124 } },
    practice: {
      instruction: "Set the BPM to 124, turn on Loop and press Play.",
      setup: "loop",
      tools: ["loop"],
      check: { kind: "tempoLoop", bpm: 124 },
      confirm: ["I pressed Play and heard the loop"],
      hints: ["The BPM box is at the top of the workspace: type 124 and press Enter.", "The Loop button is next to Grid.", "Press ▶, listen, then tick the box."],
    },
    quick: { question: "What does the BPM box set?", options: ["The volume", "The tempo (speed) of the song", "The key", "The song length"], correct: 1, explanation: "BPM is beats per minute: the song's speed." },
    recap: ["The transport plays, stops and loops.", "BPM sets the song's speed (124 here).", "Tracks hold clips; clips hold notes."],
  },
];

const UNIT1: StudioLesson[] = [
  {
    id: "M31.3",
    moduleId: "u1",
    title: "Repeat and transpose the progression",
    summary: "Four bars become sixteen; move the whole progression by an octave.",
    hook: {
      headline: "Write it once, use it four times",
      text: "A 4-chord progression is one 4-bar clip. Repeat it four times and you have 16 bars, the length of the intro. If it sounds too low, move every note up an octave at once (Octave ↑; Transpose in the DAW's piano roll does the same); Octave ↓ brings it back.",
    },
    watch: {
      setup: song(16, { piano: [[1, 4]] }),
      steps: [
        { caption: "The progression Am - F - C - G is one clip: bars 1-4.", bars: [1, 4] },
        { caption: "Duplicate (Ctrl+D) puts a copy right after it: bars 5-8. Twice more and it fills 16 bars.", targets: [{ bar: 5, beats: 48, label: "repeat" }] },
        { caption: "Octave ↑ moves every note of the clip up 12 semitones: same chords, higher. Octave ↓ moves them back." },
      ],
    },
    tryIt: { instruction: "Duplicate the clip once so the progression plays twice (bars 1-8).", setup: song(16, { piano: [[1, 4]] }), tools: ["octave"], check: { kind: "repeated", bars: [1, 8] }, targets: [{ bar: 5, beats: 16, label: "copy" }] },
    practice: {
      instruction: "Repeat the progression to 16 bars, then shift a clip up an octave and back.",
      setup: song(16, { piano: [[1, 4]] }),
      tools: ["octave"],
      check: { kind: "repeated", bars: [1, 16] },
      confirm: ["I moved it up an octave, listened, and moved it back"],
      targets: [{ bar: 1, beats: 64, label: "16 bars" }],
      hints: ["Select the clip and press Duplicate (Ctrl+D) three times.", "Octave ↑ and Octave ↓ are in the tools bar under the arrangement.", "Each copy lands right after the last one: bars 5, 9 and 13."],
    },
    quick: { question: "How many semitones is one octave?", options: ["7", "8", "12", "16"], correct: 2, explanation: "An octave is 12 semitones: the same note names, higher or lower." },
    recap: ["Duplicate repeats a clip right after itself.", "Four repeats of 4 bars make 16 bars.", "Octave up / down moves every note by 12 semitones."],
  },
  {
    id: "M31.4",
    moduleId: "u1",
    title: "Layer the chords on pads or strings",
    summary: "The same chords on a second instrument sound fuller.",
    hook: { headline: "Two instruments, one progression", text: "Copy the piano's chords onto a pad or strings track and play both together. The notes are the same; the sound gets fuller and wider. MIDI notes can be reused on any instrument." },
    watch: {
      setup: song(16, { piano: [[1, 16]] }),
      steps: [
        { caption: "The piano plays the progression for 16 bars.", bars: [1, 16] },
        { caption: "Add a Pads track (+ Add track), then select a piano clip and Copy it to the Pads track.", targets: [{ bar: 1, beats: 16, label: "copy" }] },
        { caption: "Piano alone, then piano plus pads: listen to the difference." },
      ],
    },
    tryIt: { instruction: "Add a Pads track and copy the first piano clip (bars 1-4) onto it.", setup: song(16, { piano: [[1, 16]] }), tools: ["addTrack", "copyToTrack"], check: { kind: "layered", bars: [1, 4] } },
    practice: {
      instruction: "Layer the whole progression (bars 1-16) on the pads, then compare piano alone with piano plus pads.",
      setup: song(16, { piano: [[1, 16]] }),
      tools: ["addTrack", "copyToTrack"],
      check: { kind: "layered", bars: [1, 16] },
      confirm: ["I listened to piano alone and piano plus pads"],
      hints: ["+ Add track… → Pads.", "Select a piano clip, choose the Pads track in Copy to track…, press Copy. Do it for all four clips.", "Mute the pads (M) to hear the piano alone, then unmute."],
    },
    quick: { question: "Why layer chords on pads?", options: ["To change the key", "To make the chords sound fuller", "To make the song faster", "To remove the piano"], correct: 1, explanation: "Two sounds playing the same notes make a fuller, wider chord." },
    recap: ["The same notes can play on any instrument.", "Copy to track reuses a clip on another track.", "Piano plus pads sounds fuller than piano alone."],
  },
];

const UNIT2: StudioLesson[] = [
  {
    id: "M32.2",
    moduleId: "u2",
    space: "sequencer",
    title: "Hi-hats between the kicks",
    summary: "Off-beat hats give the groove its bounce.",
    hook: { headline: "Kick, hat, kick, hat", text: "Put a closed hat in the middle of each kick: on the 'and' of every beat. Those are pads 3, 7, 11 and 15. Kick plus off-beat hats is the bounce of house music.", pattern: [{ pitch: 36, pads: FOUR }, { pitch: 42, pads: OFF }] },
    watch: {
      steps: [
        { caption: "Four on the floor: kicks on pads 1, 5, 9 and 13.", pads: [{ pitch: 36, pads: FOUR }] },
        { caption: "The hat goes halfway between two kicks: pad 3.", pads: [{ pitch: 36, pads: FOUR }, { pitch: 42, pads: [3] }] },
        { caption: "And between every pair: pads 3, 7, 11 and 15.", pads: [{ pitch: 36, pads: FOUR }, { pitch: 42, pads: OFF }] },
      ],
    },
    tryIt: { instruction: "Add closed hats on pads 3 and 7.", setup: seq(1, pads(36, FOUR)), check: { kind: "pattern", rows: [{ pitch: 42, pads: [3, 7], name: "Closed hat" }] } },
    practice: {
      instruction: "Add hats on the 'and' of each beat and play kick plus hats together.",
      setup: seq(1, pads(36, FOUR)),
      check: { kind: "pattern", rows: [{ pitch: 36, pads: FOUR, name: "Kick", exact: true }, { pitch: 42, pads: OFF, name: "Closed hat", exact: true }] },
      confirm: ["I played kick and hats together"],
      hints: ["The Closed Hat row is under the snares and claps.", "Hats go on pads 3, 7, 11 and 15.", "Keep the kicks on 1, 5, 9 and 13."],
    },
    quick: { question: "Where do off-beat hats go?", options: ["On every kick", "Between the kicks (the 'and' of each beat)", "Only on beat 1", "On pad 16 only"], correct: 1, explanation: "Off-beat hats sit halfway between the kicks: pads 3, 7, 11, 15." },
    recap: ["Off-beat hats sit between the kicks.", "That is pads 3, 7, 11 and 15.", "Kick plus off-beat hats gives the bounce."],
  },
  {
    id: "M32.3",
    moduleId: "u2",
    space: "sequencer",
    title: "Clap on every second kick",
    summary: "A clap on beats 2 and 4 completes the beat.",
    hook: { headline: "The backbeat", text: "Layer a clap with every second kick: beats 2 and 4, pads 5 and 13. Kick, hats and clap together are the complete basic beat of the song.", pattern: [{ pitch: 36, pads: FOUR }, { pitch: 42, pads: OFF }, { pitch: 39, pads: [5, 13] }] },
    watch: {
      steps: [
        { caption: "Kick and hats from the last lesson.", pads: [{ pitch: 36, pads: FOUR }, { pitch: 42, pads: OFF }] },
        { caption: "The clap joins the kick on beat 2 (pad 5)…", pads: [{ pitch: 36, pads: FOUR }, { pitch: 42, pads: OFF }, { pitch: 39, pads: [5] }] },
        { caption: "…and on beat 4 (pad 13).", pads: [{ pitch: 36, pads: FOUR }, { pitch: 42, pads: OFF }, { pitch: 39, pads: [5, 13] }] },
      ],
    },
    tryIt: { instruction: "Add a clap on pad 5 (beat 2).", setup: seq(1, [...pads(36, FOUR), ...pads(42, OFF)]), check: { kind: "pattern", rows: [{ pitch: 39, pads: [5], name: "Clap" }] } },
    practice: {
      instruction: "Add claps on beats 2 and 4 so kick, hats and clap make the full beat.",
      setup: seq(1, [...pads(36, FOUR), ...pads(42, OFF)]),
      check: { kind: "pattern", rows: [{ pitch: 36, pads: FOUR, name: "Kick", exact: true }, { pitch: 42, pads: OFF, name: "Closed hat", exact: true }, { pitch: 39, pads: [5, 13], name: "Clap", exact: true }] },
      hints: ["The Clap row is just under the snares.", "Beats 2 and 4 are pads 5 and 13.", "The kicks stay on those pads too: the clap layers on top."],
    },
    quick: { question: "Which beats get the clap?", options: ["1 and 3", "2 and 4", "Every beat", "Only 4"], correct: 1, explanation: "Every second kick: beats 2 and 4, the backbeat." },
    recap: ["The clap layers with every second kick.", "That is beats 2 and 4 (pads 5 and 13).", "Kick, hats and clap make the basic beat."],
  },
];

const UNIT3: StudioLesson[] = [
  {
    id: "M33.1",
    moduleId: "u3",
    title: "Clips, tracks and sections",
    summary: "A song is sections made of clips.",
    hook: { headline: "Clips are building blocks", text: "A clip is a container of notes on a track. A song is built by placing clips in sections (intro, build-up, drop, outro) and adding elements as it moves on. This song has five sections over 112 bars." },
    watch: {
      setup: song(112, FULL),
      steps: [
        { caption: "Intro (bars 1-16): piano and pads, then the kick and bass join at bar 9.", bars: [1, 16] },
        { caption: "Arp section (17-32): hats, clap and an arpeggio add movement.", bars: [17, 32] },
        { caption: "Build-up (33-64): strip back, filter, then build into the drop.", bars: [33, 64] },
        { caption: "Drop (65-96): everything plus the melody. Outro (97-112): elements leave one by one.", bars: [65, 112] },
      ],
    },
    tryIt: {
      instruction: "Match each description to its section.",
      labels: {
        sections: [
          { bars: "Piano and pads only", energy: 1, answer: "Intro" },
          { bars: "Everything plus the melody", energy: 5, answer: "Drop" },
          { bars: "Two elements, filter closed", energy: 2, answer: "Build-up" },
          { bars: "Elements leave one by one", energy: 1, answer: "Outro" },
        ],
        options: ["Intro", "Arp section", "Build-up", "Drop", "Outro"],
      },
    },
    practice: {
      instruction: "Put the five sections of the song in order.",
      labels: {
        sections: [
          { bars: "1st (bars 1-16)", energy: 2, answer: "Intro" },
          { bars: "2nd (bars 17-32)", energy: 3, answer: "Arp section" },
          { bars: "3rd (bars 33-64)", energy: 3, answer: "Build-up" },
          { bars: "4th (bars 65-96)", energy: 5, answer: "Drop" },
          { bars: "5th (bars 97-112)", energy: 1, answer: "Outro" },
        ],
        options: ["Intro", "Arp section", "Build-up", "Drop", "Outro"],
      },
      hints: ["The song starts quietly and ends quietly.", "The build-up comes right before the drop.", "The arp section follows the intro."],
    },
    quick: { question: "What is a clip?", options: ["A whole song", "A container of notes on a track", "A mixer channel", "An effect"], correct: 1, explanation: "Clips hold notes; songs are clips placed in sections." },
    recap: ["A clip is a container of notes on a track.", "A song is sections made of clips.", "Elements are added as the song moves on."],
  },
  {
    id: "M33.2",
    moduleId: "u3",
    title: "Build the 16-bar intro",
    summary: "Bars 1-8 piano and pads; bars 9-16 add the kick.",
    hook: { headline: "Add an element halfway", text: "The intro is four clips (16 bars). Clips 1 and 2 (bars 1-8) are piano and pads only; clips 3 and 4 (bars 9-16) add the kick. Adding one element in the second half creates energy." },
    watch: {
      setup: song(16, { piano: [[1, 16]], pads: [[1, 16]], kick: [[9, 16]] }),
      steps: [
        { caption: "Bars 1-8: piano and pads only.", bars: [1, 8] },
        { caption: "Bars 9-16: the kick joins.", bars: [9, 16] },
        { caption: "Same chords, more energy, just by adding one element." },
      ],
    },
    tryIt: { instruction: "Move the kick clip so it starts on bar 9.", setup: song(16, { piano: [[1, 16]], pads: [[1, 16]], kick: [[1, 4]] }), check: { kind: "intro", quiet: [1, 8], loud: [9, 12] }, targets: [{ bar: 9, beats: 16, label: "kick here" }] },
    practice: {
      instruction: "Arrange the intro: no kick in bars 1-8, the kick in every bar 9-16.",
      setup: song(16, { piano: [[1, 16]], pads: [[1, 16]], kick: [[1, 4]] }),
      check: { kind: "intro", quiet: [1, 8], loud: [9, 16] },
      targets: [{ bar: 9, beats: 32, label: "kick" }],
      hints: ["Drag the kick clip to bar 9.", "Then Duplicate it so a copy fills bars 13-16.", "Bars 1-8 must have no kick at all."],
    },
    quick: { question: "Why does the kick enter at bar 9?", options: ["To change the key", "To add energy in the second half", "Because the song ends there", "To slow the song down"], correct: 1, explanation: "Adding an element halfway lifts the energy." },
    recap: ["The intro is 16 bars: four 4-bar clips.", "Bars 1-8: piano and pads.", "Bars 9-16: the kick adds energy."],
  },
];

const UNIT4: StudioLesson[] = [
  {
    id: "M34.1",
    moduleId: "u4",
    title: "Sweep up into the kick",
    summary: "A build-up sweep that ends exactly where the kick hits.",
    hook: { headline: "Lead the ear in", text: "When a new element arrives, a transition prepares the listener. A build-up sweep (the Exhaust sweep: here a Riser or Sweep Up) rises and ends exactly where the kick hits, on bar 9.", sounds: [{ category: "FX", sub: "Riser", label: "riser" }] },
    watch: {
      setup: song(16, INTRO),
      steps: [
        { caption: "The kick enters on bar 9.", bars: [9, 9] },
        { caption: "A Riser placed in bars 7-8 rises into it…", sound: { category: "FX", sub: "Riser", label: "riser" }, targets: [{ bar: 7, beats: 8, label: "sweep" }] },
        { caption: "…and ends exactly on bar 9. Listen with and without it." },
      ],
    },
    tryIt: { instruction: "Drop a Riser from FX somewhere in bars 5-8.", setup: song(16, INTRO), check: { kind: "riser", bars: [5, 8] }, targets: [{ bar: 5, beats: 16, label: "riser" }] },
    practice: {
      instruction: "Place the sweep so it ends exactly on bar 9, then listen with and without it.",
      setup: song(16, INTRO),
      check: { kind: "transition", bar: 9, type: "into" },
      confirm: ["I listened with and without the sweep"],
      targets: [{ bar: 7, beats: 8, label: "ends on 9" }],
      hints: ["Choose FX in the sounds list: a Riser (or Sweep Up).", "A Riser 2s is exactly 2 bars at 124 BPM: drop it on bar 7.", "Mute it (M) to hear without it, then unmute."],
    },
    quick: { question: "Where should the sweep end?", options: ["Anywhere", "Exactly where the new element starts", "At the end of the song", "On beat 3"], correct: 1, explanation: "The sweep leads into the hit, so it ends on it." },
    recap: ["A new element needs a transition.", "A build-up sweep rises into it.", "It ends exactly on the bar where the element starts."],
  },
  {
    id: "M34.2",
    moduleId: "u4",
    title: "Down filter after the kick",
    summary: "The second half of the pair: a down sweep right after the hit.",
    hook: { headline: "Up, then down", text: "Right after the kick hits, a down filter (the Exhaust down filter: here a Downlifter or Sweep Down) falls away, so the change feels smooth. Up into the hit, down after it: you will reuse this pair at bars 17, 33 and 65.", sounds: [{ category: "FX", sub: "Downlifter", label: "downlifter" }] },
    watch: {
      setup: song(16, INTRO),
      steps: [
        { caption: "The sweep rises into bar 9.", targets: [{ bar: 7, beats: 8, label: "up" }] },
        { caption: "A Downlifter starts on bar 9, right on the hit…", sound: { category: "FX", sub: "Downlifter", label: "downlifter" }, targets: [{ bar: 9, beats: 8, label: "down" }] },
        { caption: "…and falls away while the kick settles in." },
      ],
    },
    tryIt: { instruction: "Drop a Downlifter so it starts on bar 9.", setup: song(16, INTRO), check: { kind: "transition", bar: 9, type: "after" }, targets: [{ bar: 9, beats: 8, label: "starts on 9" }] },
    practice: {
      instruction: "Make the pair: a sweep ending on bar 9 and a down filter starting on bar 9.",
      setup: song(16, INTRO),
      check: { kind: "transition", bar: 9, type: "pair" },
      targets: [{ bar: 7, beats: 16, label: "up | down" }],
      hints: ["Riser (or Sweep Up) ends on 9; Downlifter (or Sweep Down) starts on 9.", "Use the 1 bar grid so they land exactly on bar lines.", "Each FX gets its own track: drop it on the empty area."],
    },
    quick: { question: "Where does the down filter start?", options: ["Before the hit", "Right on the hit", "At the end of the song", "On every beat"], correct: 1, explanation: "Up into the hit, down right after it." },
    recap: ["The down filter starts right on the hit.", "Sweep up plus filter down is a transition pair.", "Reuse it at every section change."],
  },
];

const UNIT5: StudioLesson[] = [
  {
    id: "M35.1",
    moduleId: "u5",
    title: "Bass from the root notes",
    summary: "The bass cheat code: keep only the root of each chord, an octave or two down.",
    hook: { headline: "The bass cheat code", text: "Copy the chord progression to a bass instrument, then delete every note except the root of each chord (the note the chord is named after). Move the roots down an octave or two so they sit in the bass range. That bass always fits." },
    watch: {
      setup: song(16, { ...INTRO, bass: [[9, 16]] }, { bass: "chords" }),
      steps: [
        { caption: "The Bass track has a copy of the chords in bars 9-16.", bars: [9, 16] },
        { caption: "Am's root is A, F's is F, C's is C, G's is G: keep those, delete the rest." },
        { caption: "Octave ↓ twice puts the roots in the bass range." },
      ],
    },
    tryIt: { instruction: "In bar 9, keep only the A (delete the other two notes), then press Octave ↓ twice on that clip.", setup: song(16, { ...INTRO, bass: [[9, 16]] }, { bass: "chords" }), editNotes: true, tools: ["octave"], check: { kind: "bassRoots", bars: [9, 9] } },
    practice: {
      instruction: "Make the whole bass line in bars 9-16: one root note per bar, in the bass range.",
      setup: song(16, { ...INTRO, bass: [[9, 16]] }, { bass: "chords" }),
      editNotes: true,
      tools: ["octave"],
      check: { kind: "bassRoots", bars: [9, 16] },
      hints: ["Select a Bass clip; its notes open below.", "Keep the lowest note of each chord (A, F, C, G) and delete the other two.", "Then Octave ↓ twice on each clip."],
    },
    quick: { question: "Which note of the chord does the bass keep?", options: ["The highest", "The root (the chord's name)", "A random one", "None"], correct: 1, explanation: "The root: A for Am, F for F, C for C, G for G." },
    recap: ["Copy the chords to the bass.", "Keep only each chord's root.", "Move the roots down an octave or two."],
  },
  {
    id: "M35.2",
    moduleId: "u5",
    title: "Chop the bass with the piano roll chopper",
    summary: "Long root notes become a rhythmic bass line.",
    hook: { headline: "Cut long notes into rhythm", text: "The chopper (Alt+U in the DAW's piano roll) slices each long note into shorter ones: 1/4, 1/8 or 1/16. Eighth notes give the bass a groove that locks with the kick. Here it is the Chop tool under the arrangement." },
    watch: {
      setup: song(16, { ...INTRO, bass: [[9, 16]] }, { bass: "long" }),
      steps: [
        { caption: "The bass plays one long root per bar.", bars: [9, 12] },
        { caption: "Chop at 1/8: each bar becomes eight short roots." },
        { caption: "Try 1/4 and 1/16 too, and keep the one that grooves best with the kick." },
      ],
    },
    tryIt: { instruction: "Select the bass clip at bar 9 and Chop it at 1/8.", setup: song(16, { ...INTRO, bass: [[9, 16]] }, { bass: "long" }), tools: ["chop"], check: { kind: "bassChopped", bars: [9, 12], min: 4 } },
    practice: {
      instruction: "Chop the bass in bars 9-16 at three settings and keep the one that grooves best with the kick.",
      setup: song(16, { ...INTRO, bass: [[9, 16]] }, { bass: "long" }),
      tools: ["chop"],
      check: { kind: "bassChopped", bars: [9, 16], min: 4 },
      confirm: ["I tried 1/4, 1/8 and 1/16 and picked one"],
      hints: ["Chop is in the tools bar: pick the size, then press Chop.", "Undo (Ctrl+Z) to go back and try another size.", "Both bass clips (bars 9-12 and 13-16) need chopping."],
    },
    quick: { question: "What does the chopper do?", options: ["Deletes notes", "Cuts long notes into shorter ones", "Changes the key", "Adds reverb"], correct: 1, explanation: "It slices each long note into a rhythm of shorter notes." },
    recap: ["The chopper slices long notes.", "1/8 notes give the bass a groove.", "Pick the setting that locks with the kick."],
  },
];

const UNIT6: StudioLesson[] = [
  {
    id: "M36.1",
    moduleId: "u6",
    title: "Add an arp preset",
    summary: "Chord notes played one after another add movement.",
    hook: { headline: "Chords that ripple", text: "An arpeggio plays a chord's notes one after another instead of together. Copy the progression to a synth and apply an arp preset (Up, Down, Up-down) to give bars 17-32 movement." },
    watch: {
      setup: song(32, ARP_SECTION),
      steps: [
        { caption: "Bars 17-32 already have piano, pads, kick, bass, hats and clap.", bars: [17, 32] },
        { caption: "An Arp track gets a copy of the piano clips…" },
        { caption: "…and an arp preset turns each chord into a ripple of single notes." },
      ],
    },
    tryIt: { instruction: "Add an Arp track, copy the piano clip at bar 17 onto it, and apply an arp preset.", setup: song(32, { ...ARP_SECTION, arp: undefined }), tools: ["addTrack", "copyToTrack", "arp"], check: { kind: "arp", bars: [17, 20] } },
    practice: {
      instruction: "Try three arp presets, then place arp clips in all of bars 17-32.",
      setup: song(32, { ...ARP_SECTION, arp: undefined }),
      tools: ["addTrack", "copyToTrack", "arp"],
      check: { kind: "arp", bars: [17, 32] },
      confirm: ["I tried three arp presets"],
      hints: ["+ Add track… → Arp. Then copy each piano clip from bar 17 on onto it.", "Select an Arp clip, choose a preset and press Apply arp.", "Duplicate an arp clip to fill bars 17-32."],
    },
    quick: { question: "What is an arpeggio?", options: ["A drum fill", "Chord notes played one after another", "A very long note", "A type of filter"], correct: 1, explanation: "An arpeggio spreads a chord out in time." },
    recap: ["An arpeggio plays chord notes one by one.", "Arp presets choose the order (up, down, up-down).", "It adds movement to a section."],
  },
  {
    id: "M36.2",
    moduleId: "u6",
    title: "Close the section with a transition",
    summary: "The sweep-and-filter pair at bar 33, without help.",
    hook: { headline: "End the section cleanly", text: "At the end of the 16-bar arp section, use the transition pair from \"Down filter after the kick\" again: a sweep into bar 33 and a down filter after it." },
    watch: {
      setup: song(40, ARP_SECTION),
      steps: [
        { caption: "The arp section ends at bar 32.", bars: [29, 32] },
        { caption: "A sweep rises into bar 33…", targets: [{ bar: 31, beats: 8, label: "up" }] },
        { caption: "…and a down filter falls away after it.", targets: [{ bar: 33, beats: 8, label: "down" }] },
      ],
    },
    tryIt: { instruction: "Drop a sweep that ends exactly on bar 33.", setup: song(40, ARP_SECTION), check: { kind: "transition", bar: 33, type: "into" } },
    practice: {
      instruction: "Add the transition pair at bar 33.",
      setup: song(40, ARP_SECTION),
      check: { kind: "transition", bar: 33, type: "pair" },
      hints: ["Same as the pair at bar 9, two sections later.", "A Riser 2s (2 bars) dropped on bar 31 ends on 33.", "Downlifter starts on 33."],
    },
    quick: { question: "Where does this transition go?", options: ["Bar 1", "Bar 9", "Bar 33", "Bar 112"], correct: 2, explanation: "Bar 33 is where the arp section ends and the build-up starts." },
    recap: ["Every section change gets a transition.", "Sweep up into the bar, filter down after it.", "Here: bar 33."],
  },
];

export { UNIT0, UNIT1, UNIT2, UNIT3, UNIT4, UNIT5, UNIT6, song, ALL, BUILD, TO_48, FULL, DROP_LOOP, listen, UNSETTLED_EXAMPLE };
export type { StudioModule };
