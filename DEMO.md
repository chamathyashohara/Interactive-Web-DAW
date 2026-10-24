# Demo guide: the four components together (J26-IM-303)

This branch (`demo/integration`) puts all four research components in one repository so they can be shown to the supervisor.
Nothing was rewritten: each component keeps its own code, tests and README.

| # | Component | Where | What it is | How to run it |
|---|---|---|---|---|
| 1 | Interactive educational lessons | `apps/desktop` (merged from `feature/learning`) | Lessons, kick-drum and step-sequencer courses, inside the DAW window | with the DAW |
| 2 | **Beginner-friendly adaptive DAW** | `apps/desktop`, `engine/`, `packages/` | The studio: lesson-gated features, red out-of-key notes, step sequencer, loop, markers, automation, study recording | see below |
| 3 | Real-time collaboration | `components/collaboration` | Standalone Electron test app + session server: several producers edit one project, presence, history bar, network stats | `npm start` in that folder |
| 4 | Remote recording | `components/remote-recording` | C++/Qt `ProducerStudio.exe` + `PerformerClient.exe`: record a performer over the network, each side recording locally | needs a built copy (see below) |

## 1 + 2: the DAW with the lessons

```bash
npm install
npm run engine:build            # once: builds the audio engine (daw_engine.exe)
npm run build -w apps/desktop
node_modules/electron/dist/electron.exe apps/desktop     # run the app
```

Note: if a terminal sets `ELECTRON_RUN_AS_NODE`, clear it first (`env -u ELECTRON_RUN_AS_NODE ...`) or the window will not open.
`npm run dev` (hot reload) does not start on Node 24 here; use the built app.

Checks: `npm run typecheck`, `npm test` (shared 118, sounds 41, desktop 589), `node apps/desktop/e2e/<suite>.mjs` for the end-to-end suites.

## 3: collaboration

```bash
cd components/collaboration
npm install
npm start               # open it twice to get two windows on one session
npm test                # 88 checks
```

Known: 87 of 88 checks pass; `wrong code: the app gives up with "cannot join"` fails. It fails the same way on the component's own
branch (`feature/collaboration`), so it is not caused by this integration.

It carries its own copy of the DAW's shared model (`src/daw-shared`, see its `SOURCE.md`). Connecting it into the DAW window is **not**
done in this branch: the components run side by side, not as one window.

## 4: remote recording

It is a separate C++ project (CMake, MSVC and Qt). **No built executables are in the repository.** To show it, build it on a machine
with the toolchain (`components/remote-recording/docs/build/WINDOWS_BUILD.md`) or use a build from its author. Its README states that
all its testing so far was done with both applications on one PC; two-PC and wireless-link tests are not yet done.

## What is and is not integrated

* **Integrated (one codebase, one window):** lessons + DAW.
* **Side by side (same repository, separate programs):** collaboration, remote recording.
* **Not done:** collaboration inside the DAW window; recorded audio from remote recording becoming a clip in the DAW; VST3 plugin hosting is
  partial (stages 1-3a, see `docs/vst3-plan.md`).
