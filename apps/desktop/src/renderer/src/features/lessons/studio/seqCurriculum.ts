import type { PadDemo, SeqSetup, StudioLesson, StudioModule } from "./types";

/**
 * The Drum sequencer course: kick patterns on the DAW's step sequencer (one bar = sixteen pads; beats are pads 1, 5, 9
 * and 13; kick 36, snare 38, closed hat 42). Ids continue the curriculum after the Kick Drums course (M14.1-M14.10).
 * Every lesson works on its own drum track in its own workspace.
 */

const K = 36;
const S = 38;
const H = 42;
const FOUR = [1, 5, 9, 13];
const kicks = (pads: number[], velocity?: number) => pads.map((pad) => ({ pitch: K, pad, ...(velocity ? { velocity } : {}) }));
const seq = (bars: number, hits: SeqSetup["seq"]["hits"] = []): SeqSetup => ({ seq: { bars, hits } });
/** The same pads in every bar of `bars`. */
const everyBar = (bars: number, pads: number[]) => Array.from({ length: bars }, (_, b) => pads.map((x) => x + 16 * b)).flat();
const demo = (pitch: number, pads: number[], velocity?: number): PadDemo => ({ pitch, pads, ...(velocity ? { velocity } : {}) });

const BASICS: StudioLesson[] = [
  {
    id: "M14.1",
    moduleId: "s1",
    space: "sequencer",
    title: "Your first kick",
    summary: "One bar, sixteen pads, one kick.",
    hook: {
      headline: "A bar is sixteen pads",
      text: "The step sequencer shows one bar as sixteen pads in four groups of four. Each pad is a sixteenth note. Click a pad in the Kick row and a kick plays there every time the bar comes round.",
      pattern: [demo(K, FOUR)],
    },
    watch: {
      steps: [
        { caption: "Each row is one drum. The Kick is the top row.", pads: [demo(K, [1])] },
        { caption: "Sixteen pads make one bar, in four groups of four: one group per beat.", pads: [demo(K, [1, 5, 9, 13])] },
        { caption: "Pad 1 is the very start of the bar. A kick there lands on beat 1." , pads: [demo(K, [1])] },
        { caption: "Click a pad to place a hit; click it again to remove it. Then press Play." },
      ],
    },
    tryIt: { instruction: "Click pad 1 in the Kick row.", setup: seq(1), check: { kind: "kickPads", has: [1], pitch: K } },
    practice: {
      instruction: "Place a kick on pad 1 and press Play.",
      setup: seq(1),
      check: { kind: "kickPads", has: [1], pitch: K },
      confirm: ["I pressed Play and heard the kick"],
      hints: ["The kick row is the top row. Click the first pad.", "Pad 1 is the first pad on the left, before the first gap.", "Press ▶ at the top of the practice space, then tick the box."],
    },
    quick: { question: "How many pads make one bar?", options: ["4", "8", "16", "32"], correct: 2, explanation: "Sixteen pads, one per sixteenth note: four for each beat." },
    recap: ["The step sequencer shows one bar as 16 pads.", "Each row is one drum; the kick is the top row.", "Click a pad to place a hit, click again to remove it."],
  },
  {
    id: "M14.2",
    moduleId: "s1",
    space: "sequencer",
    title: "Four on the floor",
    summary: "A kick on every beat: the heartbeat of dance music.",
    hook: { headline: "Boom, boom, boom, boom", text: "Put a kick on every beat and you get four on the floor, the steady pulse of house and techno. The beats are pads 1, 5, 9 and 13: the first pad of each group.", pattern: [demo(K, FOUR)] },
    watch: {
      steps: [
        { caption: "Beat 1 is pad 1.", pads: [demo(K, [1])] },
        { caption: "Beat 2 is pad 5, the first pad of the second group.", pads: [demo(K, [1, 5])] },
        { caption: "Beats 3 and 4 are pads 9 and 13.", pads: [demo(K, FOUR)] },
        { caption: "Four kicks, one per beat: four on the floor." , pads: [demo(K, FOUR)] },
      ],
    },
    tryIt: { instruction: "Put kicks on beats 1 and 2: pads 1 and 5.", setup: seq(1), check: { kind: "kickPads", has: [1, 5] } },
    practice: {
      instruction: "Put a kick on every beat: pads 1, 5, 9 and 13.",
      setup: seq(1),
      check: { kind: "kickPads", exact: FOUR },
      hints: ["Each beat is the first pad of a group of four.", "The beats are pads 1, 5, 9 and 13.", "Remove any other kick by clicking it again."],
    },
    quick: { question: "Which pads are the four beats?", options: ["1, 2, 3, 4", "1, 5, 9, 13", "4, 8, 12, 16", "1, 3, 5, 7"], correct: 1, explanation: "Each beat starts a group of four pads: 1, 5, 9 and 13." },
    recap: ["The beats are pads 1, 5, 9 and 13.", "A kick on every beat is four on the floor.", "It is the steady pulse of house and techno."],
  },
  {
    id: "M14.3",
    moduleId: "s1",
    space: "sequencer",
    title: "Feel the pulse",
    summary: "Hear the kick land on the click, and tap along.",
    hook: { headline: "Lock to the click", text: "The Click (metronome) ticks on every beat while the song plays. If your kicks are on the beats, they land exactly on the click. TAP lets you tap along: tap in time and it shows the tempo you are tapping.", pattern: [demo(K, FOUR)] },
    watch: {
      steps: [
        { caption: "Turn on Click: you hear a tick on every beat, higher on beat 1." },
        { caption: "Press Play: the four-on-the-floor kicks land right on the ticks.", pads: [demo(K, FOUR)] },
        { caption: "Tap TAP along with the beat. The tempo appears in the BPM box." },
      ],
    },
    tryIt: {
      instruction: "Turn on Click and press Play. Listen to the kick land on the click.",
      setup: seq(1, kicks(FOUR)),
      check: { kind: "kickPads", exact: FOUR },
      confirm: ["I turned on Click and pressed Play"],
    },
    practice: {
      instruction: "With Click on and the song playing, tap TAP along with the kick.",
      setup: seq(1, kicks(FOUR)),
      check: { kind: "kickPads", exact: FOUR },
      confirm: ["I heard the kick land on the click", "I tapped TAP along with the beat"],
      hints: ["Press Click so you can hear the beat.", "TAP is next to the position readout: tap it on every kick.", "Keep the four kicks on pads 1, 5, 9 and 13."],
    },
    quick: { question: "What does the Click play?", options: ["A kick on pad 1", "A tick on every beat", "The whole song faster", "Nothing until you tap"], correct: 1, explanation: "The metronome ticks on every beat (higher on beat 1), and it is never part of an export." },
    recap: ["Click ticks on every beat while playing.", "Kicks on the beats land exactly on the click.", "TAP shows the tempo you tap."],
  },
  {
    id: "M14.4",
    moduleId: "s1",
    space: "sequencer",
    title: "Kick on 1 and 3",
    summary: "A lighter pattern with more space.",
    hook: { headline: "Fewer kicks, more room", text: "Kicks on beats 1 and 3 only feel lighter and bouncier than four on the floor: it is the kick of most pop and rock. Beat 1 is pad 1 and beat 3 is pad 9.", pattern: [demo(K, [1, 9]), demo(S, [5, 13])] },
    watch: {
      steps: [
        { caption: "Four on the floor: a kick on every beat.", pads: [demo(K, FOUR)] },
        { caption: "Take away beats 2 and 4 and the pattern opens up.", pads: [demo(K, [1, 9])] },
        { caption: "Compare the two: steady and driving, or lighter with space." },
      ],
    },
    tryIt: { instruction: "Remove the kick on pad 5 (beat 2).", setup: seq(1, kicks(FOUR)), check: { kind: "kickPads", exact: [1, 9, 13] } },
    practice: {
      instruction: "Make a lighter pattern with kicks on pads 1 and 9 only.",
      setup: seq(1),
      check: { kind: "kickPads", exact: [1, 9] },
      hints: ["Beat 1 is pad 1 and beat 3 is pad 9.", "Only two kicks this time.", "Click any other kick again to remove it."],
    },
    quick: { question: "Kicks on 1 and 3 compared with four on the floor feel…", options: ["Heavier and faster", "Lighter, with more space", "Exactly the same", "Out of time"], correct: 1, explanation: "Half the kicks leaves room between them." },
    recap: ["Kicks on 1 and 3 are pads 1 and 9.", "Fewer kicks feel lighter and leave space.", "It is the kick of most pop and rock."],
  },
  {
    id: "M14.5",
    moduleId: "s1",
    space: "sequencer",
    title: "Off-beat kicks",
    summary: "A kick between the beats makes it groove.",
    hook: { headline: "Between the beats", text: "Count 1 and 2 and 3 and 4 and. The 'and' of 2 is pad 7 and the 'and' of 4 is pad 15. A kick there, between the beats, makes the pattern bounce.", pattern: [demo(K, [1, 7, 9, 15]), demo(S, [5, 13])] },
    watch: {
      steps: [
        { caption: "Kicks on 1 and 3 (pads 1 and 9).", pads: [demo(K, [1, 9])] },
        { caption: "Add the 'and' of 2: pad 7, halfway between beats 2 and 3.", pads: [demo(K, [1, 7, 9])] },
        { caption: "The 'and' of 4 is pad 15.", pads: [demo(K, [1, 7, 9, 15])] },
      ],
    },
    tryIt: { instruction: "Add a kick on pad 7 (the 'and' of 2).", setup: seq(1, kicks([1, 9])), check: { kind: "kickPads", has: [1, 7, 9] } },
    practice: {
      instruction: "Add a kick between the beats so you have at least 3 kicks, one off the beat.",
      setup: seq(1, kicks([1, 9])),
      check: { kind: "offBeat", min: 3 },
      hints: ["Every kick is on a beat. Try one pad to the right of a beat pad.", "The 'and' of 2 is pad 7 and the 'and' of 4 is pad 15.", "Beat pads are 1, 5, 9 and 13: anything else is off the beat."],
    },
    quick: { question: "Which pad is the 'and' of 2?", options: ["Pad 2", "Pad 5", "Pad 7", "Pad 9"], correct: 2, explanation: "Beat 2 is pad 5; halfway to beat 3 is pad 7." },
    recap: ["The 'and' of a beat is halfway to the next one.", "The 'and' of 2 is pad 7, the 'and' of 4 is pad 15.", "Off-beat kicks make a pattern bounce."],
  },
];

const SHAPING: StudioLesson[] = [
  {
    id: "M14.6",
    moduleId: "s2",
    space: "sequencer",
    title: "Loud and soft kicks",
    summary: "An accent makes beat 1 stand out.",
    hook: { headline: "Not every hit is equal", text: "Shift+click a pad to make it an accent: it plays at full loudness (127) and lights brighter. A normal click plays at 100. An accent on beat 1 makes every bar start with a punch.", pattern: [demo(K, [1], 127), demo(K, [7, 9, 15])] },
    watch: {
      steps: [
        { caption: "Normal kicks all play at the same loudness.", pads: [demo(K, [1, 7, 9, 15])] },
        { caption: "Shift+click pad 1: it lights brighter and plays louder.", pads: [demo(K, [1], 127)] },
        { caption: "Shift+click it again to make it normal." },
      ],
    },
    tryIt: { instruction: "Shift+click the kick on pad 1 to make it an accent.", setup: seq(1, kicks(FOUR)), check: { kind: "accent" } },
    practice: {
      instruction: "Make the kick on beat 1 an accent and leave the others normal.",
      setup: seq(1, kicks([1, 7, 9, 15])),
      check: { kind: "accent" },
      hints: ["Hold Shift and click the pad. It lights brighter.", "Only pad 1 gets the accent.", "If another kick turned bright, Shift+click it again."],
    },
    quick: { question: "What does Shift+click do to a pad?", options: ["Removes it", "Makes it an accent (louder)", "Copies it to all bars", "Changes the drum"], correct: 1, explanation: "Shift+click toggles the accent: velocity 127 instead of 100." },
    recap: ["Shift+click makes an accent (127).", "Normal hits play at 100.", "An accent on beat 1 marks the start of the bar."],
  },
  {
    id: "M14.7",
    moduleId: "s2",
    space: "sequencer",
    title: "Leave room for the snare",
    summary: "Kick and snare take turns.",
    hook: { headline: "Two drums, one pad: pick one", text: "The snare plays on beats 2 and 4 (pads 5 and 13). If a kick lands on the same pad, the two hits stack and blur. Give the snare its pads and move the kick away.", pattern: [demo(K, [1, 9]), demo(S, [5, 13])] },
    watch: {
      steps: [
        { caption: "The snare row is under the kicks. Beats 2 and 4 are pads 5 and 13.", pads: [demo(S, [5, 13])] },
        { caption: "Four on the floor has a kick on pads 5 and 13 too: they stack.", pads: [demo(K, FOUR), demo(S, [5, 13])] },
        { caption: "Move those kicks off: kick and snare now take turns.", pads: [demo(K, [1, 9]), demo(S, [5, 13])] },
      ],
    },
    tryIt: { instruction: "Add a snare on pad 5 and remove the kick there.", setup: seq(1, kicks(FOUR)), check: { kind: "snareRoom", pads: [5] } },
    practice: {
      instruction: "Add a snare on beats 2 and 4 (pads 5 and 13) and move any kick off those pads.",
      setup: seq(1, kicks(FOUR)),
      check: { kind: "snareRoom", pads: [5, 13] },
      hints: ["The snare owns pads 5 and 13. Move the kick off them.", "The Snare row is just below the kicks.", "You can move a kick to pad 7 or 15 instead of deleting it."],
    },
    quick: { question: "Where does the snare usually go?", options: ["Beats 1 and 3", "Beats 2 and 4", "Every pad", "Only pad 16"], correct: 1, explanation: "Snare on 2 and 4, the backbeat: pads 5 and 13." },
    recap: ["The snare plays beats 2 and 4: pads 5 and 13.", "Kick and snare on one pad blur together.", "Give each drum its own pads."],
  },
  {
    id: "M14.8",
    moduleId: "s2",
    space: "sequencer",
    title: "Make it four bars",
    summary: "Copy a bar, then change the last one.",
    hook: { headline: "Repeat, then surprise", text: "Copy to all bars makes every bar of the clip like the one you are on. Then change bar 4 a little, for example a kick on pad 16, so it leads into the next loop. The bar buttons choose which bar you see.", pattern: [demo(K, [1, 9]), demo(S, [5, 13])] },
    watch: {
      steps: [
        { caption: "This clip is four bars long. The bar buttons show one bar at a time." },
        { caption: "Bar 1 has the pattern. Copy to all bars puts it in bars 2, 3 and 4.", pads: [demo(K, [1, 9]), demo(S, [5, 13])] },
        { caption: "Open bar 4 and add a kick on pad 16: a lead-in to the next loop.", pads: [demo(K, [1, 9, 16]), demo(S, [5, 13])] },
      ],
    },
    tryIt: { instruction: "Press Copy to all bars so every bar has the kick.", setup: seq(4, [...kicks([1, 9]), { pitch: S, pad: 5 }, { pitch: S, pad: 13 }]), check: { kind: "bars", bars: 4, lastDiffers: false } },
    practice: {
      instruction: "Use Copy to all bars, then change bar 4: add a kick on pad 16 as a lead-in.",
      setup: seq(4, [...kicks([1, 9]), { pitch: S, pad: 5 }, { pitch: S, pad: 13 }]),
      check: { kind: "bars", bars: 4 },
      hints: ["Use Copy to all bars first, then open bar 4 with the bar buttons.", "Bar buttons 1-4 are at the top of the sequencer.", "In bar 4, click pad 16 in the Kick row."],
    },
    quick: { question: "What does Copy to all bars do?", options: ["Deletes the other bars", "Makes every other bar a copy of this one", "Doubles the tempo", "Adds a new track"], correct: 1, explanation: "It copies the bar you are on into every other bar of the clip." },
    recap: ["Copy to all bars repeats a bar.", "The bar buttons choose which bar you edit.", "A change in the last bar leads into the next loop."],
  },
  {
    id: "M14.9",
    moduleId: "s2",
    space: "sequencer",
    title: "Loop just the kick",
    summary: "Play two bars over and over.",
    hook: { headline: "Round and round", text: "Loop plays the same part again and again while you listen and change it. Drag in the thin LOOP strip above the bar numbers to choose where it starts and ends. (In the Studio, Loop unlocks with lesson M8.2.)", pattern: [demo(K, FOUR)] },
    watch: {
      steps: [
        { caption: "The LOOP strip is the thin strip above the bar numbers." },
        { caption: "Press Loop: a short loop region appears." },
        { caption: "Drag in the strip (or drag the loop's end) to cover two bars. Play: those two bars repeat." },
      ],
    },
    tryIt: { instruction: "Press Loop to turn on a loop region.", setup: seq(4, kicks(everyBar(4, FOUR))), check: { kind: "loopRegion", minBars: 1 } },
    practice: {
      instruction: "Turn on Loop and drag the LOOP strip over two bars. Hear your kick pattern repeat.",
      setup: seq(4, kicks(everyBar(4, FOUR))),
      check: { kind: "loopRegion", minBars: 2 },
      hints: ["Drag in the thin LOOP strip above the numbers.", "Start the drag at bar 1 and let go at bar 3.", "Drag the loop's right end to make it longer."],
    },
    quick: { question: "Where do you set the loop?", options: ["In the Kick row", "In the thin LOOP strip above the bar numbers", "With Shift+click", "In the BPM box"], correct: 1, explanation: "Drag in the LOOP strip to set where the loop starts and ends." },
    recap: ["Loop repeats a part while you work.", "Drag in the LOOP strip to set it.", "Two bars is a good length to listen to a pattern."],
  },
  {
    id: "M14.10",
    moduleId: "s2",
    space: "sequencer",
    title: "A kick that builds",
    summary: "Ramp the kick from soft to loud.",
    hook: { headline: "Getting louder", text: "Ramp sets the loudness of many hits at once so it climbs from the first to the last. Click the Kick name first so Ramp only changes the kick, then press Ramp and choose Build up. (In the Studio, Ramp unlocks with lesson M7.4.)", pattern: [demo(K, [1], 40), demo(K, [5], 70), demo(K, [9], 100), demo(K, [13], 127)] },
    watch: {
      steps: [
        { caption: "Click the Kick name: the row is selected, so Ramp works on the kick only." },
        { caption: "Press Ramp and choose Build up: quiet at first, then louder.", pads: [demo(K, [1], 40), demo(K, [5], 70), demo(K, [9], 100), demo(K, [13], 127)] },
        { caption: "Across four bars, the first kick is soft and the last is loud." },
      ],
    },
    tryIt: {
      instruction: "Click the Kick name, press Ramp and choose Build up.",
      setup: seq(1, [...kicks(FOUR), ...[1, 3, 5, 7, 9, 11, 13, 15].map((pad) => ({ pitch: H, pad }))]),
      check: { kind: "kickRamp", rise: 20 },
    },
    practice: {
      instruction: "Over four bars, make the kicks get louder from the first bar to the last with Ramp.",
      setup: seq(4, [...kicks(everyBar(4, FOUR)), ...everyBar(4, [1, 3, 5, 7, 9, 11, 13, 15]).map((pad) => ({ pitch: H, pad }))]),
      check: { kind: "kickRamp", rise: 40 },
      hints: ["Click the Kick name first, so Ramp changes only the kick.", "Ramp is in the sequencer's top bar; choose Build up.", "Build up goes from 30 to 120: a rise of 90."],
    },
    quick: { question: "Why click the Kick name before Ramp?", options: ["To delete the kick", "So Ramp changes only the kick", "To make it four bars", "To hear the click"], correct: 1, explanation: "With a row selected, Ramp and Clear bar work on that drum only." },
    recap: ["Ramp makes many hits climb or fall in loudness.", "Select a row first to ramp one drum only.", "A kick that builds pushes the music forward."],
  },
];

export const SEQ_MODULES: StudioModule[] = [
  { id: "s1", code: "S1", title: "Kick basics", lessons: BASICS },
  { id: "s2", code: "S2", title: "Shaping the beat", lessons: SHAPING },
];
