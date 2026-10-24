# Demo guide: the four components together (J26-IM-303)

This branch (`demo/integration`) puts all four research components in one repository so they can be shown to the supervisor.
Nothing was rewritten: each component keeps its own code, tests and README.

| # | Component | Where | What it is | How to run it |
|---|---|---|---|---|
| 1 | Interactive educational lessons | `apps/desktop` (merged from `feature/learning`) | Lessons, kick-drum and step-sequencer courses, inside the DAW window | with the DAW |
| 2 | **Beginner-friendly adaptive DAW** | `apps/desktop`, `engine/`, `packages/` | The studio: lesson-gated features, red out-of-key notes, step sequencer, loop, markers, automation, study recording | see below |
| 3 | Real-time collaboration | `components/collaboration` | Standalone Electron test app + session server: several producers edit one project, presence, history bar, network stats | `npm start` in that folder |
| 4 | **Remote recording** | `packages/recording` + `apps/desktop` (ported from the C++/Qt original in `components/remote-recording`) | Record a performer over the network, each PC recording its own microphone, with live talkback and a verified copy of the take, **inside the DAW window** | the **Remote recording** button in the DAW |

## 1 + 2: the DAW with the lessons

```bash
npm install
npm run engine:build            # once: builds the audio engine (daw_engine.exe)
npm run build -w apps/desktop
node_modules/electron/dist/electron.exe apps/desktop     # run the app
```

Note: if a terminal sets `ELECTRON_RUN_AS_NODE`, clear it first (`env -u ELECTRON_RUN_AS_NODE ...`) or the window will not open.
`npm run dev` (hot reload) does not start on Node 24 here; use the built app.

Checks: `npm run typecheck`, `npm test` (shared 118, sounds 41, desktop 618, recording 39 plus 3 interop tests that need the C++ probe), `node apps/desktop/e2e/<suite>.mjs` for the end-to-end suites.

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

Inside the DAW, the **Remote recording** button (next to Collaborate) opens a four-step panel: microphone, connect (Producer creates a session / Singer joins),
record (consent, a readiness checklist for both PCs, Record / Stop), takes (Add to project, plus a verified copy of the Singer's take). In a same-network
collaboration session the Producer's session is shared with the room automatically and the Singer joins in one click. See `docs/recording-integration.md`.
Checks: `node apps/desktop/e2e/remote-recording.mjs` (two real windows), `recording-room.mjs`, `recording.mjs`, and `npm test`.

It used to be two separate Qt programs; it was ported to TypeScript with the same wire protocols (`docs/adr/ADR-004-remote-recording-in-typescript.md`), and
the port is tested against the original C++ library. The original source is still in `components/remote-recording` and nothing needs to be built for the DAW to
use remote recording. Everything so far was verified with both sides on one PC; two-PC and wireless-link tests are not yet done.

## Installer / portable exe

`npm run dist` builds `release/Collab-DAW-setup-*.exe` and `release/Collab-DAW-portable-*.exe`: the DAW (remote recording included) and the audio engine in one package, with nothing else to install. See `docs/packaging.md`.

## What is and is not integrated

* **Integrated (one codebase, one window):** lessons + DAW.
* **Integrated (collaboration):** host / join, live pointers and the Network panel are in the DAW window (`packages/collab`).
* **Side by side (same repository, separate programs):** the standalone collaboration app, and the original C++/Qt remote-recording programs (kept as the reference).
* **Integrated (remote recording):** the Remote recording panel runs the whole session in the DAW window (TypeScript port), adds takes to the project and carries
  the room's address/code on a same network.
* **Not done:** the collaboration history bar / restore inside the DAW window; sharing recorded audio with the other people in a session; VST3 plugin hosting is
  partial (stages 1-3a, see `docs/vst3-plan.md`).
