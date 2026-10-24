# ADR-003: Arrangement model and WAV export

Status: accepted (M3).

## Arrangement

- A track owns **clips**; a clip owns **notes** relative to its own start. Moving a clip never rewrites its notes.
- **Clips on one track never overlap.** The shared `applyOp` rejects an overlapping `addClip`/`updateClip`, so the rule holds for
  every client and (later) the server. Two collaborators dropping clips on the same bars get an explicit rejection rather than a
  silent overwrite. Clips on *different* tracks may overlap freely.
- The song has an explicit length (`songBars`, 1-128). Playback loops over it and export renders exactly that long. It cannot be
  shortened below the end of the last clip.
- Clips can be resized only from the right edge; shrinking trims or removes the notes that no longer fit **in the same undo step**
  (the clip change is applied last so every intermediate state is valid). Splitting cuts a crossing note in two, so no note time is lost.
- Multi-step edits (split, resize, duplicate, paste...) are batches: validated together, applied all-or-nothing, one undo step.
- The audio engine is unchanged by clips: the main process flattens clips to absolute-tick notes. This keeps the real-time
  code small and keeps clip logic in the shared, testable TypeScript package.
- M2 projects are migrated on load: `songBars` becomes the length of the longest clip, so they play exactly as before.

## Export

- Rendering runs **inside the engine** on its own low-priority thread with a **separate AudioEngine instance**, using the same
  sequencer + mixer code as live playback. It never touches the live instance, so playback is undisturbed (measured, see
  `docs/m3-results.md`).
- Fixed format: 48 kHz, stereo, 24-bit PCM, independent of the audio device. Length = song length + 2 s tail (the tail lets
  synth releases and drum decays ring out; the sequencer is stopped exactly at the song end).
- Muted/soloed tracks follow the mixer state, exactly like playback.
- Determinism: the sequencer maps ticks to samples with a tolerance so an event on a sample boundary lands on the same sample
  whatever the block size; drum noise is generated per voice. Tests show the export equals a live render at a different block
  size to within 1e-6, and two exports are bit-identical.
- Not yet: stems (one file per track), MP3/FLAC, cancel button in the UI (the engine supports cancellation).
