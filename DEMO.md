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

The same code also runs **inside the DAW window** as the `@daw/collab` package (the **Collaborate** button): host or join on the same
network (LAN), or on a separate server for a different network (`npm run server`, optionally with an `AUTH_TOKEN`), with live pointers
and a Network panel (ping, jitter, loss, sync delay, CSV export). Still only in the standalone app: the history bar and restore.
Checks: `node apps/desktop/e2e/collab.mjs` (LAN, two windows) and `node apps/desktop/e2e/collab-online.mjs` (server + token).

## 4: remote recording

Inside the DAW, the **Live recording** button (next to Collaborate) opens Producer Studio or Performer Client ("I'm the Producer" /
"I'm the Singer"), lists the takes they save, and adds one to the project as a new sample track. In a same-network collaboration session
the Producer can share the recording session's address and pairing code with the room. See `docs/recording-integration.md`.
Checks: `node apps/desktop/e2e/recording.mjs` and `node apps/desktop/e2e/recording-room.mjs`.

It is a separate C++ project (CMake, MSVC and Qt). **No built executables are in the repository.** To show it, build it on a machine
with the toolchain (`components/remote-recording/docs/build/WINDOWS_BUILD.md`) or use a build from its author. Its README states that
all its testing so far was done with both applications on one PC; two-PC and wireless-link tests are not yet done.

## Installer / portable exe

`npm run dist` builds `release/Collab-DAW-setup-*.exe` and `release/Collab-DAW-portable-*.exe`: the DAW, the audio engine and the two remote-recording programs in one package, with nothing else to install. See `docs/packaging.md`.

## What is and is not integrated

* **Integrated (one codebase, one window):** lessons + DAW.
* **Integrated (collaboration):** host / join, live pointers and the Network panel are in the DAW window (`packages/collab`).
* **Side by side (same repository, separate programs):** the standalone collaboration app, and the two remote-recording programs themselves.
* **Integrated (remote recording):** the Live recording tab starts the two programs, adds their takes to the project and carries the room's
  address/code on a same network. The programs themselves stay separate Qt windows (not built here: needs Qt).
* **Not done:** the collaboration history bar / restore inside the DAW window; sharing recorded audio with the other people in a session; VST3 plugin hosting is
  partial (stages 1-3a, see `docs/vst3-plan.md`).
