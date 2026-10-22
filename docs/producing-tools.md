# Producing tools

Step 4 of the plan: the everyday tools of a beat maker. Unlock lessons are in `packages/shared/src/features.ts`.

| Tool | Where | Unlocked by |
| --- | --- | --- |
| Position readout (bar.beat.sixteenth) | toolbar, next to BPM | always |
| Tap tempo | toolbar (`TAP`) | always |
| Metronome | toolbar (`Click`) | always |
| Loop region | `Loop` key and the LOOP strip above the ruler | M8.2 (`arrangement.loop`) |
| Section markers | SECTIONS strip above the ruler | M13.1 (`arrangement.markers`) |
| Drum step sequencer | piano roll panel of a drum clip (`Steps` / `Roll`) | M6.2 (`seq.steps`) |
| Velocity ramp | `Ramp` in the piano roll strip and the step sequencer | M7.4 (`velocity.ramp`) |

## Position readout and tap tempo

`barBeat()` / `formatBarBeat()` / `tapTempo()` in `packages/shared/src/transport.ts`. The readout is `001.1.1` (bar, beat, sixteenth, all from 1).
Tap tempo averages the last 8 taps; a pause over 2 s starts a new count. The tempo box works in whole BPM, so the tapped value is rounded.

## Metronome

A click on every quarter note while playing, higher on the first beat of a bar. It is a UI setting (not in the project, never synced) kept by the main
process so a restarted engine gets it back. In the engine the sequencer emits `beat()` events with the same sample-exact partitioning as notes, so the
click stays on time through tempo changes and loop wraps; `ClickVoice` in `AudioEngine.h` renders it. The offline export never has it.

## Loop region

`Project.loop?: { startTick, endTick }` (op `setLoop`, at least one beat, inside the song, one undo step). In the LOOP strip: drag to draw, drag the
middle to move, drag an end to resize, double-click to clear. The `Loop` key switches it on over the selected clip (or bars 1-2) and off again.
Engine: `PlaybackModel.loopStartTick/loopEndTick`; the live sequencer wraps at the region end back to its start. A playhead that is already past the
region plays on to the song end, then loops into the region. **The export ignores the region** (the export engine never enables it), so an exported
file is always the whole song. A region that the song has become too short for is left out of the snapshot.

## Section markers

`Project.markers?: Marker[]` (`{ id, tick, name, color? }`, max 64, names 1-24 characters; op `setMarkers` replaces the whole list, kept in time
order). Double-click the strip to add one (its name opens for editing), drag to move, click to jump the playhead there, double-click the name to rename,
right-click to delete. Thin coloured lines run down through the tracks.

## Drum step sequencer

Sixteen pads per bar and one row per drum (kick, snare, rim, clap, hats, toms), one bar at a time (bar buttons). It edits the same notes as the piano
roll (one sixteenth long, loudness 100), so the two views always agree; a hand-played note slightly off the grid shows on the nearest step to its right.

* click = place or remove, Shift+click = accent (127), drag across a row = paint (one undo step per stroke)
* click a drum name to hear it and select the row; **Clear bar** and **Ramp** then act on that drum only
* **Copy to all bars** makes every other bar of the clip a copy of the one shown

Pure helpers and tests: `pianoRoll/steps.ts`, `steps.test.ts`.

## Velocity ramp

Sets the loudness of a group of notes so it climbs or falls from the first to the last, by time (notes sounding together get the same loudness).
Shapes: even, slow start then faster (a build), fast start then slower. Presets "Build up" and "Fade out". Acts on the selected notes, or on all notes of
the clip (in the step sequencer, on the selected drum). One undo step. `pianoRoll/ramp.ts`.

## Tests

* Engine self-test section 9: region wraps on the exact sample, notes inside play every pass and the one at the end never, a playhead past the region,
  region off plays the whole song, a beat on every 24000 samples at 120 BPM with the accent on every fourth, the click through a region wrap, audible only
  while playing and switched on.
* `packages/shared/test/transport.test.ts`, `apps/desktop/src/main/engine/snapshot.loop.test.ts`, `pianoRoll/steps.test.ts`.
* `apps/desktop/e2e/producing.mjs` (46 checks, driven with the real mouse; the click and the export are judged from the engine's level meter and
  the exported WAV bytes).

## Not done

Count-in before recording, time signatures other than 4/4, loop region drawn in the piano roll, marker colours chosen in the UI, step lengths other than
sixteenths, swing, per-step probability, pattern chaining.
