import type { StudioLesson, StudioModule } from "./types";

/**
 * The Kick Drums course: K1 builds beats from the sound browser (curriculum M12), K2 uses drums to shape a song's
 * energy with a breakdown, build-up and drop (M13). Each lesson has the six stages of the Piano sub-lessons; Try is a
 * small guided step with targets shown, Practice is the full task with three hint levels.
 */

const KICK = { category: "Kick", label: "kick" };
const SNARE = { category: "Snare", label: "snare" };
const HAT = { category: "Hat", sub: "Closed Hat", label: "closed hat" };
const RISER = { category: "FX", sub: "Riser", label: "riser" };
const IMPACT = { category: "FX", sub: "Impact", label: "impact" };
const DRUM_LOOP = { category: "Loop", sub: "Drum Loop", label: "drum loop" };
const CHORD_LOOP = { category: "Loop", sub: "Chord Loop", label: "chord loop" };

const SOUNDS: StudioLesson[] = [
  {
    id: "M12.1",
    moduleId: "k1",
    title: "Meet the sound browser",
    summary: "Find drum sounds and hear them before you use them.",
    hook: {
      headline: "Every beat starts with choosing sounds",
      text: "Before you make a beat, you pick its sounds. The sound browser holds ready-made drum hits, loops and effects. Listen: a kick, a snare and a closed hat sound completely different.",
      sounds: [KICK, SNARE, HAT],
    },
    watch: {
      steps: [
        { caption: "The list on the left is the sound browser. Each row is one sound; click a row to hear it.", sound: KICK },
        { caption: "The chips at the top filter the list: Kick shows only kicks, Snare only snares.", sound: SNARE },
        { caption: "Hats are short and bright. A closed hat is tight; an open hat rings longer.", sound: HAT },
        { caption: "Use the up and down arrow keys to move through the list while it plays." },
      ],
    },
    tryIt: { instruction: "Click the Kick chip, then click a kick to hear it.", setup: "clear", check: { kind: "auditioned", sounds: [KICK] } },
    practice: {
      instruction: "Find a kick, a snare and a closed hat, and listen to each one.",
      setup: "clear",
      check: { kind: "auditioned", sounds: [KICK, SNARE, HAT] },
      hints: ["Use the category chips above the list: Kick, Snare, Hat.", "Click a sound row to hear it; you can also use the arrow keys.", "Click Hat, then a sound whose label says Closed Hat."],
    },
    quick: { question: "What is the quickest way to see only snares?", options: ["Scroll the whole list", "Click the Snare category chip", "Make a new track", "Change the tempo"], correct: 1, explanation: "The category chips filter the browser to one kind of sound." },
    recap: ["The sound browser holds drum hits, loops and effects.", "Category chips and search narrow the list.", "Always listen before you choose."],
  },
  {
    id: "M12.2",
    moduleId: "k1",
    title: "Drag a sound onto the arrangement",
    summary: "One drag makes a track and a clip.",
    hook: {
      headline: "Drag, drop, done",
      text: "To use a sound, drag it from the list onto the arrangement. A new track appears, named after the sound, with a clip where you let go. Changed your mind? Undo removes it in one step.",
      sounds: [KICK],
    },
    watch: {
      steps: [
        { caption: "The arrangement on the right shows time from left to right, numbered in bars.", targets: [{ bar: 1, label: "bar 1" }] },
        { caption: "Drag a sound from the list and let go over bar 1.", sound: KICK, targets: [{ bar: 1, label: "drop here" }] },
        { caption: "A track named after the sound appears, with a clip on bar 1. Press Play to hear it." },
        { caption: "Dropped in the wrong place? Press Undo (Ctrl+Z) and it is gone in one step." },
      ],
    },
    tryIt: { instruction: "Drag any sound from the list onto the arrangement.", setup: "clear", check: { kind: "anySample" }, targets: [{ bar: 1, label: "drop here" }] },
    practice: {
      instruction: "Drag a kick onto bar 1.",
      setup: "clear",
      check: { kind: "sampleClips", sounds: [KICK], bars: [1, 1] },
      targets: [{ bar: 1, label: "kick" }],
      hints: ["Bar numbers run along the top of the arrangement.", "Choose Kick in the list, then drag a kick and let go over bar 1.", "Landed in the wrong bar? Drag the clip to bar 1, or press Undo and drop again."],
    },
    quick: { question: "What does dropping a sound on an empty part of the arrangement make?", options: ["Nothing until you press Play", "A new track named after the sound, with a clip", "A new project", "A copy of the first track"], correct: 1, explanation: "Each dropped sound gets its own track and a clip where you dropped it." },
    recap: ["Drag from the sound list to the arrangement.", "A track and a clip are created for you.", "Undo takes it back in one step."],
  },
  {
    id: "M12.3",
    moduleId: "k1",
    title: "Make a simple beat",
    summary: "Kick, snare and hat: the three sounds of almost every beat.",
    hook: {
      headline: "Kick on 1 and 3, snare on 2 and 4",
      text: "Most pop, rock and dance beats share one pattern: the kick on beats 1 and 3, the snare on beats 2 and 4, and a hat ticking on top to keep time. Each sound goes on its own track.",
      sounds: [KICK, SNARE, KICK, SNARE],
    },
    watch: {
      steps: [
        { caption: "The kick is the low thump. It goes on its own track, in bar 1.", sound: KICK, targets: [{ bar: 1, label: "kick" }] },
        { caption: "The snare is the sharp crack. It gets its own track too.", sound: SNARE, targets: [{ bar: 1, label: "snare" }] },
        { caption: "The closed hat keeps time on top.", sound: HAT, targets: [{ bar: 1, label: "hat" }] },
        { caption: "Three tracks, all starting in bar 1: press Play and they sound together." },
      ],
    },
    tryIt: { instruction: "Drag a kick onto bar 1.", setup: "clear", check: { kind: "sampleClips", sounds: [KICK], bars: [1, 1] }, targets: [{ bar: 1, label: "kick" }] },
    practice: {
      instruction: "Build a one-bar beat with a kick, a snare and a hat, using sounds from the list.",
      setup: "clear",
      check: { kind: "sampleClips", sounds: [KICK, SNARE, HAT], bars: [1, 1] },
      targets: [{ bar: 1, label: "kick + snare + hat" }],
      hints: ["Each sound needs its own track: drop each one on the empty area below the tracks.", "All three clips should start inside bar 1.", "Use the Kick, Snare and Hat chips to find each sound fast."],
    },
    quick: { question: "In the basic beat, where does the snare go?", options: ["Beats 1 and 3", "Beats 2 and 4", "Every beat", "Only beat 1"], correct: 1, explanation: "Kick on 1 and 3, snare on 2 and 4: the backbeat." },
    recap: ["Kick, snare and hat each get their own track.", "Kick on 1 and 3, snare on 2 and 4.", "The hat keeps time on top."],
  },
  {
    id: "M12.4",
    moduleId: "k1",
    title: "Snap and the grid",
    summary: "The grid decides where things land.",
    hook: {
      headline: "The grid is a set of landing spots",
      text: "With Snap on, clips jump to the nearest grid line. The grid size sets how far apart the lines are: 1 bar, 1/4 (one beat), 1/8, 1/16 or 1/32. With a 1-bar grid a sound can only land on beat 1; with 1/4 it can land on any beat.",
    },
    watch: {
      steps: [
        { caption: "Grid 1 bar: there is one landing spot per bar, so a clip can only start on beat 1.", targets: [{ bar: 1, label: "1" }, { bar: 2, label: "1" }] },
        { caption: "Grid 1/4: four landing spots per bar, one on every beat.", targets: [1, 2, 3, 4].map((b) => ({ bar: 1, beat: b, beats: 1, label: `beat ${b}` })) },
        { caption: "The same drop lands differently: on the bar line with 1 bar, on the beat you aim at with 1/4.", sound: SNARE, targets: [{ bar: 1, beat: 2, beats: 1, label: "beat 2" }] },
        { caption: "The grid works the same way in the piano roll." },
      ],
    },
    tryIt: { instruction: "Set the grid to 1/4, then drag a snare onto beat 3 of bar 1.", setup: "clear", check: { kind: "onBeat", sound: SNARE, beat: 3 }, targets: [{ bar: 1, beat: 3, beats: 1, label: "beat 3" }] },
    practice: {
      instruction: "Place the snare on beat 2 using the 1/4 grid.",
      setup: "clear",
      check: { kind: "onBeat", sound: SNARE, beat: 2 },
      targets: [{ bar: 1, beat: 2, beats: 1, label: "beat 2" }],
      hints: ["The Grid box is above the arrangement, next to Snap.", "With 1/4, beat 2 is the second line inside a bar.", "If the clip jumps back to the bar line, the grid is still on 1 bar."],
    },
    quick: { question: "With the grid on 1 bar, where can a clip start?", options: ["On any beat", "Only at the start of a bar", "Anywhere, Snap is ignored", "Only on beat 4"], correct: 1, explanation: "A 1-bar grid has one line per bar, so clips land on bar starts only." },
    recap: ["Snap moves things onto grid lines.", "Choose the grid size for the job.", "1/4 lets clips land on every beat."],
  },
  {
    id: "M12.5",
    moduleId: "k1",
    title: "More layers: loops",
    summary: "A loop is a ready-made groove you can drop in.",
    hook: {
      headline: "Loops add a whole part at once",
      text: "A loop is a few bars of music that repeats: a drum groove, a bassline or a chord pattern. Each loop was made at its own tempo, shown in the list (for example 90 BPM). Drop two loops and the song fills up fast.",
      sounds: [DRUM_LOOP],
    },
    watch: {
      steps: [
        { caption: "The Loop chip shows drum, bass and chord loops. Their tempo is shown next to them.", sound: DRUM_LOOP },
        { caption: "A drum loop covers a couple of bars with a whole groove.", targets: [{ bar: 1, beats: 8, label: "drum loop" }] },
        { caption: "A chord loop adds harmony underneath.", sound: CHORD_LOOP, targets: [{ bar: 1, beats: 16, label: "chord loop" }] },
      ],
    },
    tryIt: { instruction: "Choose Loop and drag a drum loop onto bar 1.", setup: "clear", check: { kind: "loops", min: 1 }, targets: [{ bar: 1, beats: 8, label: "drum loop" }] },
    practice: {
      instruction: "Add a drum loop and a chord loop to the arrangement.",
      setup: "clear",
      check: { kind: "loops", min: 2 },
      targets: [{ bar: 1, beats: 16, label: "loops" }],
      hints: ["Loops are under the Loop chip.", "Drum loops say Drums in their name; chord loops are labelled Chord Loop.", "Drop each loop on the empty area below the tracks so it gets its own track."],
    },
    quick: { question: "What is a loop?", options: ["One drum hit", "A few bars of music that repeat", "A mixer setting", "A kind of track colour"], correct: 1, explanation: "Loops are short musical phrases made to repeat." },
    recap: ["Loops are repeating bars of drums, bass or chords.", "Each loop knows its own tempo.", "Layering loops fills a song fast."],
  },
  {
    id: "M12.6",
    moduleId: "k1",
    title: "Fit to tempo",
    summary: "Make a loop follow your song's speed.",
    hook: {
      headline: "Fit stretches a loop to your tempo",
      text: "The BPM box sets the song's speed. A loop made at 90 BPM would drag in a 120 BPM song, so the Fit button stretches it to match without changing its pitch. Its label shows the change, like 90→120. Turn Fit off to hear the loop at its own speed.",
    },
    watch: {
      setup: "loop",
      steps: [
        { caption: "This loop was made at 90 BPM. With Fit off it plays at its own speed and drifts against the song.", bars: [1, 2] },
        { caption: "Turn Fit on: the label shows 90→120 and the loop follows the song tempo.", bars: [1, 2] },
        { caption: "Change the BPM box and a fitted loop follows; its pitch stays the same." },
      ],
    },
    tryIt: { instruction: "Set the song tempo to 100 BPM.", setup: "loop", check: { kind: "tempo", bpm: 100 } },
    practice: {
      instruction: "Set the project to 100 BPM and make the loop fit it.",
      setup: "loop",
      check: { kind: "fitTempo", bpm: 100 },
      hints: ["The BPM box is at the top of the workspace.", "Fit is the button on the loop's track.", "When Fit is on, its label shows 90→100."],
    },
    quick: { question: "What does Fit change?", options: ["The loop's pitch", "The loop's speed, to match the song tempo", "The loop's volume", "The song's key"], correct: 1, explanation: "Fit time-stretches the loop to the song tempo and keeps its pitch." },
    recap: ["The BPM box sets the song tempo.", "Fit keeps loops in time with the song.", "Pitch stays the same when a loop is fitted."],
  },
];

const DROP: StudioLesson[] = [
  {
    id: "M13.1",
    moduleId: "k2",
    title: "The energy curve",
    summary: "A song is sections with different energy.",
    hook: {
      headline: "Big moments need quiet ones before them",
      text: "Songs are built from sections: an intro, a build-up, a drop, a breakdown. Each has its own energy. A drop feels huge not only because it is loud, but because of the contrast with the emptier part before it.",
    },
    watch: {
      setup: "full",
      steps: [
        { caption: "Bars 1-8, the intro: drums, bass and chords, medium energy.", bars: [1, 8] },
        { caption: "Bars 9-16, the build-up: things get tense and rise toward the big moment.", bars: [9, 16] },
        { caption: "Bar 17 on, the drop: the full beat returns, the highest energy.", bars: [17, 24] },
        { caption: "A breakdown strips things back again, so the next drop can hit hard." },
      ],
    },
    tryIt: {
      instruction: "Which section is the drop? Label it.",
      labels: { sections: [{ bars: "Bars 17-24", energy: 5, answer: "Drop" }], options: ["Intro", "Build-up", "Drop", "Breakdown"] },
    },
    practice: {
      instruction: "Label the sections of the example song.",
      labels: {
        sections: [
          { bars: "Bars 1-8", energy: 2, answer: "Intro" },
          { bars: "Bars 9-16", energy: 3, answer: "Build-up" },
          { bars: "Bars 17-24", energy: 5, answer: "Drop" },
          { bars: "Bars 25-32", energy: 1, answer: "Breakdown" },
        ],
        options: ["Intro", "Build-up", "Drop", "Breakdown"],
      },
      hints: ["The build-up rises toward the biggest moment.", "The drop is the highest energy.", "The breakdown is the quiet part after a drop."],
    },
    quick: { question: "Why does a drop feel big?", options: ["It is always the longest part", "Because of the contrast with the part before it", "Because it is in a different key", "Because the tempo changes"], correct: 1, explanation: "The emptier section before it makes the full drop stand out." },
    recap: ["A song is a set of sections.", "Energy rises and falls between them.", "Contrast is what makes the drop hit."],
  },
  {
    id: "M13.2",
    moduleId: "k2",
    title: "The breakdown",
    summary: "Take the drums and bass out, keep the chords.",
    hook: {
      headline: "Strip it back",
      text: "A breakdown removes the drums and bass and leaves the chords or a pad. Sections usually last 4, 8 or 16 bars, so the change feels natural. You can mute a track, or delete the clips you do not want.",
    },
    watch: {
      setup: "full",
      steps: [
        { caption: "The example song: drums, bass and chords, in 8-bar clips at bars 1, 9 and 17.", bars: [1, 24] },
        { caption: "For a breakdown in bars 9-16, the drums clip there goes...", bars: [9, 16], targets: [{ bar: 9, beats: 32, label: "breakdown" }] },
        { caption: "...and the bass clip too. Only the chords are left in bars 9-16.", bars: [9, 16] },
        { caption: "Select a clip and press Delete, or click M on a track to mute it." },
      ],
    },
    tryIt: { instruction: "Delete the Song: Drums clip in bars 9-16.", setup: "full", check: { kind: "silent", roles: ["drums"], from: [9, 1], to: [17, 1] }, targets: [{ bar: 9, beats: 32, label: "no drums" }] },
    practice: {
      instruction: "Mute the drums and bass in bars 9-16 so only the chords play.",
      setup: "full",
      check: { kind: "breakdown", bars: [9, 16] },
      targets: [{ bar: 9, beats: 32, label: "chords only" }],
      hints: ["Each Song track has separate clips at bars 1, 9 and 17.", "Click the drums clip at bar 9 and press Delete, then do the same with the bass clip at bar 9.", "Keep Song: Chords playing: it carries the breakdown."],
    },
    quick: { question: "What usually stays in a breakdown?", options: ["Only the kick", "The chords or a pad", "Nothing at all", "Only the bass"], correct: 1, explanation: "Drums and bass leave; chords or pads hold the harmony." },
    recap: ["A breakdown removes drums and bass.", "Chords or a pad keep the music going.", "Sections are usually 4, 8 or 16 bars."],
  },
  {
    id: "M13.3",
    moduleId: "k2",
    title: "Build-up tension tools",
    summary: "Snare rolls, risers and swells pull toward the drop.",
    hook: {
      headline: "Faster, louder, higher",
      text: "Four tools build tension: a snare roll that gets faster (quarter notes, then 8ths, 16ths, 32nds) and louder; a riser, a sweep that rises in pitch; a filter or volume swell; and shorter and shorter loops.",
      sounds: [RISER],
    },
    watch: {
      setup: "pause",
      steps: [
        { caption: "A snare roll: 4 hits in bar 15, then 16 in bar 16. More hits per bar means more tension.", bars: [15, 16], targets: [{ bar: 15, beats: 8, label: "roll" }] },
        { caption: "Each hit is a little louder than the one before: raise them in the velocity lane.", bars: [15, 16] },
        { caption: "A riser sweeps upward under the roll.", sound: RISER, targets: [{ bar: 15, beats: 8, label: "riser" }] },
        { caption: "Use a fine grid (1/16 or 1/32) to draw fast rolls." },
      ],
    },
    tryIt: { instruction: "Drag a Riser from FX onto bar 15.", setup: "buildup", check: { kind: "riser", bars: [15, 16] }, targets: [{ bar: 15, beats: 8, label: "riser" }] },
    practice: {
      instruction: "Add a snare roll in bars 15-16 and a riser under it.",
      setup: "buildup",
      editNotes: true,
      check: { kind: "buildup", bars: [15, 16] },
      targets: [{ bar: 15, beats: 8, label: "roll + riser" }],
      hints: ["Add a clip on Song: Drums at bar 15 (double-click the lane), then draw snare hits on the Snare row.", "Try 4 hits in bar 15 and 16 hits in bar 16 (grid 1/16), louder toward the end.", "The Riser is under FX; drop it at bar 15 so it plays under the roll."],
    },
    quick: { question: "How does a snare roll build tension?", options: ["It gets slower and quieter", "It gets faster and louder", "It changes the key", "It stops the chords"], correct: 1, explanation: "More hits per bar and rising velocity push toward the drop." },
    recap: ["Snare rolls speed up and get louder.", "A riser sweeps upward under the roll.", "A fine grid and the velocity lane make it possible."],
  },
  {
    id: "M13.4",
    moduleId: "k2",
    title: "The pause before the drop",
    summary: "One beat of silence makes the drop hit harder.",
    hook: {
      headline: "Silence is a sound too",
      text: "Just before the drop, stop everything for one beat. The listener expects the next hit, and the short silence makes the drop land with much more force. Every track has to be quiet in that beat, the chords too.",
    },
    watch: {
      setup: "pause",
      steps: [
        { caption: "The roll runs right up to the drop on bar 17.", bars: [15, 17] },
        { caption: "Beat 4 of bar 16 is the gap: every note there is removed.", targets: [{ bar: 16, beat: 4, beats: 1, label: "silence" }] },
        { caption: "The last chord is shortened so it stops at beat 4 too.", targets: [{ bar: 16, beat: 4, beats: 1, label: "silence" }] },
        { caption: "Then the drop lands right after the gap.", bars: [16, 17] },
      ],
    },
    tryIt: {
      instruction: "Delete the snare hits on beat 4 of bar 16.",
      setup: "pause",
      editNotes: true,
      check: { kind: "silent", roles: ["drums"], from: [16, 4], to: [17, 1] },
      targets: [{ bar: 16, beat: 4, beats: 1, label: "no drums" }],
    },
    practice: {
      instruction: "Leave the last beat before the drop empty on every track.",
      setup: "pause",
      editNotes: true,
      check: { kind: "pause", dropBar: 17 },
      targets: [{ bar: 16, beat: 4, beats: 1, label: "silence" }],
      hints: ["The drop is on bar 17; the gap is beat 4 of bar 16.", "Select the drums clip at bar 9, then in the notes editor select the notes on beat 4 of bar 16 and press Delete.", "Select the chords clip at bar 9 and drag the end of its last chord left until it stops at beat 4."],
    },
    quick: { question: "How long is the pause before a drop, usually?", options: ["A whole verse", "About one beat", "Exactly 8 bars", "There is never a pause"], correct: 1, explanation: "A short gap, often one beat, is enough to make the drop hit." },
    recap: ["A beat of silence before the drop adds impact.", "Every track stops, chords included.", "The drop starts right after the gap."],
  },
  {
    id: "M13.5",
    moduleId: "k2",
    title: "The drop",
    summary: "Impact, kick and bass all come back on the downbeat.",
    hook: {
      headline: "Everything lands on beat 1",
      text: "The drop starts on the downbeat (beat 1) with an impact or crash, and the kick and bass return with the full pattern. When all of them hit together, the energy jumps.",
      sounds: [IMPACT],
    },
    watch: {
      setup: "drop",
      steps: [
        { caption: "The drop is bar 17. Right now nothing comes back there.", targets: [{ bar: 17, label: "drop" }] },
        { caption: "An impact goes exactly on beat 1 of bar 17.", sound: IMPACT, targets: [{ bar: 17, beats: 1, label: "impact" }] },
        { caption: "The drums and bass clips are copied (Ctrl+D) so they start on bar 17 again.", targets: [{ bar: 17, beats: 32, label: "kick + bass" }] },
      ],
    },
    tryIt: { instruction: "Drag an Impact from FX exactly onto bar 17.", setup: "drop", check: { kind: "impact", bar: 17 }, targets: [{ bar: 17, beats: 1, label: "impact" }] },
    practice: {
      instruction: "Put an impact on bar 17 and bring the kick and bass back there.",
      setup: "drop",
      check: { kind: "drop", bar: 17 },
      targets: [{ bar: 17, beats: 32, label: "drop" }],
      hints: ["Bar 17 is where the drop starts.", "Select the Song: Drums clip at bar 1 and press Duplicate (Ctrl+D): the copy lands on bar 17.", "Duplicate the Song: Bass clip at bar 1 too, then drag the copy to bar 17."],
    },
    quick: { question: "Where does the impact go?", options: ["Halfway through the build-up", "On the downbeat of the drop", "At the end of the song", "On every beat"], correct: 1, explanation: "The impact marks the first beat of the drop." },
    recap: ["The drop starts on beat 1 of its bar.", "Impact, kick and bass hit together.", "The full pattern returns."],
  },
  {
    id: "M13.6",
    moduleId: "k2",
    title: "Final exercise",
    summary: "Breakdown, build-up and drop together.",
    hook: {
      headline: "Put it all together",
      text: "Now build a whole section yourself: 8 bars of breakdown with no drums, 8 bars of build-up with a snare roll that gets denser and a riser that ends where the drop starts, then a drop on bar 17 with the kick and bass.",
    },
    watch: {
      setup: "final",
      steps: [
        { caption: "Bars 1-8: the breakdown. No drums.", targets: [{ bar: 1, beats: 32, label: "breakdown" }] },
        { caption: "Bars 9-16: the build-up. The snare roll gets denser bar by bar.", targets: [{ bar: 9, beats: 32, label: "build-up" }] },
        { caption: "A riser ends exactly where bar 17 starts.", targets: [{ bar: 15, beats: 8, label: "riser" }] },
        { caption: "Bar 17: the drop, with kick and bass.", targets: [{ bar: 17, beats: 32, label: "drop" }] },
      ],
    },
    tryIt: { instruction: "Make bars 1-8 a breakdown: delete the drums there.", setup: "final", check: { kind: "silent", roles: ["drums"], from: [1, 1], to: [9, 1] }, targets: [{ bar: 1, beats: 32, label: "no drums" }] },
    practice: {
      instruction: "Build 8 bars of breakdown, 8 of build-up, then a drop.",
      setup: "final",
      editNotes: true,
      check: { kind: "fullSection", breakdown: [1, 8], buildup: [9, 16], dropBar: 17 },
      targets: [
        { bar: 1, beats: 32, label: "breakdown" },
        { bar: 9, beats: 32, label: "build-up" },
        { bar: 17, beats: 4, label: "drop" },
      ],
      hints: ["Delete the Song: Drums clip at bar 1 for the breakdown.", "In the drums clip at bar 9, add snare hits so each bar has as many as the one before or more, ending with many.", "A Riser 4s at 120 BPM is 2 bars long: drop it on bar 15 so it ends at bar 17."],
    },
    quick: { question: "What order do these sections usually come in?", options: ["Drop, build-up, breakdown", "Breakdown, build-up, drop", "Build-up, breakdown, drop", "Drop, breakdown, build-up"], correct: 1, explanation: "Strip back, build the tension, then release it in the drop." },
    recap: ["Breakdown: strip back to the chords.", "Build-up: denser roll and a riser.", "Drop: kick and bass return on the downbeat."],
  },
];

export const KICK_MODULES: StudioModule[] = [
  { id: "k1", code: "K1", title: "Sounds and beats", lessons: SOUNDS },
  { id: "k2", code: "K2", title: "Build-up and drop", lessons: DROP },
];
