# Milestone 3 results

Date: 2026-10-19/20. Hardware: 11th Gen Intel Core i5-11400H, Focusrite USB output, Windows 11, Windows Audio (WASAPI shared), 48 kHz, buffer 480.

## Automated results

| Suite | Result |
|---|---|
| Shared model, ops, history, arrangement edits, migration (`npm test -w packages/shared`) | 31 / 31 |
| Desktop: storage/recovery, batches, snapshot (clips -> absolute ticks, song-length loop), editing logic, geometry | 35 / 35 |
| Engine self-test (offline): 360 note-start timings across 2 tracks / 6 tempo-rate-block combinations, mixer, drums, meters, **export** | pass; worst timing error **0 samples** |
| M1 end-to-end regression (`e2e/run.mjs`) | 16 / 16 |
| M2 end-to-end regression (`e2e/m2.mjs`) | 35 / 35 |
| M3 end-to-end (`e2e/m3.mjs`) | 35 / 35 |
| 10-minute 8-track soak with an export every 60 s (`e2e/soak.mjs 10 0 60`) | 59,886 callbacks, **0 overruns**, 0 xruns, peak load 8.3%; 9 exports, 0 errors, 171 ms each on average |

## Export verification

* Engine self-test: song length is exact (8 bars @ 120 BPM / 48 kHz = 768,000 frames; @ 90 BPM = 1,024,000); total = song + tail exactly;
  silent where nothing plays and after the tail; two renders are **bit-identical**; the export matches a live render at a different
  block size (1000 vs 512) to within 1e-6; the written WAV reads back as 48 kHz / stereo / 24-bit with the exact length and samples
  within 24-bit quantisation of the render; empty song and unwritable path are reported, not crashed.
* End-to-end: the real app writes a WAV that is parsed byte by byte: format PCM, 48 kHz, 2 ch, 24-bit, **480,000 frames = 8 s song + 2 s tail**,
  exact digital silence (0) before the clip and after its release, signal inside the clip's bars.
* Beside live playback: a 128-bar, 16k-note, 8-track project (130 s of audio) exported in 3.4 s (about 38x real time) while playing;
  live callback rate was 100.2/s during the export vs 100.2/s before it, 0 new overruns.

## Defects found by the tests and fixed in this milestone

1. **Block-size dependence in the sequencer.** A note ending exactly on a sample boundary could land one sample earlier or later
   depending on how the audio was chopped into blocks (floating-point noise in `ceil((tick - blockStart) / ticksPerSample)`).
   Inaudible, but it made export differ from live. Fixed with a tolerance-based tick-to-sample mapping and a symmetric event
   partition between blocks; the timing self-test now reports 0 samples of error (was 1).
2. **Drum noise depended on voice rendering order** (shared noise generator), so output varied with block size. Each voice now has its own seeded generator.

## Known limitations (not hidden)

* One export at a time; no cancel button in the UI yet (the engine supports cancellation); no stems or compressed formats.
* Clips resize from the right edge only; a clip cannot be dragged to another track; no clip rename UI yet (names are generated).
* Clip edits that the track rows can't show (more than ~4 tracks) scroll inside the arrangement panel.
* Meters are peak-since-last-status, not LUFS. Export does not normalise or dither.
* Real-device behaviour below 480-sample buffers is untested (see `buffer-size-results.md`).
* I could not listen to the audio; correctness is established by meters, offline tests and WAV analysis.
