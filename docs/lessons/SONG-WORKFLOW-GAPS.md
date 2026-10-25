# Song-Making Learning Workflow: comparison with the lessons in the app (2026-10-24)

Source: `Song-Making-Learning-Workflow.pdf` (12 units, 0-11, 31 lessons, one song of 112 bars at 124 BPM, one chord per
bar so one clip is 4 bars). This file lists what the app already has, what is missing, and how each missing lesson is
built.

## Main lesson cards in the app before this change

| Card | State | Lessons |
| --- | --- | --- |
| Piano | live | L1-L6, 39 sub-lessons (piano roll, notes, scales, chords, progressions, melody) |
| Kick Drums | live | K1-K2, 12 lessons M12.1-M13.6 (sound browser, beats, breakdown, build-up, drop) |
| Drum sequencer | live | S1-S2, 10 lessons M14.1-M14.10 (step sequencer kick patterns) |
| Mixing | "Coming soon" | none |
| DAW Features | "Coming soon" | none (links to two existing lessons) |

## Plan lesson by plan lesson

| Plan | Lesson | In the app | Decision |
| --- | --- | --- | --- |
| 0.1 | Tour the DAW and set up the song project | Partly (L1 "Play, loop, tempo" works in the lesson roll only) | **New** |
| 0.2 | Piano roll basics | **Yes**: L1 "Draw and delete" (+ Move and resize, Select copy undo) | Linked, not duplicated |
| 1.1 | What a chord is | **Yes**: L4 "What a chord is" (+ Major triad, Minor triad) | Linked |
| 1.2 | Build a 4-chord progression | **Yes**: L5 "Your own progression" | Linked |
| 1.3 | Repeat and transpose the progression | Partly (copy/undo, octaves) | **New** |
| 1.4 | Layer the chords on pads or strings | No | **New** |
| 2.1 | Kick on every beat | **Yes**: Drum sequencer M14.2 "Four on the floor" | Linked |
| 2.2 | Hi-hats between the kicks | No (M14.5 is off-beat kicks) | **New** |
| 2.3 | Clap on every second kick | Partly (M14.7 is the snare) | **New** |
| 3.1 | Clips, tracks and sections | Partly (M13.1 energy curve) | **New** |
| 3.2 | Build the 16-bar intro | No | **New** |
| 4.1 | Sweep up into the kick | Partly (M13.3 riser under a roll) | **New** |
| 4.2 | Down filter after the kick | No | **New** |
| 5.1 | Bass from the root notes | Partly (L5 "Rhythm and a bass note") | **New** |
| 5.2 | Chop the bass (Alt+U chopper) | No | **New** (see gaps) |
| 6.1 | Add an arp preset | No | **New** (see gaps) |
| 6.2 | Close the section with a transition | No | **New** |
| 7.1 | Strip back to two elements | Partly (M13.2 breakdown) | **New** |
| 7.2 | Low-pass filter automation | No | **New** |
| 7.3 | Bring the kick back and build tension into the drop | Partly (M13.3, M13.5) | **New** |
| 8.1 | A melody follows the chords | **Yes**: L6 "Chord tones" | Linked |
| 8.2 | Melody theory: phrase, cadence, call and response, resolution, downbeat | No | **New** |
| 8.3 | The four melody patterns | No | **New** |
| 8.4 | Arrange the drop | Partly (M13.5) | **New** |
| 9.1 | Fade the song out with FX and low-pass | No | **New** |
| 10.1 | One mixer channel per element | No | **New** |
| 10.2 | Gain staging | No | **New** |
| 10.3 | EQ and compression, low end first | No | **New** (see gaps) |
| 10.4 | Pan and stereo width | No | **New** (see gaps) |
| 10.5 | Check master headroom | No | **New** |
| 11.1 | Final review and export | No | **New** |

Totals: 31 plan lessons; 6 already in the app (left where they are); 25 new, placed in the courses. 11.1 became the last main card, Build the whole song (M51.1).

## Missing main lesson cards (decision changed on 2026-10-25)

- There is no separate "Make a Song" card. The new lessons are placed in the course they teach (Piano L5-L7, Kick
  Drums K1-K4, Drum sequencer S2, Mixing X1), easiest first. The "Linked" plan lessons stay where they already are.
- Each course ends with Special task cards that build one part of the same song. The last main card, **Build the whole
  song**, puts every part together in the DAW. Details are in `PLAN.md` ("Song-making lessons inside the courses") and
  `CONTENT.md`.
- **Mixing** is live (M40.1-M40.5 and the mix Special task). **DAW Features** stays "Coming soon".

## DAW features the plan needs that the Web DAW does not have (not changed: they belong to the DAW component)

| Plan needs | In the DAW | What the lesson does |
| --- | --- | --- |
| Piano roll chopper Alt+U with time multiplier (5.2) | No | The PDF's fallback, as a lesson tool: **Chop** (1/4, 1/8, 1/16) on the selected clip in the lesson workspace |
| Arpeggiator presets (6.1) | No | Lesson tool **Arp** (Up, Down, Up-down) that writes the arpeggio as notes |
| Ctrl+Up octave shift (1.3) | No shortcut | Lesson tool **Octave up / down** on the selected clip |
| Exhaust build-up sweep and down filter (4, 6, 7, 9) | Starter FX sounds: Riser, Sweep Up, Downlifter, Sweep Down | Those sounds are used as the sweep and the down filter |
| Channel gain / trim knob (10.2) | Track volume fader (and clip gain on sound clips) | Gain staging is done with the track level, measured with the engine's meters |
| EQ and compressor plugins (10.3) | No (only a low-pass filter automation) | Concept, listening and quiz; the hands-on high-pass waits for the EQ |
| Stereo width / mono knobs (10.4) | Pan only | Pan is practised and checked; width and mono are taught as concepts |
| Separate mixer routing (10.1) | Every track is its own mixer channel | "One channel per element" = one track per element, named after it |
