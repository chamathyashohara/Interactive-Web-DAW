import { PPQ, TICKS_PER_BAR } from "@daw/shared";
import { MOONWING } from "./songParts";
import type { Ghost, SpecialTask } from "./types";

/**
 * The Special tasks: each course ends by building one part of the same song, "Moonwing's Theme" (an original magical
 * theme in E minor, `MOONWING` in songParts.ts: Em - C - Am - B, one chord per bar, 128 BPM). The learner applies each
 * part to the Studio. The last card, "Build the whole song", puts every part together in the learner's own song: a
 * 60-second piece of 32 bars (intro 1-8, theme 9-16, climax 17-24, outro 25-32), with transitions, mix and export.
 */

const OFF = [3, 7, 11, 15];
const ALL = ["piano", "pads", "kick", "hats", "clap", "bass", "arp", "melody"];
const THEME = "moonwing" as const;

const chordGhost: Ghost = { element: "piano", bar: 1, notes: MOONWING.progression.flatMap((chord, b) => chord.map((pitch) => ({ pitch, startTick: b * TICKS_PER_BAR, durationTicks: TICKS_PER_BAR - PPQ / 16 }))) };
const phraseGhost = (letter: "A" | "B" | "C", bar: number): Ghost => ({
  element: "melody",
  bar,
  notes: MOONWING.phrases[letter].map(([b, beat, len, pitch]) => ({ pitch, startTick: (b - 1) * TICKS_PER_BAR + Math.round((beat - 1) * PPQ), durationTicks: Math.round(len * PPQ) })),
});

export const SPECIALS: SpecialTask[] = [
  {
    id: "M50.1",
    title: "Special task: chords, pads and melody",
    summary: "The heart of the theme: its spell-like chords, a string pad and the celesta melody.",
    brief: [
      "Every course ends with a Special task that builds one part of the same song: Moonwing's Theme, a 60-second magical theme in E minor at 128 BPM.",
      "This one is its heart: four chords (Em - C - Am - B), a string pad under them and the celesta melody on top. The B chord's D# (a black key) is the magic: it pulls back home to Em.",
      "Faint notes show what to draw. When it is done, Apply it in the studio adds Song · Piano, Song · Pads and Song · Melody to your song.",
    ],
    space: "arrangement",
    setup: { song: { bars: 16, parts: {}, empty: ["piano", "melody"], theme: THEME } },
    steps: [
      { title: "The chords", instruction: "Select the Piano clip (bars 1-4) and draw the four chords over the faint notes: Em, C, Am, B, one per bar.", check: { kind: "progression", bars: [1, 4] }, ghosts: [chordGhost], editNotes: true, hints: ["Click the Piano clip: its notes open below.", "Each chord is three notes starting on the bar line, a whole bar long.", "Em = E G B, C = C E G, Am = A C E, B = B D# F# (D# is the black key just below E)."] },
      { title: "Sixteen bars", instruction: "Repeat the chords so they play four times (bars 1-16).", check: { kind: "repeated", bars: [1, 16] }, hints: ["Select the Piano clip and press Duplicate (Ctrl+D) three times.", "The copies land on bars 5, 9 and 13."] },
      { title: "The string pad", instruction: "Add a Strings track and copy every Piano clip onto it: a soft cloud under the chords.", check: { kind: "layered", bars: [1, 16] }, tools: ["addTrack", "copyToTrack"], hints: ["+ Add track… → Strings (or Pads).", "Select a Piano clip, choose the new track in Copy to track…, press Copy; repeat for all four."] },
      { title: "The question (phrase A)", instruction: "Select the Melody clip (bars 1-4) and draw phrase A over the faint notes. Listen to the E - D# - E turn: that is the spell.", check: { kind: "phrase", from: 1, letter: "A" }, ghosts: [phraseGhost("A", 1)], editNotes: true, hints: ["Click the Melody clip: its notes open below.", "Snap to 1/8: the short notes are half a beat, the long ones one and a half.", "Fifteen notes: the check names the next one that is missing."] },
      {
        title: "Question, answer, question, ending",
        instruction: "Duplicate phrase A three times (bars 5, 9, 13). Turn the copy at bar 5 into the answer (B, it climbs higher) and the copy at bar 13 into the ending (C), following the faint notes.",
        check: { kind: "melodyPattern", from: 1, pattern: "ABAC" },
        ghosts: [phraseGhost("B", 5), phraseGhost("C", 13)],
        editNotes: true,
        hints: ["Duplicate the Melody clip three times.", "Select the clip at bar 5: faint notes show B, up to a high B. Change the notes to match.", "The clip at bar 9 stays A. In the clip at bar 13 only the last bar changes: it falls to a low B."],
      },
    ],
    apply: { kind: "parts", label: "Apply it in the studio" },
  },
  {
    id: "M50.2",
    title: "Special task: bass and music-box arp",
    summary: "A deep root bass for the theme and a music-box arpeggio for its climax.",
    brief: [
      "The second piano-roll part of Moonwing's Theme: the bass that enters with the drums (bars 9-16) and a music-box arp that sparkles over the climax (bars 17-24).",
      "The theme's chords play for reference (they are not copied). You make the bass from their roots and the arp from their notes.",
      "Apply it in the studio adds Song · Bass and Song · Arp to your song, already in the right bars.",
    ],
    space: "arrangement",
    setup: { song: { bars: 24, parts: {}, reference: { piano: [[1, 24]] }, theme: THEME } },
    steps: [
      { title: "Copy the chords", instruction: "Add a Bass track and copy the Reference: Piano clips at bars 9 and 13 onto it.", check: { kind: "hasNotes", element: "bass", bars: [9, 16] }, tools: ["addTrack", "copyToTrack"], targets: [{ bar: 9, beats: 32, label: "bass" }], hints: ["+ Add track… → Bass.", "Select the Reference: Piano clip at bar 9, choose Bass in Copy to track…, press Copy; then the one at bar 13."] },
      { title: "Roots only, deep down", instruction: "Keep only the root of each chord, then move the bass two octaves down.", check: { kind: "bassRoots", bars: [9, 16] }, tools: ["octave"], editNotes: true, hints: ["The root is the lowest note of each chord here: E, C, A, B.", "Delete the other two notes in every bar (select a clip, edit below).", "Octave ↓ twice on each Bass clip."] },
      { title: "A heartbeat", instruction: "Chop the bass so it pulses: 1/4 for a calm heartbeat, 1/8 for more drive.", check: { kind: "bassChopped", bars: [9, 16], min: 4 }, tools: ["chop"], hints: ["Select a Bass clip, choose 1/4 or 1/8, press Chop.", "Do it for both clips."] },
      { title: "The music box", instruction: "Add an Arp track, copy the Reference: Piano clips at bars 17 and 21 onto it and apply an arp preset to each: the chords become a sparkling music box.", check: { kind: "arp", bars: [17, 24] }, tools: ["addTrack", "copyToTrack", "arp", "octave"], targets: [{ bar: 17, beats: 32, label: "arp" }], hints: ["+ Add track… → Arp, then Copy to track as before (bars 17 and 21).", "Select an Arp clip, choose a preset, press Apply arp. Both clips need it.", "Octave ↑ once makes it sound like a real music box."] },
    ],
    apply: { kind: "parts", label: "Apply it in the studio" },
  },
  {
    id: "M50.3",
    title: "Special task: the half-time beat",
    summary: "A floating half-time groove: kick on 1 and 3, hats between, a clap on 2 and 4.",
    brief: [
      "The drum part of Moonwing's Theme, on the step sequencer. A magical theme should float, so the kick plays half as often: only on beats 1 and 3.",
      "Hats tick between the beats, a clap answers on 2 and 4, and bar 4 adds a kick on pad 16 to lead into the next loop.",
      "Apply it in the studio adds Song · Drums to your song.",
    ],
    space: "sequencer",
    setup: { seq: { bars: 4, hits: [] } },
    steps: [
      { title: "Half-time kick", instruction: "Bar 1: a kick on beats 1 and 3 only (pads 1 and 9).", check: { kind: "pattern", rows: [{ pitch: 36, pads: [1, 9], name: "Kick", exact: true }] }, hints: ["The Kick row is the top row.", "Beat 1 is pad 1 and beat 3 is pad 9; nothing else in the kick row."] },
      { title: "Hats", instruction: "Bar 1: closed hats between the beats (pads 3, 7, 11, 15).", check: { kind: "pattern", rows: [{ pitch: 42, pads: OFF, name: "Closed hat" }] }, hints: ["The Closed Hat row is lower down.", "Hats go on the 'and' of each beat."] },
      { title: "Clap", instruction: "Bar 1: a clap on beats 2 and 4 (pads 5 and 13), the answer to the kick.", check: { kind: "pattern", rows: [{ pitch: 39, pads: [5, 13], name: "Clap" }] }, hints: ["The Clap row is under the snares.", "Pads 5 and 13 are beats 2 and 4."] },
      { title: "Four bars and a lead-in", instruction: "Copy to all bars, then open bar 4 and add a kick on pad 16.", check: { kind: "bars", bars: 4 }, hints: ["Copy to all bars is in the sequencer's top bar.", "Bar buttons 1-4 choose the bar; pad 16 is the last pad."] },
    ],
    apply: { kind: "parts", label: "Apply it in the studio" },
  },
  {
    id: "M50.4",
    title: "Special task: the transitions",
    summary: "Sweeps, an impact and a down filter where the theme changes.",
    brief: [
      "The FX part of Moonwing's Theme. The sections change at bar 9 (the drums enter), bar 17 (the climax) and bar 25 (the outro); each change gets a transition.",
      "Piano, kick and arp play for reference (they are not copied). Drop each sound on its lane after the first time: a song can have at most 16 tracks.",
      "Apply it in the studio adds the FX tracks to your song, already in the right bars.",
    ],
    space: "arrangement",
    // Three reference tracks are enough to hear the sections; a song can have at most 16 tracks, the learner's included.
    setup: { song: { bars: 32, parts: {}, reference: { piano: [[1, 24]], kick: [[9, 24]], arp: [[17, 24]] }, theme: THEME } },
    steps: [
      { title: "Bar 9: the drums enter", instruction: "A sweep that ends on bar 9 and a down filter that starts on it.", check: { kind: "transition", bar: 9, type: "pair" }, targets: [{ bar: 7, beats: 16, label: "up | down" }], hints: ["Riser 2s on bar 7 ends on 9.", "Downlifter (FX) on bar 9."] },
      { title: "Bar 17: the climax", instruction: "Into the climax: a sweep that ends on bar 17 and an Impact on bar 17.", check: [{ kind: "transition", bar: 17, type: "into" }, { kind: "impact", bar: 17 }], targets: [{ bar: 15, beats: 12, label: "sweep | impact" }], hints: ["Drop the Riser on the Riser track's lane (bar 15), so it reuses that track.", "FX → Impact, dropped exactly on bar 17."] },
      { title: "Bar 25: the outro", instruction: "The climax breathes out: a down filter that starts on bar 25.", check: { kind: "transition", bar: 25, type: "after" }, targets: [{ bar: 25, beats: 8, label: "down" }], hints: ["Drop the Downlifter on the Downlifter track's lane, bar 25."] },
    ],
    apply: { kind: "parts", label: "Apply it in the studio" },
  },
  {
    id: "M50.5",
    title: "Special task: the mix",
    summary: "Set the levels and pans of the theme, saved for the whole song.",
    brief: ["The mix of Moonwing's Theme: gain staging, pan and headroom on its climax, the loudest part.", "Save my mix keeps your levels and pans; the last card, Build the whole song, puts them on your song."],
    space: "arrangement",
    // Six elements (the song's own tracks count toward the 16-track limit too).
    setup: { song: { bars: 8, parts: { piano: [[1, 8]], kick: [[1, 8]], hats: [[1, 8]], bass: [[1, 8]], arp: [[1, 8]], melody: [[1, 8]] }, volume: 100, masterVolume: 80, melodyPattern: "AB", theme: THEME } },
    steps: [
      { title: "Gain staging", instruction: "Turn Loop on, play, and set the levels: kick around -9 dB, every other element between -24 and -6 dB.", check: { kind: "gainStage", kick: [-12, -6], others: [-24, -6] }, tools: ["mixer", "loop"], hints: ["Peaks show in the mixer after a few seconds of playing.", "Kick first, then the others under it. Let the celesta melody sit just under the kick."] },
      { title: "Pan", instruction: "Pan the hats and the music-box arp apart; keep the kick and bass in the centre.", check: { kind: "pan" }, tools: ["mixer", "loop"], hints: ["Hats about L25, arp about R25."] },
      { title: "Headroom", instruction: "Play again: the master should peak between -6 and -3 dB. Adjust the elements, not the master.", check: { kind: "headroom", range: [-6, -3], masterVolume: 80 }, tools: ["mixer", "loop"], hints: ["Too loud? Lower every element a little.", "Each change starts the measurement again: play again."] },
    ],
    apply: { kind: "mix", label: "Save my mix for the song" },
  },
  {
    id: "M51.1",
    title: "Build the whole song",
    summary: "Put every part of Moonwing's Theme together: a 60-second song, arranged, mixed and exported.",
    brief: [
      "This works on your own song in the Studio, with the parts your Special tasks applied: chords, strings, melody, bass, arp, drums and transitions.",
      "Arrange them into Moonwing's Theme, 32 bars at 128 BPM (60 seconds): intro (bars 1-8, the theme alone), theme (9-16, drums and bass join), climax (17-24, everything and the music box) and outro (25-32, fading into the night). Then mix and export.",
      "Changes here are changes to your song (no Apply needed). There are no rules in making music: once it works, make it your own.",
    ],
    space: "arrangement",
    scope: "song",
    steps: [
      { title: "Your parts", instruction: "Check that every part is in your song.", check: { kind: "parts" }, hints: ["Missing parts name the Special task that makes them.", "After a Special task, press Apply it in the studio."] },
      { title: "60 seconds", instruction: "Moonwing's Theme runs at 128 BPM and is 32 bars long: exactly one minute.", check: [{ kind: "tempo", bpm: MOONWING.tempo }, { kind: "songBars", bars: 32, exact: true }], tools: ["songLength"], hints: ["Applying a part sets 128 BPM; if not, type 128 in the BPM box.", "Type 32 in Song bars at the top of the workspace (move or delete clips after bar 32 first)."] },
      { title: "Intro and theme (1-16)", instruction: "Bars 1-8: the theme alone (piano, strings, melody). Bars 9-16: the drums and bass join.", check: { kind: "intro", quiet: [1, 8], loud: [9, 16] }, targets: [{ bar: 1, beats: 32, label: "intro" }, { bar: 9, beats: 32, label: "+ drums + bass" }], hints: ["Drag the Song · Drums clip to bar 9 and duplicate it so it also covers bars 13-16.", "The bass already starts on bar 9."] },
      { title: "Climax (17-24)", instruction: "Bars 17-24: everything together, with the music box on top.", check: { kind: "dropFull", bars: [17, 24], elements: ALL }, targets: [{ bar: 17, beats: 32, label: "climax" }], hints: ["Duplicate piano, strings and melody (bars 1-8) into bars 17-24.", "Duplicate the drums and the bass into bars 17-24; the arp is already there."] },
      { title: "Outro (25-32)", instruction: "One element fewer every 4 bars, while a filter closes: the theme fades into the night.", check: { kind: "outro", bars: [25, 32], needFilter: true }, tools: ["automation"], targets: [{ bar: 25, beats: 32, label: "outro" }], hints: ["For example: piano, strings and arp in 25-28, then only strings and arp in 29-32.", "∿ on the strings track → Filter: a high point on bar 25, a low point on bar 32."] },
      { title: "Transitions", instruction: "A sweep and a down filter at bar 9, a sweep and an impact into bar 17, a down filter from bar 25.", check: [{ kind: "transition", bar: 9, type: "pair" }, { kind: "transition", bar: 17, type: "into" }, { kind: "impact", bar: 17 }, { kind: "transition", bar: 25, type: "after" }], hints: ["Your transitions Special task already put them there.", "If you moved them, put them back on those bars."] },
      { title: "Mix", instruction: "Use your saved mix (or set it again) so the master peaks between -6 and -3 dB in the climax.", check: { kind: "headroom", range: [-6, -3] }, tools: ["mixer", "loop", "useMix"], hints: ["Use my mix puts your Mixing Special task levels on the song.", "Play the climax (bar 17 on) and read the master peak."] },
      { title: "Export", instruction: "Listen to the whole minute, then export it.", check: { kind: "parts" }, tools: ["export"], confirm: ["I listened to my whole song", "I exported my song (Export WAV)"], hints: ["Export WAV is at the top of the workspace."] },
    ],
    apply: null,
  },
];

export const SPECIAL_TASKS: Record<string, SpecialTask> = Object.fromEntries(SPECIALS.map((s) => [s.id, s]));
/** The Special tasks at the end of each course, in order. */
export const COURSE_SPECIALS: Record<"piano" | "kick" | "sequencer" | "mixing", string[]> = { piano: ["M50.1", "M50.2"], sequencer: ["M50.3"], kick: ["M50.4"], mixing: ["M50.5"] };
