# Collab DAW (J26-IM-303)

Standalone Windows DAW for beginner music production with (later) real-time collaboration.
Hybrid architecture: **Electron + React + TypeScript UI**, a **JUCE C++ audio engine process**, and (planned) a Node/TS collaboration server.
See `docs/adr/` for decisions.

## Status: Milestone 2 (multi-track song building) complete

* **M1:** piano roll, transport + tempo, local autosave + crash recovery, undo/redo, JUCE engine with offline timing tests.
* **M2:** up to 16 tracks (synth + synthesised drum kit), per-track volume / pan / mute / solo, master volume, level meters,
  mixer view, track list (add / rename / recolour / delete, all undoable), and the FL-style piano-roll tools:
  Draw, Paint, Select (box select, group move/resize), Delete (drag to erase), Mute note, Slice,
  Copy / Paste / Duplicate, Quantize, horizontal + vertical zoom, drum-name rows.
* **Not yet:** arrangement view / WAV export (M3), lessons and guidance (Components 1-2), collaboration server (Component 3),
  plugin hosting (VST3), remote recording (Component 4).

## Layout

| Path | Responsibility |
|---|---|
| `packages/shared` | Project model (ticks, track→clip→note, mixer fields), typed ops, pure `applyOp` (idempotent, validated), `invertOp`, undo `History`, `migrateProject`. Shared by client and future server. |
| `packages/engine-protocol` | NDJSON message types between Electron main and the engine. |
| `engine/` | JUCE C++ engine: multi-track tick sequencer (`Sequencer`), synth + synthesised drum kit, per-track mixer with smoothed gain/pan, master soft-clip, meters (`AudioEngine`), stdin/stdout bridge, `--selftest`, `--benchmark`. |
| `apps/desktop/src/main` | Owns project state: `ProjectService` (ops, batches = one undo step, undo/redo), `LocalStore` (snapshot + journal), `EngineBridge` (spawn/supervise/restart engine), `snapshot.ts` (mute/solo resolution, stable engine slots). |
| `apps/desktop/src/preload` | Typed `window.daw` bridge (context isolation). |
| `apps/desktop/src/renderer` | React UI: track list, piano roll (`editing.ts` holds the pure multi-note edit logic), mixer, meters, toolbar, diagnostics. UI state (tool, zoom, selection, playhead) is never part of project state. |
| `apps/desktop/e2e` | `run.mjs` (M1) and `m2.mjs` (M2) acceptance checks driving the real app over CDP, reading the engine's own meters; `soak.mjs` 8-track engine soak; `lib.mjs` shared helpers. |

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
node apps/desktop/e2e/soak.mjs 10   # 10-minute 8-track engine soak; prints overruns and hardware
```

## How audio stays independent of the UI and network

* The engine renders from its own immutable copy of the playable project; it never waits for a message per audio operation.
* The audio callback does no allocation, locking, I/O or JSON parsing. Commands go through atomics, an atomic model-pointer swap, and a lock-free FIFO for note previews.
* The callback records its own duration; `overruns` counts callbacks that exceeded the buffer time. These are *measured*, not assumed zero.
