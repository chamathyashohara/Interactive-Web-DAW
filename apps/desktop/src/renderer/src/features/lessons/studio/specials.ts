import { PPQ, TICKS_PER_BAR } from "@daw/shared";
import { PHRASES, PROGRESSION } from "./songParts";
import type { Ghost, SpecialTask } from "./types";

/**
 * The Special tasks: each course ends by building one part of the same song (Am - F - C - G, one chord per bar, 124
 * BPM), which the learner applies to the Studio. The last card, "Build the whole song", puts every part together in the
 * learner's own song: arrangement, transitions, mix and export.
 */

const FOUR = [1, 5, 9, 13];
const OFF = [3, 7, 11, 15];
const ALL = ["piano", "pads", "kick", "hats", "clap", "bass", "arp", "melody"];

const chordGhost: Ghost = { element: "piano", bar: 1, notes: PROGRESSION.flatMap((chord, b) => chord.map((pitch) => ({ pitch, startTick: b * TICKS_PER_BAR, durationTicks: TICKS_PER_BAR - PPQ / 16 }))) };
const phraseGhost = (letter: "A" | "B" | "C", bar: number): Ghost => ({
  element: "melody",
  bar,
  notes: PHRASES[letter].map(([b, beat, len, pitch]) => ({ pitch, startTick: (b - 1) * TICKS_PER_BAR + Math.round((beat - 1) * PPQ), durationTicks: Math.round(len * PPQ) })),
});

export const SPECIALS: SpecialTask[] = [
  {
    id: "M50.1",
    title: "Special task: the song's chords, pads and melody",
    summary: "The piano part of the course song, drawn note by note.",
    brief: [
      "Every course ends with a Special task that builds one part of the same song: Am - F - C - G at 124 BPM.",
      "This one is the piano part: the chord progression, a pad layer under it, and the melody on top (A-B-A-C). Faint notes show what to draw.",
      "When it is done, Apply it in the studio adds Song · Piano, Song · Pads and Song · Melody to your song.",
    ],
    space: "arrangement",
    setup: { song: { bars: 16, parts: {}, empty: ["piano", "melody"] } },
    steps: [
      { title: "The chords", instruction: "Select the Piano clip (bars 1-4) and draw the four chords over the faint notes: Am, F, C, G, one per bar.", check: { kind: "progression", bars: [1, 4] }, ghosts: [chordGhost], editNotes: true, hints: ["Click the Piano clip: its notes open below.", "Each chord is three notes starting on the bar line, a whole bar long.", "Am = A C E, F = F A C, C = C E G, G = G B D."] },
      { title: "Sixteen bars", instruction: "Repeat the progression so it plays four times (bars 1-16).", check: { kind: "repeated", bars: [1, 16] }, hints: ["Select the Piano clip and press Duplicate (Ctrl+D) three times.", "The copies land on bars 5, 9 and 13."] },
      { title: "The pad layer", instruction: "Add a Pads track and copy every Piano clip onto it.", check: { kind: "layered", bars: [1, 16] }, tools: ["addTrack", "copyToTrack"], hints: ["+ Add track… → Pads.", "Select a Piano clip, choose Pads in Copy to track…, press Copy; repeat for all four."] },
      { title: "Phrase A", instruction: "Select the Melody clip (bars 1-4) and draw phrase A over the faint notes.", check: { kind: "phrase", from: 1, letter: "A" }, ghosts: [phraseGhost("A", 1)], editNotes: true, hints: ["Click the Melody clip: its notes open below.", "Snap to 1/4 and drag to set each note's length.", "Ten notes: the check names the next one that is missing."] },
      {
        title: "A-B-A-C",
        instruction: "Duplicate phrase A three times (bars 5, 9, 13). Change the copy at bar 5 into phrase B and the copy at bar 13 into phrase C, following the faint notes.",
        check: { kind: "melodyPattern", from: 1, pattern: "ABAC" },
        ghosts: [phraseGhost("B", 5), phraseGhost("C", 13)],
        editNotes: true,
        hints: ["Duplicate the Melody clip three times.", "Select the clip at bar 5: faint notes show B. Change the notes to match.", "The clip at bar 9 stays A. The clip at bar 13 becomes C (it ends on G)."],
      },
    ],
    apply: { kind: "parts", label: "Apply it in the studio" },
  },
  {
    id: "M50.2",
    title: "Special task: the song's bass and arp",
    summary: "A chopped root-note bass and an arpeggio for the song.",
    brief: [
      "The second piano-roll part of the course song: the bass line and the arp.",
      "The song's chords play for reference (they are not copied). You make the bass from their roots and the arp from their notes.",
      "Apply it in the studio adds Song · Bass and Song · Arp to your song.",
    ],
    space: "arrangement",
    setup: { song: { bars: 16, parts: {}, reference: { piano: [[1, 16]] } } },
    steps: [
      { title: "Copy the chords", instruction: "Add a Bass track and copy every Reference: Piano clip onto it (bars 1-16).", check: { kind: "hasNotes", element: "bass", bars: [1, 16] }, tools: ["addTrack", "copyToTrack"], hints: ["+ Add track… → Bass.", "Select a Reference: Piano clip, choose Bass in Copy to track…, press Copy; four times."] },
      { title: "Roots only", instruction: "Keep only the root of each chord, then move the bass two octaves down.", check: { kind: "bassRoots", bars: [1, 16] }, tools: ["octave"], editNotes: true, hints: ["The root is the lowest note of each chord here: A, F, C, G.", "Delete the other two notes in every bar (select a clip, edit below).", "Octave ↓ twice on each Bass clip."] },
      { title: "Chop it", instruction: "Chop the bass into eighth notes so it bounces with the kick.", check: { kind: "bassChopped", bars: [1, 16], min: 8 }, tools: ["chop"], hints: ["Select a Bass clip, choose 1/8, press Chop.", "Do it for all four clips."] },
      { title: "The arp", instruction: "Add an Arp track, copy the Reference: Piano clips onto it and apply an arp preset to each.", check: { kind: "arp", bars: [1, 16] }, tools: ["addTrack", "copyToTrack", "arp"], hints: ["+ Add track… → Arp, then Copy to track as before.", "Select an Arp clip, choose a preset, press Apply arp.", "Every Arp clip needs it."] },
    ],
    apply: { kind: "parts", label: "Apply it in the studio" },
  },
  {
    id: "M50.3",
    title: "Special task: the song's drum beat",
    summary: "Kick, off-beat hats and clap: four bars with a lead-in.",
    brief: ["The drum part of the course song, on the step sequencer: four on the floor, hats between the kicks, a clap on 2 and 4.", "Four bars long, with a kick on pad 16 of bar 4 to lead into the next loop.", "Apply it in the studio adds Song · Drums to your song."],
    space: "sequencer",
    setup: { seq: { bars: 4, hits: [] } },
    steps: [
      { title: "Kick", instruction: "Bar 1: a kick on every beat (pads 1, 5, 9, 13).", check: { kind: "pattern", rows: [{ pitch: 36, pads: FOUR, name: "Kick" }] }, hints: ["The Kick row is the top row.", "Beats are pads 1, 5, 9 and 13."] },
      { title: "Hats", instruction: "Bar 1: closed hats between the kicks (pads 3, 7, 11, 15).", check: { kind: "pattern", rows: [{ pitch: 42, pads: OFF, name: "Closed hat" }] }, hints: ["The Closed Hat row is lower down.", "Hats go on the 'and' of each beat."] },
      { title: "Clap", instruction: "Bar 1: a clap on beats 2 and 4 (pads 5 and 13).", check: { kind: "pattern", rows: [{ pitch: 39, pads: [5, 13], name: "Clap" }] }, hints: ["The Clap row is under the snares.", "Layer it with the kick on pads 5 and 13."] },
      { title: "Four bars and a lead-in", instruction: "Copy to all bars, then open bar 4 and add a kick on pad 16.", check: { kind: "bars", bars: 4 }, hints: ["Copy to all bars is in the sequencer's top bar.", "Bar buttons 1-4 choose the bar; pad 16 is the last pad."] },
    ],
    apply: { kind: "parts", label: "Apply it in the studio" },
  },
  {
    id: "M50.4",
    title: "Special task: the song's transitions",
    summary: "Sweeps and down filters at every section change.",
    brief: [
      "The FX part of the course song. The song's sections change at bars 9, 17, 33 and 65 (the drop); each change gets a transition.",
      "Piano, kick and arp play for reference (they are not copied). Drop each sound on its lane after the first time: a song can have at most 16 tracks.",
      "Apply it in the studio adds the FX tracks to your song, already in the right bars.",
    ],
    space: "arrangement",
    // Three reference tracks are enough to hear the sections; a song can have at most 16 tracks, the learner's included.
    setup: { song: { bars: 68, parts: {}, reference: { piano: [[1, 64]], kick: [[9, 32], [49, 64]], arp: [[17, 32]] } } },
    steps: [
      { title: "Bar 9", instruction: "The kick enters on bar 9: a sweep that ends on bar 9 and a down filter that starts on it.", check: { kind: "transition", bar: 9, type: "pair" }, targets: [{ bar: 7, beats: 16, label: "up | down" }], hints: ["Riser 2s on bar 7 ends on 9.", "Downlifter (FX) on bar 9."] },
      { title: "Bar 17", instruction: "The arp section starts on bar 17: the same pair there.", check: { kind: "transition", bar: 17, type: "pair" }, targets: [{ bar: 15, beats: 16, label: "up | down" }], hints: ["Drop the Riser on the Riser track's lane (bar 15), so it reuses that track.", "Downlifter on the Downlifter track's lane, bar 17."] },
      { title: "Bar 33", instruction: "The build-up starts on bar 33: the pair again.", check: { kind: "transition", bar: 33, type: "pair" }, targets: [{ bar: 31, beats: 16, label: "up | down" }], hints: ["Riser on bar 31, Downlifter on bar 33, each on its own lane."] },
      { title: "The drop", instruction: "Into the drop on bar 65: a sweep that ends on bar 65 and an Impact on bar 65.", check: [{ kind: "transition", bar: 65, type: "into" }, { kind: "impact", bar: 65 }], targets: [{ bar: 63, beats: 12, label: "sweep | impact" }], hints: ["Riser 2s on bar 63.", "FX → Impact, dropped exactly on bar 65."] },
    ],
    apply: { kind: "parts", label: "Apply it in the studio" },
  },
  {
    id: "M50.5",
    title: "Special task: the song's mix",
    summary: "Set the levels and pans of the song, saved for the whole song.",
    brief: ["The mix of the course song: gain staging, pan and headroom on its drop, the loudest part.", "Save my mix keeps your levels and pans; the last card, Build the whole song, puts them on your song."],
    space: "arrangement",
    // Six elements (the song's own tracks count toward the 16-track limit too).
    setup: { song: { bars: 8, parts: { piano: [[1, 8]], kick: [[1, 8]], hats: [[1, 8]], bass: [[1, 8]], arp: [[1, 8]], melody: [[1, 8]] }, volume: 100, masterVolume: 80, melodyPattern: "AB" } },
    steps: [
      { title: "Gain staging", instruction: "Turn Loop on, play, and set the levels: kick around -9 dB, every other element between -24 and -6 dB.", check: { kind: "gainStage", kick: [-12, -6], others: [-24, -6] }, tools: ["mixer", "loop"], hints: ["Peaks show in the mixer after a few seconds of playing.", "Kick first, then the others under it."] },
      { title: "Pan", instruction: "Pan the hats and the arp apart; keep the kick and bass in the centre.", check: { kind: "pan" }, tools: ["mixer", "loop"], hints: ["Hats about L25, arp about R25."] },
      { title: "Headroom", instruction: "Play again: the master should peak between -6 and -3 dB. Adjust the elements, not the master.", check: { kind: "headroom", range: [-6, -3], masterVolume: 80 }, tools: ["mixer", "loop"], hints: ["Too loud? Lower every element a little.", "Each change starts the measurement again: play again."] },
    ],
    apply: { kind: "mix", label: "Save my mix for the song" },
  },
  {
    id: "M51.1",
    title: "Build the whole song",
    summary: "Put every part together in your song: arrange, mix and export.",
    brief: [
      "This works on your own song in the Studio, with the parts your Special tasks applied: chords, pads, melody, bass, arp, drums and transitions.",
      "Arrange them into the song map: intro (bars 1-16), arp section (17-32), build-up (33-64), drop (65-96) and outro (97-112). Then mix and export.",
      "Changes here are changes to your song (no Apply needed). There are no rules in making music: once it works, keep adding ideas.",
    ],
    space: "arrangement",
    scope: "song",
    steps: [
      { title: "Your parts", instruction: "Check that every part is in your song.", check: { kind: "parts" }, hints: ["Missing parts name the Special task that makes them.", "After a Special task, press Apply it in the studio."] },
      { title: "Song length", instruction: "Make the song 112 bars long.", check: { kind: "songBars", bars: 112 }, tools: ["songLength"], hints: ["Type 112 in Song bars at the top of the workspace."] },
      { title: "Intro (bars 1-16)", instruction: "Piano and pads from bar 1; the drums and bass join on bar 9.", check: { kind: "intro", quiet: [1, 8], loud: [9, 16] }, targets: [{ bar: 1, beats: 32, label: "piano + pads" }, { bar: 9, beats: 32, label: "+ drums + bass" }], hints: ["Delete the bass clips in bars 1-8 and drag the drums clip to bar 9.", "Duplicate the drums clip so it also covers bars 13-16."] },
      { title: "Arp section (17-32)", instruction: "Bars 17-32: piano, pads, drums, bass and the arp.", check: { kind: "dropFull", bars: [17, 32], elements: ["piano", "pads", "kick", "hats", "clap", "bass", "arp"] }, targets: [{ bar: 17, beats: 64, label: "arp section" }], hints: ["Duplicate clips into bars 17-32: piano, pads, bass, drums.", "Move or duplicate the arp clips to bars 17-32."] },
      { title: "Build-up (33-64)", instruction: "Bars 33-48: two elements, no kick. Bars 49-64: the kick back, and a filter opening from about 1 kHz (49) to fully open (65).", check: [{ kind: "stripBack", bars: [33, 48], max: 2 }, { kind: "filterRise", from: 49, to: 65, kickBack: [49, 64] }], tools: ["automation"], targets: [{ bar: 33, beats: 64, label: "two elements" }, { bar: 49, beats: 64, label: "kick + filter opens" }], hints: ["Piano and pads in 33-48; nothing else.", "Drums in 49-64; ∿ on a track → Filter: low point on 49, top point on 65."] },
      { title: "The drop (65-96)", instruction: "Bars 65-96: every element plus the melody.", check: { kind: "dropFull", bars: [65, 96], elements: ALL }, targets: [{ bar: 65, beats: 128, label: "drop" }], hints: ["Duplicate every part into bars 65-96.", "The melody (A-B-A-C, 16 bars) goes in twice."] },
      { title: "Outro (97-112)", instruction: "One element fewer every 4 bars, while a filter closes.", check: { kind: "outro", bars: [97, 112], needFilter: true }, tools: ["automation"], targets: [{ bar: 97, beats: 64, label: "outro" }], hints: ["Start with everything in 97-100, then leave one element out in each next 4 bars.", "A filter curve going down from bar 97 to 112."] },
      { title: "Transitions", instruction: "Sweeps into bars 9, 17, 33 and 65, down filters after 9, 17 and 33, an impact on 65.", check: [{ kind: "transition", bar: 9, type: "pair" }, { kind: "transition", bar: 17, type: "pair" }, { kind: "transition", bar: 33, type: "pair" }, { kind: "transition", bar: 65, type: "into" }, { kind: "impact", bar: 65 }], hints: ["Your transitions Special task already put them there.", "If you moved them, put them back on those bars."] },
      { title: "Mix", instruction: "Use your saved mix (or set it again) so the master peaks between -6 and -3 dB in the drop.", check: { kind: "headroom", range: [-6, -3] }, tools: ["mixer", "loop", "useMix"], hints: ["Use my mix puts your Mixing Special task levels on the song.", "Play the drop (bar 65 on) and read the master peak."] },
      { title: "Export", instruction: "Listen to the whole song, then export it.", check: { kind: "parts" }, tools: ["export"], confirm: ["I listened to my whole song", "I exported my song (Export WAV)"], hints: ["Export WAV is at the top of the workspace."] },
    ],
    apply: null,
  },
];

export const SPECIAL_TASKS: Record<string, SpecialTask> = Object.fromEntries(SPECIALS.map((s) => [s.id, s]));
/** The Special tasks at the end of each course, in order. */
export const COURSE_SPECIALS: Record<"piano" | "kick" | "sequencer" | "mixing", string[]> = { piano: ["M50.1", "M50.2"], sequencer: ["M50.3"], kick: ["M50.4"], mixing: ["M50.5"] };
