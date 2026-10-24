# Song-making lessons → DAW tools (audit)

An audit of the 31-lesson *Song-Making Learning Workflow* against the DAW: which tool each lesson needs, and whether it
already exists, was just added, or is still a gap. Only the genuinely missing small tools were built; nothing existing was rebuilt.

## Added for the lessons (this change)

| Tool | Lesson(s) | How it works |
| --- | --- | --- |
| **Chopper** (`Chop` button / **Alt+U**) | 5.2 Chop the bass | Slices each held note into equal pieces at the toolbar grid size, back to back (a root note becomes a 1/8 rhythm). `pianoRoll/chop.ts`. |
| **Arpeggiator** (`Arp ▾` button: up / down / up-down) | 6.1 Add an arp preset | Spreads a chord (notes that start together) into a sequence at the grid size, cycling through the chord's pitches. `pianoRoll/arp.ts`. |
| **Transpose** (**Ctrl+↑/↓** octave, **Shift+↑/↓** semitone) | 1.3 Repeat and transpose, 5.1 Bass from roots | Shifts the selection as a group (chords stay intact), clamped to 0–127. `pianoRoll/editing.ts` `transposeOps`. |
| **Synth presets** (picker on each synth track) | 1.4 Layer on pads/strings, 5.1 Bass, 6.1 Arp | Keys / Pad / Strings / Pluck / Lead / Bass — distinct timbres from one parameter-driven engine synth (envelope, detuned oscillators, tone). `packages/shared/src/synth.ts`, `setSynthPreset` op. |

All three are pure op builders (one undo step), with `pianoRoll/chopArp.test.ts` (10 unit tests) and `apps/desktop/e2e/pianotools.mjs` (9 checks).

## Already existed (do not rebuild)

| Lesson need | Existing tool |
| --- | --- |
| Transport, loop, BPM, bar:beat position (0.1, 8.2) | play/stop, loop region, tempo field, BPM readout |
| Piano roll draw/select/delete/snap, bars & beats (0.2) | piano roll + grid |
| Chords, key/scale highlighting, out-of-key feedback (1.1, 8.1) | synth, **key help** (scale highlight + red out-of-key notes + Fix) |
| 4-chord progression, loop (1.2) | piano roll + loop region |
| Copy/paste/duplicate, between tracks (1.3, 1.4, 5.1) | shared clipboard (paste into any track), duplicate |
| Drum beat: kick/hats/clap (2.1–2.3) | **step sequencer** + sample browser |
| Clips, sections, duplicate across tracks (3.1, 3.2, 8.3, 8.4) | arrangement clips, clip names (A/B/C), section markers |
| **Transition FX: sweep up, down-filter** (4.1, 4.2, 6.2, 7.3, 9.1) | **Starter FX sounds** (Riser, Sweep up/down, Downlifter, Whoosh, Impact) in the sound browser's FX category |
| Low-pass filter automation with a live Hz display (7.2, 7.3, 9.1) | **automation lanes** (filter curve, value→Hz readout) |
| Bass instrument, octave shift (5.1) | synth track + transpose (added above) |
| Velocity / loudness shaping for the build-up (7.x) | **velocity ramp** |
| Mixer: one channel per element, faders, pan, meters, master meter (10.1, 10.2, 10.5) | mixer (per-track strip, fader, pan knob, LED meters, master meter) + clip gain (dB) |
| Export / render dialog, save the project (11.1) | **Export window** (WAV, tail) + Save/Save as to a `.daw` file |

## Still gaps (not built — larger or low value in our current engine)

| Lesson need | Why not built now | Recommendation |
| --- | --- | --- |
| **EQ + compressor** (10.3) | Real DSP; a parametric EQ and a compressor are large features. | Via **VST3 hosting** (stages 1–3a done) — host FabFilter/stock plugins. Filter automation already covers a basic low-pass. |
| **Stereo width knob + mono button** (10.4) | Only affects **stereo** sources; our synths/drums are mono, so it would do nothing for most tracks (and a control that does nothing is a false claim). Pan already exists. | Build once there are stereo instruments (stereo samples already pan as a balance). |
| **Chord ghost notes** while writing a melody (8.1) | Needs the lesson to know the current chord; the DAW stores notes, not a chord track. | Lesson-module feature (it can read the clip's chords and render ghosts), or a future "chord track". |
| Pre-fader **trim** distinct from the fader (10.2) | Covered in practice by per-clip gain (dB) + the fader. | Optional; add a channel trim if gain staging needs it separately. |
| **Sidechain** compression (optional, 10.3) | Needs a compressor first. | After EQ/compressor / VST3. |

## Note on numbering

The lessons assume **one chord per bar → one clip = 4 bars** (the doc's own correction). Our clips and song length are in bars, so
the bar numbers in the workflow map onto arrangement clips directly.
