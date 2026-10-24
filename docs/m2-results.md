# Milestone 2 results

Date: 2026-10-17/18. Hardware: 11th Gen Intel Core i5-11400H, Focusrite USB output, Windows 11, Windows Audio (WASAPI shared), 48 kHz, buffer 480.

## Automated results

| Suite | Result |
|---|---|
| Shared model + history + tracks/mixer ops (`npm test -w packages/shared`) | 17 / 17 |
| Desktop: recovery, undo, batches, snapshot/mute/solo, editing logic, geometry (`npm test -w apps/desktop`) | 32 / 32 |
| Engine self-test (offline): 360 note-start timings across 2 tracks, 6 tempo/sample-rate/block combinations, plus mixer tests | pass, worst error 1 sample |
| M1 end-to-end regression (`e2e/run.mjs`) | 16 / 16 |
| M2 end-to-end (`e2e/m2.mjs`) | 35 / 35 |
| 10-minute soak, 8 tracks (6 synth + 2 drums), moving faders/pans, 10 project reloads per second (`e2e/soak.mjs`) | 59,890 callbacks, **0 overruns**, 0 xruns, peak load 7.9% |

Soak caveat: for about a minute of the run I also executed the offline benchmark on the same machine, adding CPU contention.
That makes the result conservative rather than flattering, but it was not a clean-room run. Result applies to this hardware and buffer size only.

## How mute / solo / volume / pan were verified

The M2 end-to-end suite reads the audio engine's own per-track and master peak meters, so these check what is actually rendered:

* Mute: muted track meter < 0.0005 while others > 0.005. Unmute restores it.
* Solo: soloed track plays, every other track < 0.0005. Two solos coexist. Clearing restores all.
* Volume: lowering a fader from 80 to 30 changed the rendered peak by a ratio of 0.141 (theory for the squared fader curve: 0.141).
* Pan: hard left gives right master meter 0.0000 / left 0.056; hard right the mirror image.
* Master fader at 0: master meters 0.0000 while track meters stay live.
* After Stop every meter returns to 0.

## Known limitations (not hidden)

* Meters are peak-since-last-status (about 30 Hz), not RMS/LUFS; no peak-hold.
* Preview of a note on a muted/soloed-out track is silent (it goes through the track's mixer path).
* Drum sounds are synthesised, intentionally simple; they are not meant to compete with sampled kits.
* One clip per track (4 bars) until M3 introduces the arrangement view.
* Real-device behaviour at buffers below 480 is untested (see `buffer-size-results.md`).
* I could not listen to the output; sound quality has been checked only through meters and offline tests.
