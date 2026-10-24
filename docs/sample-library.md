# Sample library

The sound browser (toolbar button **Sounds**) lists the **Starter packs** and any pack the user imports: browse, search,
audition, import, and **drag a sound onto the arrangement**; loops can be **fitted to the project tempo**. Trimming and fades are the next stage.

## Fitting a loop to the project tempo

A loop with a known tempo (`meta.bpm`, from the Starter pack or a "120 bpm" tag in an imported file's name) drops in with **Fit** on:
it is time-stretched, pitch unchanged, to the project tempo, and covers the same number of bars at any tempo. On the loop's track
header: the loop's own **BPM** (type it when an imported loop has no tag) and a **Fit** button (off = play as recorded).

* Engine: Signalsmith Stretch 1.4 (MIT, header-only, fetched by CMake). The stretch is rendered once, off the audio thread, when the
  project is loaded into the engine (a tempo change, a Fit toggle or a new loop re-sends it) and cached by file + ratio, so the
  audio thread only plays a finished buffer. Live playback and WAV export use the same buffer. The same input always gives the same audio.
* The result is exactly `frames / ratio` long, aligned to the first sample, so a loop that was a whole number of bars stays one.
  Limits: 0.25x to 4x; it sounds best between about 0.75x and 1.5x (the library's own advice), so a 90 BPM loop at 60 or 150 BPM will sound processed.
* Tested: the engine self-test stretches a click train at 120, 75 and 100 BPM (every beat within 5 ms, exact length, level, determinism);
  the app test exports the song at 120, 100 and 75 BPM and checks the loop's loudness follows the recorded loop played 120/90, 100/90 and
  75/90 times as fast (and matches that better than the unstretched loop), with no audio overruns while the tempo changes during playback.

## Dropping a sound on the arrangement

* Drop on empty space or any lane: a **new sample track named after the sound** ("Punch Kick"; an imported
  "KSHMR Big Kick 01 (A)" becomes "Big Kick 01"), coloured by category, with one clip at the bar you dropped on.
* Drop the same sound on its own lane: another clip on that track. Dropping on an existing clip is refused with a message.
* A sound is as long as it is: one-shots take 1 bar (more if longer than a bar at the project tempo), loops their own bar count;
  the song is lengthened if the clip would run past its end. The whole drop is one undo step.
* A sample track is a normal track: the clip holds one note at middle C (the sample's original pitch), so mute/solo, volume, pan,
  the piano roll (play it higher or lower, repeat it), undo and WAV export all work. The clip shows the sound's waveform.
* Loops (and anything tagged loop) are **gated**: a note-off cuts them, so shortening the clip trims the loop. One-shots always
  play to their end, so a kick on a 16th-note grid is not chopped. Stop fades everything out within 6 ms.
* The project stores only the library id and name (`track.sample`), never audio. If the sound is missing on this computer, the
  track is silent and its clips say "sound not in library".
* In beginner mode a drop that creates a track needs the "more than one track" feature (lesson M4.6); adding a clip needs the clip feature (M8.2).
* Engine: `loadProject` tracks of instrument `"sample"` carry `samplePath` and `gate`; up to 16 voices per track; stereo samples
  stay stereo (pan acts as balance); pitch resamples by linear interpolation; samples are never freed while a voice reads them.

## Where things live

| What | Where | In git? |
|---|---|---|
| Starter packs (generated, 143 sounds, ~36 MB) | `<userData>/sample-library/starter/` | No. Generated on first run (about 6 s), reused afterwards. |
| Imported packs | `<userData>/sample-library/imported/<Pack>/...` + `index.json` | No. `.gitignore` also blocks `*.zip`, `*.rar`, `sample-library/`, `starter-lib/`. |
| Projects | never contain audio, only a sample **id** (planned) | Project files only |

Licensed packs (FL Studio, KSHMR, anything the user buys) are for the user's own machine. They are copied into the user's
library folder, never into the repository, a project, or an export of the code.

## Starter packs (`packages/sounds`)

Written by us, so they can ship with the DAW and be used in lessons without licence problems. Every sound is synthesised by
pure, deterministic TypeScript (same bits every run): 12 kicks, 10 snares, 5 claps, 13 hats, cymbals, toms, percussion,
bass, keys, pads, synths, FX, and 24 loops (12 drum loops from 75 to 170 BPM, 6 bass loops, 6 chord loops with key and
progression tags).

* `npm run generate -w packages/sounds -- <folder>` writes the packs to a folder to listen to them.
* `npm test -w packages/sounds`: 41 tests check the audio objectively (no clipping, silence, DC offset or clicks; kicks are low,
  hats bright, pitched sounds in tune within 25 cents, loops an exact number of bars and tile without a click, chord loops contain
  the notes of their chords). They cannot tell whether a sound is *pleasant*; that needs ears.
* Changing any sound: bump `STARTER_VERSION` in `src/library.ts` so installed copies regenerate.

## Importing a pack

`+ Import zip…` or `+ Import folder…` (or `window.daw.importSamples("zip" | "folder")`).

1. A zip is unpacked with the system `tar` (`System32\tar.exe` on Windows) into a temporary folder that is deleted afterwards.
2. Audio files (`.wav .aif .aiff .flac .ogg`) are found; symlinks and `__MACOSX` junk are skipped.
3. **Brand word removal.** If one word starts at least 60% of at least 8 names ("KSHMR Big Kick 01"), it is taken out of the sample
   names, the folder names and the pack name. Ordinary drum words and numbers are never treated as a brand.
4. Category and sub-category come from the folder and file names (Kick, Snare, Clap, Hat, Cymbal, Tom, Percussion, Bass, Keys,
   Pad, Synth, FX, Loop, Other). Tags: `(A)`, `(F#m)` give a root note or minor key; `120 bpm` gives the tempo of a loop.
5. The **audio engine** decodes each file (so every format it supports works and decode code exists once), reports length,
   sample rate and a 96-bucket waveform. Unreadable files are listed in the result; the rest still import.
6. The audio is **copied** into the library, the original is not touched. Identical files (content hash) are never added twice.

`window.daw.removePack(name)` deletes an imported pack. Starter packs cannot be removed.

## Audition

Click a sound to hear it; click again to stop; **↑ ↓** in the list or the search box play the previous/next sound.
The engine plays it on a separate voice (not a track), with a 1 ms fade-in and a 6 ms fade-out, resampled to the device rate.
Previews do not disturb playback: the e2e test plays four sounds during song playback and requires zero overruns.

## Engine protocol additions (v0.4.0)

* `analyzeSample {id, path}` → `sampleInfo {id, ok, durationSec, sampleRate, channels, frames, peak, peaks[96]}`
* `previewSample {path, gain}`, `stopPreview`
* `status.preview`: position 0..1 of the playing preview, or -1

Decoding runs on one worker thread; the newest preview request wins; decoded samples are cached (24 most recent) and freed off
the audio thread.

## Lessons

`browser.samples` is a feature in the unlock registry, unlocked by **M6.2 "Meet the drum kit"**. In *beginner* mode the
Sounds button is locked until that lesson is completed.

## Tests

* `packages/sounds` (41), `apps/desktop/src/main/library/library.test.ts` (import, zip, brand removal, dedupe, persistence,
  analyzer), `apps/desktop/src/renderer/src/samples/filter.test.ts`, the engine `--selftest` (WAV/AIFF/FLAC decode, peaks,
  preview voice, click-free start/stop/switch).
* `node apps/desktop/e2e/samples.mjs`: 42 checks through the real window and engine (first-run generation, gating, search,
  audition, meters, drag payload, zip import with a damaged file, restart persistence, removal, engine restart).

## Known limits

* The first sound played in the first second after launch can take about half a second to start while the app finishes
  starting. Afterwards a click starts a sound in about 12-30 ms (measured with the e2e status stream).
* Imported formats: whatever JUCE's basic formats read (WAV, AIFF, FLAC, OGG). MP3/AAC are not included yet.
* The Starter sounds are synthesised, so pianos, strings and choirs sound like synths, not recordings. Real recordings can be
  added later as another pack.
