# Collab DAW (J26-IM-303)

Standalone Windows DAW for beginner music production with (later) real-time collaboration.
Hybrid architecture: **Electron + React + TypeScript UI**, a **JUCE C++ audio engine process**, and (planned) a Node/TS collaboration server.
See `docs/adr/` for decisions.

## Status: Milestone 3 (arrangement + WAV export) complete

* **M1:** piano roll, transport + tempo, local autosave + crash recovery, undo/redo, JUCE engine with offline timing tests.
* **M2:** up to 16 tracks (synth + synthesised drum kit), per-track volume / pan / mute / solo, master volume, level meters,
  mixer view, track list (add / rename / recolour / delete, all undoable), and the FL-style piano-roll tools:
  Draw, Paint, Select (box select, group move/resize), Delete (drag to erase), Mute note, Slice,
  Copy / Paste / Duplicate, Quantize, horizontal + vertical zoom, drum-name rows.
* **M3:** arrangement view (several non-overlapping clips per track on a timeline: create by double-click, drag to move,
  drag the right edge to resize, split at the playhead, duplicate, delete), an explicit song length, clip-aware piano roll
  (it edits the selected clip), and **offline WAV export** (48 kHz / 24-bit stereo, song length + 2 s tail) that runs beside
  live playback. Projects from M2 migrate automatically.
* **Not yet:** lessons and guidance (Components 1-2), collaboration server (Component 3), plugin hosting (VST3),
  audio clips / remote recording (Component 4), effects, automation.

## Layout

| Path | Responsibility |
|---|---|
| `packages/shared` | Project model (ticks, track→clip→note, mixer fields, song length), typed ops, pure `applyOp` (idempotent, validated), `invertOp`, undo `History`, `migrateProject`, pure arrangement edits (`arrangement.ts`: move/resize/split/duplicate). Shared by client and future server. |
| `packages/engine-protocol` | NDJSON message types between Electron main and the engine. |
| `engine/` | JUCE C++ engine: multi-track tick sequencer (`Sequencer`), synth + synthesised drum kit, per-track mixer with smoothed gain/pan, master soft-clip, meters (`AudioEngine`), offline render + WAV export (`Export`), stdin/stdout bridge, `--selftest`, `--benchmark`. |
| `apps/desktop/src/main` | Owns project state: `ProjectService` (ops, batches = one undo step, undo/redo), `LocalStore` (snapshot + journal), `EngineBridge` (spawn/supervise/restart engine), `snapshot.ts` (mute/solo resolution, stable engine slots). |
| `apps/desktop/src/preload` | Typed `window.daw` bridge (context isolation). |
| `apps/desktop/src/renderer` | React UI: arrangement (track headers + clip lanes), piano roll (`editing.ts` holds the pure multi-note edit logic), mixer, meters, toolbar, export progress, diagnostics. UI state (tool, zoom, selection, playhead) is never part of project state. |
| `apps/desktop/e2e` | `run.mjs` (M1), `m2.mjs` (M2) and `m3.mjs` (M3) acceptance checks driving the real app over CDP, reading the engine's own meters and parsing exported WAVs; `soak.mjs` 8-track engine soak (optionally with periodic export); `lib.mjs` shared helpers. |

## Build and run (Windows)

Requirements: Node 22+, Visual Studio 2022 (C++ workload), CMake 3.22+.

```bash
npm install
npm run engine:configure      # fetches JUCE 8.0.15 via CMake FetchContent
npm run engine:build
npm run build -w apps/desktop
npx electron apps/desktop     # or: npm run dev
```

## Tests

```bash
npm test                      # shared model, history, storage/recovery, piano-roll geometry
npm run engine:selftest       # offline: sequencer sample-accuracy (2 tracks) + mixer (pan, mute, master, drums, meters)
npm run engine:benchmark   # offline CPU cost per block size (64-1024), 8 tracks, no audio device
node apps/desktop/e2e/run.mjs # M1 end-to-end checks against the built app (needs an audio device)
node apps/desktop/e2e/m2.mjs  # M2 end-to-end checks (tracks, mute/solo/pan/volume via engine meters, tools, recovery)
node apps/desktop/e2e/m3.mjs  # M3 end-to-end checks (clips, song length, playback follows clips, WAV export parsed byte by byte, M2 migration)
node apps/desktop/e2e/soak.mjs 10 0 60   # 10-minute 8-track engine soak with an export every 60 s; prints overruns and hardware
```

## How audio stays independent of the UI and network

* The engine renders from its own immutable copy of the playable project; it never waits for a message per audio operation.
* The audio callback does no allocation, locking, I/O or JSON parsing. Commands go through atomics, an atomic model-pointer swap, and a lock-free FIFO for note previews.
* The callback records its own duration; `overruns` counts callbacks that exceeded the buffer time. These are *measured*, not assumed zero.
