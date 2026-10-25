import { PHRASES } from "./songParts";
import { ALL, BUILD, DROP_LOOP, FULL, TO_48, UNSETTLED_EXAMPLE, listen, song } from "./songCurriculum";
import type { StudioLesson } from "./types";

/** Make a Song, Units 7-11: the build-up, melody and the drop, the ending, mixing and the capstone. */

const BUILD_33: typeof BUILD = { ...BUILD, piano: [[1, 48]], pads: [[1, 48]] };
const DROP_START = { ...BUILD, kick: [[9, 32], [49, 80]] as [number, number][], bass: [[9, 32], [65, 80]] as [number, number][], piano: [[1, 80]] as [number, number][], pads: [[1, 80]] as [number, number][], melody: [[65, 80]] as [number, number][] };

export const UNIT7: StudioLesson[] = [
  {
    id: "M37.1",
    moduleId: "u7",
    title: "Strip back to two elements",
    summary: "Remove the kick and keep about two elements: room to grow.",
    hook: { headline: "Less is more", text: "The build-up starts by taking things away: all the kick drums go, and only about two elements stay (for example piano and pads). The contrast leaves room to build energy again." },
    watch: {
      setup: song(48, TO_48),
      steps: [
        { caption: "Bars 33-48 still have everything from the arp section.", bars: [33, 48] },
        { caption: "Delete the kick clips there…", targets: [{ bar: 33, beats: 64, label: "no kick" }] },
        { caption: "…and every other element except two." },
      ],
    },
    tryIt: { instruction: "Remove the kick from bars 33-48.", setup: song(48, TO_48), check: { kind: "stripBack", bars: [33, 48], max: 6 }, targets: [{ bar: 33, beats: 64, label: "no kick" }] },
    practice: {
      instruction: "Keep only two elements in bars 33-48, and no kick.",
      setup: song(48, TO_48),
      check: { kind: "stripBack", bars: [33, 48], max: 2 },
      hints: ["Select a clip in bars 33-48 and press Delete.", "Piano and pads are a good pair to keep.", "Kick, bass, hats, clap and arp clips in 33-48 all go."],
    },
    quick: { question: "Why strip back at the start of the build-up?", options: ["To end the song", "To make room to grow", "To change the tempo", "To save CPU"], correct: 1, explanation: "Fewer elements now means more contrast when they return." },
    recap: ["The build-up starts with fewer elements.", "No kick, about two elements.", "Contrast leaves room to grow."],
  },
  {
    id: "M37.2",
    moduleId: "u7",
    title: "Low-pass filter automation",
    summary: "Draw the cutoff down to 1000 Hz: the sound gets darker.",
    hook: { headline: "Darker, then brighter", text: "A low-pass filter removes the high frequencies, so the sound gets darker. Automation draws how the cutoff changes over time: here it drops to 1000 Hz at bar 33. The lane shows the frequency while you drag." },
    watch: {
      setup: song(48, BUILD_33),
      steps: [
        { caption: "Open the ∿ lane on a track and choose Filter.", bars: [33, 48] },
        { caption: "Top of the lane is fully open (bright); lower is darker." },
        { caption: "A point at bar 33 dragged down to 1 kHz: everything above it is cut." },
      ],
    },
    tryIt: { instruction: "On the Pads track, add a filter point on bar 33 and drag it to about 2 kHz.", setup: song(48, BUILD_33), tools: ["automation"], check: { kind: "filterAt", bar: 33, hz: 2000 } },
    practice: {
      instruction: "Draw the cutoff down to 1000 Hz at bar 33.",
      setup: song(48, BUILD_33),
      tools: ["automation"],
      check: { kind: "filterAt", bar: 33, hz: 1000 },
      hints: ["Press ∿ on a track, keep Filter selected.", "Click on bar 33 in the lane to add a point; drag it up or down.", "The readout shows the frequency: stop at about 1 kHz."],
    },
    quick: { question: "What does a low-pass filter remove?", options: ["The low frequencies", "The high frequencies", "The drums", "The melody"], correct: 1, explanation: "It lets the lows pass and cuts the highs: the sound gets darker." },
    recap: ["A low-pass filter cuts the highs.", "Automation draws the cutoff over time.", "1000 Hz makes the build-up dark."],
  },
  {
    id: "M37.3",
    moduleId: "u7",
    title: "Bring the kick back and build tension into the drop",
    summary: "Kick returns at bar 49; the filter opens until the drop at bar 65.",
    hook: { headline: "Open the filter, raise the tension", text: "After 16 bars (bar 49) the kick returns. Over the last 16 bars the filter opens gradually from about 1000 Hz to fully open, so the sound gets brighter and brighter, and a transition leads into the drop at bar 65." },
    watch: {
      setup: song(68, BUILD),
      steps: [
        { caption: "Bars 49-64: the kick comes back.", bars: [49, 64] },
        { caption: "The filter curve rises from about 1 kHz at bar 49 to fully open at bar 65." },
        { caption: "A sweep ends on bar 65: the drop." },
      ],
    },
    tryIt: { instruction: "Bring the kick back in bars 49-64.", setup: song(68, BUILD), check: { kind: "intro", quiet: [33, 48], loud: [49, 64] }, targets: [{ bar: 49, beats: 64, label: "kick" }] },
    practice: {
      instruction: "Draw a rising cutoff from bar 49 to bar 65, keep the kick in 49-64, and place a sweep that ends on bar 65.",
      setup: song(68, BUILD),
      tools: ["automation"],
      check: { kind: "filterRise", from: 49, to: 65, kickBack: [49, 64], transitionAt: 65 },
      hints: ["Copy the kick clips into bars 49-64 (Duplicate, then drag).", "On a track's Filter lane: a low point (about 1 kHz) on bar 49, a top point on bar 65.", "A Riser 2s (2 bars at 124 BPM) dropped on bar 63 ends on 65."],
    },
    quick: { question: "How does the build-up create tension?", options: ["The filter closes and it gets darker", "The filter opens and it gets brighter", "Everything stops", "The tempo drops"], correct: 1, explanation: "Opening the filter makes the sound brighter and brighter into the drop." },
    recap: ["The kick returns for the last 16 bars.", "The filter opens gradually: brighter and brighter.", "A transition leads into the drop."],
  },
];

export const UNIT8: StudioLesson[] = [
  {
    id: "M38.2",
    moduleId: "u8",
    title: "Melody theory: phrase, cadence, call and response, resolution, downbeat",
    summary: "Five ideas that shape how a melody feels.",
    hook: {
      headline: "How a melody speaks",
      text: "A phrase is one musical idea (here one loop of the progression, 4 bars). A cadence is a resting point. In call and response one phrase asks and the next answers. Resolution is tension moving to rest. The downbeat is beat 1 of a bar: chord notes there make a melody sound grounded.",
    },
    watch: {
      setup: song(8, { piano: [[1, 4]], melody: [[1, 4]] }, { melody: "unsettled" }),
      steps: [
        { caption: "One phrase: four bars over Am - F - C - G.", bars: [1, 4] },
        { caption: "The last note starts off the beat and is not in the G chord: it does not settle.", targets: [{ bar: 4, beats: 4, label: "unsettled" }] },
        { caption: "Moved onto beat 1, onto G, B or D: the phrase comes to rest." },
      ],
    },
    tryIt: {
      instruction: "Listen to each example and tag it.",
      labels: {
        sections: [
          { bars: "Example 1", energy: 0, answer: "Call", notes: listen(PHRASES.A) },
          { bars: "Example 2", energy: 0, answer: "Response", notes: listen(PHRASES.B) },
          { bars: "Example 3", energy: 0, answer: "Resolved", notes: listen(PHRASES.C) },
          { bars: "Example 4", energy: 0, answer: "Unresolved", notes: listen(UNSETTLED_EXAMPLE) },
        ],
        options: ["Call", "Response", "Resolved", "Unresolved"],
      },
    },
    practice: {
      instruction: "Move the last note onto the downbeat of bar 4, on a note of the G chord, and hear the phrase settle.",
      setup: song(8, { piano: [[1, 4]], melody: [[1, 4]] }, { melody: "unsettled" }),
      editNotes: true,
      check: { kind: "downbeatTone", bar: 4 },
      hints: ["Select the Melody clip; its notes open below.", "Drag the last note left so it starts exactly on bar 4.", "Then move it to G, B or D (the notes of the G chord)."],
    },
    quick: { question: "What is the downbeat?", options: ["The last beat of the song", "Beat 1 of a bar", "Any off-beat", "The quietest note"], correct: 1, explanation: "Beat 1: chord notes there sound grounded." },
    recap: ["A phrase is one musical idea (4 bars here).", "Call and response: ask, then answer; resolution brings rest.", "Chord tones on downbeats sound grounded."],
  },
  {
    id: "M38.3",
    moduleId: "u8",
    title: "The four melody patterns",
    summary: "A-A, A-B, A-B-A-B and A-B-A-C: repetition, variation, resolution.",
    hook: { headline: "One idea, a longer melody", text: "Instead of looping one phrase for the whole drop, build a pattern: A-A (repetition), A-B (call and response), A-B-A-B (alternating, does not always sound finished) and A-B-A-C (the main idea returns, then a new ending C gives a stronger finish)." },
    watch: {
      setup: song(80, { piano: [[65, 80]], pads: [[65, 80]], melody: [[65, 80]] }, { melodyPattern: "ABAC" }),
      steps: [
        { caption: "Phrase A, bars 65-68.", bars: [65, 68] },
        { caption: "B answers it (69-72), A returns (73-76)…", bars: [69, 76] },
        { caption: "…and C ends it (77-80): A-B-A-C.", bars: [77, 80] },
      ],
    },
    tryIt: { instruction: "Duplicate phrase A so it plays twice: A-A (bars 65-72).", setup: song(80, { piano: [[65, 80]], pads: [[65, 80]], melody: [[65, 68]] }), check: { kind: "melodyPattern", from: 65, pattern: "AA" } },
    practice: {
      instruction: "Build A-B-A-C in bars 65-80: duplicate A and edit copies into B and C.",
      setup: song(80, { piano: [[65, 80]], pads: [[65, 80]], melody: [[65, 68]] }),
      editNotes: true,
      check: { kind: "melodyPattern", from: 65, pattern: "ABAC" },
      hints: ["Duplicate A three times: bars 69, 73 and 77.", "Select the copy at 69 and change a few notes: that is B. Leave the copy at 73 as A.", "Change the ending of the copy at 77 so it lands on a chord note: that is C."],
    },
    quick: { question: "Which pattern gives the strongest finish?", options: ["A-A", "A-B-A-B", "A-B-A-C", "A only"], correct: 2, explanation: "A returns, then a new ending C resolves it." },
    recap: ["Repetition, variation and resolution make a melody longer.", "A-B is call and response.", "A-B-A-C ends with a new, stronger finish."],
  },
  {
    id: "M38.4",
    moduleId: "u8",
    title: "Arrange the drop",
    summary: "Every element returns, plus the melody, for 32 bars.",
    hook: { headline: "The peak of the song", text: "At the drop every earlier element returns (piano, pads, kick, hats, clap, bass, arp) plus the melody. Repeat the 8-bar loop across 32 bars (65-96)." },
    watch: {
      setup: song(96, { ...FULL, piano: [[1, 96]], pads: [[1, 96]], kick: [[9, 32], [49, 96]], bass: [[9, 32], [65, 96]], hats: [[17, 32], [65, 96]], clap: [[17, 32], [65, 96]], arp: [[17, 32], [65, 96]], melody: [[65, 96]] }),
      steps: [
        { caption: "Bars 65-96: the drop.", bars: [65, 96] },
        { caption: "Kick, hats, clap, bass and arp all come back with the chords." },
        { caption: "The melody pattern plays on top." },
      ],
    },
    tryIt: { instruction: "Fill bars 65-72 with every element.", setup: song(96, DROP_START, { melodyPattern: "ABAC" }), check: { kind: "dropFull", bars: [65, 72], elements: ALL } },
    practice: {
      instruction: "Fill bars 65-96 with every element and the melody.",
      setup: song(96, DROP_START, { melodyPattern: "ABAC" }),
      check: { kind: "dropFull", bars: [65, 96], elements: ALL },
      hints: ["Duplicate the hats, clap and arp clips from the arp section into the drop.", "Duplicate the melody, kick and bass to fill bars 81-96.", "The check lists what is missing in each 8 bars."],
    },
    quick: { question: "What plays in the drop?", options: ["Only the melody", "Every element plus the melody", "Only drums", "Nothing"], correct: 1, explanation: "Everything returns: the peak of the song." },
    recap: ["The drop brings every element back.", "The melody plays on top.", "It lasts 32 bars (65-96)."],
  },
];

export const UNIT9: StudioLesson[] = [
  {
    id: "M39.1",
    moduleId: "u9",
    title: "Fade the song out with FX and low-pass",
    summary: "Remove one element every 4 bars while the filter closes.",
    hook: { headline: "End smoothly", text: "After the drop the song ends gradually: remove one element every 4 bars, close a low-pass filter and add FX, instead of stopping suddenly. The outro is bars 97-112." },
    watch: {
      setup: song(112, FULL),
      steps: [
        { caption: "Bars 97-112: the outro.", bars: [97, 112] },
        { caption: "Every 4 bars one element leaves…" },
        { caption: "…while a filter curve closes down to dark." },
      ],
    },
    tryIt: { instruction: "Remove one element from bars 101-104 (for example the melody clip there).", setup: song(112, FULL), check: { kind: "outro", bars: [97, 104] } },
    practice: {
      instruction: "Build the outro: one element fewer every 4 bars (97-112) while the cutoff closes.",
      setup: song(112, FULL),
      tools: ["automation"],
      check: { kind: "outro", bars: [97, 112], needFilter: true },
      hints: ["Bars 97-100 keep everything; then delete one element's clip in each later 4-bar block.", "Remember: once an element has left, keep it out.", "On a Filter lane: a high point on bar 97, a low point on bar 112."],
    },
    quick: { question: "How does this song end?", options: ["It stops suddenly", "Elements leave one by one and the filter closes", "The tempo doubles", "A new melody starts"], correct: 1, explanation: "A gradual ending: fewer elements, darker sound." },
    recap: ["The outro removes one element every 4 bars.", "A closing low-pass darkens the sound.", "The song ends smoothly, not suddenly."],
  },
];

export const UNIT10: StudioLesson[] = [
  {
    id: "M40.1",
    moduleId: "u10",
    title: "One mixer channel per element",
    summary: "Each element on its own channel, named after it.",
    hook: { headline: "Mix each sound on its own", text: "Before mixing, every element (kick, hats, clap, bass, piano, pads, arp, melody, FX) needs its own mixer channel, so its level and pan can be set on their own. In this DAW every track is a channel." },
    watch: {
      setup: song(8, DROP_LOOP, { sharedDrums: true, genericNames: true }),
      steps: [
        { caption: "The Drums track plays kick, hats and clap: three elements on one channel." },
        { caption: "One track per drum gives each drum its own track." },
        { caption: "Then name every track after its element: Piano, Pads, Bass, Arp, Melody." },
      ],
    },
    tryIt: { instruction: "Select the Drums clip and press One track per drum.", setup: song(8, DROP_LOOP, { sharedDrums: true, genericNames: true }), tools: ["separateDrums", "rename"], check: { kind: "ownChannels", namesToo: false } },
    practice: {
      instruction: "Give every element its own track, and name each track after its element.",
      setup: song(8, DROP_LOOP, { sharedDrums: true, genericNames: true }),
      tools: ["separateDrums", "rename"],
      check: { kind: "ownChannels", namesToo: true },
      hints: ["One track per drum splits the Drums track.", "Double-click a track name to rename it.", "Listen (Solo) to tell Synth 1, 2… apart: piano, pads, bass, arp, melody."],
    },
    quick: { question: "Why does each element need its own channel?", options: ["To use less memory", "So each can be mixed on its own", "To make the song longer", "It doesn't matter"], correct: 1, explanation: "Separate channels mean separate level, pan and effects." },
    recap: ["One element per channel.", "Name each channel after its element.", "Then each sound can be mixed on its own."],
  },
  {
    id: "M40.2",
    moduleId: "u10",
    title: "Gain staging",
    summary: "The kick peaks around -9 dB; every element sits around it.",
    hook: { headline: "Levels before anything else", text: "Mixing starts with gain staging: set healthy levels before touching anything else. Start with the low end: bring the kick down until it peaks around -9 dB, then set each element around it (between about -24 and -6 dB). The master then keeps room to spare." },
    watch: {
      setup: song(8, DROP_LOOP, { volume: 100 }),
      steps: [
        { caption: "Everything at full level: the meters go red." },
        { caption: "Play the loop and watch the kick's peak in the mixer." },
        { caption: "Lower its level until it peaks around -9 dB, then each element around it." },
      ],
    },
    tryIt: { instruction: "Play the loop and bring the kick's level down until it peaks between -12 and -6 dB.", setup: song(8, DROP_LOOP, { volume: 100 }), tools: ["mixer", "loop"], check: { kind: "gainStage", kick: [-12, -6], others: [-99, 6] } },
    practice: {
      instruction: "Gain stage the loop: kick around -9 dB (between -12 and -6), every other element between -24 and -6 dB.",
      setup: song(8, DROP_LOOP, { volume: 100 }),
      tools: ["mixer", "loop"],
      check: { kind: "gainStage", kick: [-12, -6], others: [-24, -6] },
      hints: ["Turn Loop on and press Play; peaks show in the mixer.", "Lower a level, play again: the peaks are measured fresh after every change.", "Start with the kick, then bring each element in under it."],
    },
    quick: { question: "Where does gain staging start?", options: ["With the master fader", "With the low end: the kick", "With the hi-hats", "With reverb"], correct: 1, explanation: "Set the kick first, then everything around it." },
    recap: ["Gain staging sets healthy levels first.", "The kick peaks around -9 dB.", "Every element sits around it, leaving master headroom."],
  },
  {
    id: "M40.3",
    moduleId: "u10",
    title: "EQ and compression, low end first",
    summary: "Clean up and control the low end.",
    hook: {
      headline: "Give each sound its space",
      text: "EQ boosts what helps a sound and cuts what it does not need. Start with the kick, then EQ and compress the bass. A high-pass on the pads cuts their low rumble, so the kick and bass get clearer. (The EQ and compressor plugins are not in the Web DAW yet: this lesson teaches the decisions; the hands-on A/B comes with them.)",
    },
    watch: {
      steps: [
        { caption: "Kick and bass own the low end." },
        { caption: "Pads and piano also have low rumble that muddies the kick and bass." },
        { caption: "A high-pass on the pads removes it; a compressor evens the bass out." },
      ],
    },
    tryIt: {
      instruction: "What does each element need?",
      labels: {
        sections: [
          { bars: "Pads (low rumble)", energy: 0, answer: "High-pass (cut the lows)" },
          { bars: "Kick", energy: 0, answer: "Keep the low end" },
          { bars: "Bass (uneven notes)", energy: 0, answer: "Compress it" },
        ],
        options: ["Keep the low end", "High-pass (cut the lows)", "Compress it"],
      },
    },
    practice: {
      instruction: "Put the mixing steps for the low end in order.",
      labels: {
        sections: [
          { bars: "1st", energy: 0, answer: "EQ the kick" },
          { bars: "2nd", energy: 0, answer: "EQ and compress the bass" },
          { bars: "3rd", energy: 0, answer: "High-pass the other elements" },
        ],
        options: ["EQ the kick", "EQ and compress the bass", "High-pass the other elements"],
      },
      hints: ["Low end first.", "The kick comes before the bass.", "The other elements make room for them last."],
    },
    quick: { question: "Why high-pass the pads?", options: ["To make them louder", "To remove low rumble so kick and bass are clearer", "To change the key", "To add reverb"], correct: 1, explanation: "Cutting the lows from pads leaves room for kick and bass." },
    recap: ["EQ boosts what helps and cuts what doesn't.", "Low end first: kick, then bass.", "High-pass other elements to clear the low end."],
  },
  {
    id: "M40.4",
    moduleId: "u10",
    title: "Pan and stereo width",
    summary: "Place sounds left and right; keep the low end in the centre.",
    hook: { headline: "Create space", text: "Pan places a sound left or right. Low sounds (kick, bass) always stay in the centre, mono. Pan the hats and arp a little apart, and use stereo width to widen the melody. (The DAW has pan; the width knob is taught here as a concept.)" },
    watch: {
      setup: song(8, DROP_LOOP),
      steps: [
        { caption: "Everything in the centre: crowded." },
        { caption: "Hats a little left, arp a little right: each gets its own space." },
        { caption: "Kick and bass stay in the middle." },
      ],
    },
    tryIt: {
      instruction: "Where does each element go?",
      labels: {
        sections: [
          { bars: "Kick", energy: 0, answer: "Centre (mono)" },
          { bars: "Bass", energy: 0, answer: "Centre (mono)" },
          { bars: "Hats", energy: 0, answer: "A little to one side" },
          { bars: "Melody", energy: 0, answer: "Wide (stereo)" },
        ],
        options: ["Centre (mono)", "A little to one side", "Wide (stereo)"],
      },
    },
    practice: {
      instruction: "Pan the hats and arp slightly apart; keep kick and bass in the centre.",
      setup: song(8, DROP_LOOP),
      tools: ["mixer"],
      check: { kind: "pan" },
      hints: ["Pan sliders are in the mixer.", "Hats about L25, arp about R25.", "The stereo field line shows where each track sits."],
    },
    quick: { question: "Where should the bass sit?", options: ["Hard left", "Hard right", "In the centre", "It moves around"], correct: 2, explanation: "Low frequencies stay mono, in the centre." },
    recap: ["Pan places sounds left and right.", "Kick and bass stay in the centre.", "Hats and arp apart give space."],
  },
  {
    id: "M40.5",
    moduleId: "u10",
    title: "Check master headroom",
    summary: "The master peaks between -6 and -3 dB.",
    hook: { headline: "Room to spare", text: "The master should peak between -6 dB and -3 dB to keep headroom: then the mix is ready for export or mastering. If it peaks above -3 dB, lower the element levels, not the master fader." },
    watch: {
      setup: song(8, DROP_LOOP, { volume: 100 }),
      steps: [
        { caption: "Play the loudest part: the drop." },
        { caption: "The master peak is too high (red)." },
        { caption: "Lower the elements, not the master, until it peaks between -6 and -3 dB." },
      ],
    },
    tryIt: { instruction: "Play the loop and lower the elements until the master peaks below 0 dB.", setup: song(8, DROP_LOOP, { volume: 100, masterVolume: 80 }), tools: ["mixer", "loop"], check: { kind: "headroom", range: [-99, -0.1], masterVolume: 80 } },
    practice: {
      instruction: "Make the master peak between -6 and -3 dB by lowering element levels (leave the master fader).",
      setup: song(8, DROP_LOOP, { volume: 100, masterVolume: 80 }),
      tools: ["mixer", "loop"],
      check: { kind: "headroom", range: [-6, -3], masterVolume: 80 },
      hints: ["Turn Loop on, press Play, read the Master peak.", "Lower every element a little, not the master.", "Each change restarts the measurement: play again."],
    },
    quick: { question: "The master peaks at -1 dB. What do you do?", options: ["Raise the master", "Lower the element levels", "Nothing", "Delete the drums"], correct: 1, explanation: "Fix the mix with the elements, keep the master fader." },
    recap: ["The master should peak between -6 and -3 dB.", "That headroom keeps the mix safe for export.", "Fix it with element levels, not the master."],
  },
];
