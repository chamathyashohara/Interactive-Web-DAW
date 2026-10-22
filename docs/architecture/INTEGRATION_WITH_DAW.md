# Integrating Component 04 with the group DAW

**Status:** Option A is prepared and rehearsed, not merged. Written 20 Oct 2026,
updated 20 Oct 2026 after a nesting rehearsal (§3.1).
**Group repository:** `github.com/chamathyashohara/Interactive-Web-DAW` (branch `feature/remote-recording`).
**Related:** ADR-001 (two executables, shared core), ADR-016 (Qt-free control transport).

This project was built as a standalone pair of Windows applications, which is what the
panel asked for when they questioned whether Component 04 should be "the web thing or a
standalone application". That decision is unchanged. This document records how the
standalone engine meets the rest of the DAW, and what each option costs.

## 1. What does not line up

| | Group DAW | Component 04 |
|---|---|---|
| UI | Electron + React + TypeScript | Qt 6 Widgets (C++) |
| Audio I/O | JUCE, output only | miniaudio / WASAPI, input and output |
| Build | npm workspaces, CMake for the JUCE engine | CMake presets, MSVC toolset pinned to v143 |
| Process model | Electron main spawns `daw_engine.exe`, NDJSON over stdin/stdout | two `.exe`s, TCP control protocol 1.2 between PCs |
| Data model | MIDI only: track -> clip -> **note**, integer ticks at PPQ 960 | float32 mono 48 kHz WAV takes on disk, SHA-256 verified |

Four consequences:

1. **The DAW has no audio in its project model.** `packages/shared/src/model.ts` defines
   `Note`, `Clip`, `Track`, `Project`, and `Clip.notes` is a record of MIDI notes. There
   is no audio clip and no file reference; even the M3 WAV export is output-only. A take
   produced here therefore has nowhere to go on their timeline until an `AudioClip` type
   exists. That is a change to **their** shared package, not this one, and it must be
   agreed before either side builds against it (see §4).
2. **Two audio engines.** JUCE owns the output device; miniaudio opens input and output
   independently. They coexist in WASAPI shared mode, but there is no shared clock and no
   shared transport, so the DAW's play head cannot drive this recorder without a bridge.
3. **Two UI toolkits.** Qt Widgets cannot be hosted inside an Electron renderer. The
   session, live-audio and transfer panels stay in their own windows. Any plan that puts
   them inside the DAW window should be dropped rather than attempted.
4. **A separate build step.** `cmake/RrToolchainChecks.cmake` fails on any compiler
   outside MSVC 1930-1949 and refuses to build the apps with a non-MSVC compiler, so
   `npm install && npm run build` in the group repository will never build this component.
   The group's build instructions must name the extra step.

## 2. What does line up

- The DAW's ADR-001 states that audio never passes through the collaboration server and
  that assets are referenced by hash. Stage 11 here transfers takes on their own TCP
  connection with per-chunk and whole-file SHA-256 (ADR-020). The two designs agree,
  independently.
- Both sides are Windows x64 only in practice.
- **`rr_session_probe.exe` is the integration surface, not the Qt apps.** It is Qt-free,
  headless, and drives the same `SessionController` the GUI drives. Integration is then
  "supervise one more child process", which is a pattern the DAW already implements in
  `apps/desktop/src/main/engine/engineBridge.ts`.

## 3. Option A - companion application (recommended for the current deadline)

Bring this repository into the group repository with its history intact, rather than
copying files:

```bash
# in the group repository, on feature/remote-recording, branched from develop
git remote add rr <path-or-url-of-this-repository>
git fetch rr
git subtree add --prefix=apps/remote-recording rr master
```

`git subtree` keeps all commits and their authorship inside the group repository, which
matters because that repository currently records whole milestones as single commits and
per-member contribution is hard to see.

The DAW then launches `ProducerStudio.exe` as a companion application, and the operator
imports the recorded WAV. This is honest, it is what the panel approved, and it can be
delivered in a day.

### 3.1 Preconditions on this side (done and rehearsed)

The nesting was rehearsed by copying this project to `apps/remote-recording/` in a local
clone of `origin/develop` and building it there. Nothing was committed or pushed to the
group repository. Results:

| Check | Result |
|---|---|
| `.gitignore` still matches when nested | `build/` and `takes/` ignored at the nested path (`git check-ignore` confirms `apps/remote-recording/.gitignore:4`); 255 files would be tracked, 0 build artefacts |
| Configure from the nested path | OK (Visual Studio 17 2022, v143, Qt 6.11.3) |
| Build from the nested path | 0 errors, 0 warnings (`/W4`) |
| `ctest` from the nested path | 175/175 passed |
| Build info reports a real commit | OK — reports the **group** repository's commit when nested, this repository's when standalone |

Two fixes were needed to get there, both already made:

1. `.gitignore` uses `build/`, not `/build/` — an anchored pattern stops matching once the
   project is nested, and the build tree would have been staged.
2. `cmake/RrVersion.cmake` no longer requires a `.git` directory at the project root. A
   subtree has no `.git` of its own, so the old check made every nested build report
   `commit unknown` in its logs and in `--version`. `git rev-parse` locates the enclosing
   repository by itself.

Also aligned with this repository's conventions: the ADRs now live in `docs/adr/`
(flat, as in the group repository) instead of `docs/architecture/adr/`, and the C++ sources
follow the group's naming, brace and comment style (`PascalCase.h`, `camelCase` members,
Allman braces, no namespaces, `/** */` on declarations).

**Not done:** the `git subtree add` itself, which has to be run by whoever owns the group
repository's `feature/remote-recording` branch.

## 4. Option B - a recorder bridge (the real integration)

Two pieces, which can be built in either order but only pay off together.

**4.1 On this side: an NDJSON mode for `rr_session_probe`.**
Line-delimited JSON on stdin/stdout, mirroring `packages/engine-protocol` so the DAW's
main process can supervise it exactly as it supervises the audio engine. Proposed
messages (to be agreed with the group before either side implements):

Commands in (DAW -> recorder):

| `t` | fields | meaning |
|---|---|---|
| `createSession` | `interface` | producer creates a session; replies with id and pairing code |
| `joinSession` | `host`, `code` | performer joins |
| `arm` | — | readiness check; replies with the itemised checklist |
| `record` | `leadMs?` | coordinated start (ARM -> SCHEDULE_START) |
| `stop` | — | coordinated stop |
| `requestCopy` | `takeId` | Stage 11 verified take transfer |
| `close` | — | leave the session |

Events out (recorder -> DAW):

| `t` | fields |
|---|---|
| `ready` | `appVersion`, `protocol`, `role` |
| `session` | `sessionId`, `pairingCode`, `peerConnected` |
| `readiness` | `items[]` (id, ok, reason) — drives the DAW's own Record button |
| `takeStarted` | `takeId`, `startedAtNs`, `plannedNs` |
| `takeFinalised` | `takeId`, `path`, `frames`, `sampleRate`, `status`, `sha256` |
| `transfer` | `takeId`, `state`, `path`, `sha256`, `verified` |
| `status` | counters: live sender/receiver, jitter buffer, clock offset, best RTT |
| `error` | `code`, `message` |

Nothing in that list needs Qt, and all of it already exists inside `SessionController`;
the work is a serialiser and a command loop, not new behaviour.

**4.2 On the DAW side: `RecorderBridge` plus an `AudioClip` model type.**
`RecorderBridge` is `engineBridge.ts` with a different executable and command set — same
spawn, supervise, restart and re-push-state shape. `AudioClip` is the larger change and
belongs to Component 02: a new type in `packages/shared`, `addAudioClip` /
`moveAudioClip` / `deleteAudioClip` ops, validation in `applyOp`, inverses in `invertOp`,
and audio-file playback in the JUCE engine so the clip is audible on the arrangement.

A `takeFinalised` event then becomes an `addAudioClip` op carrying the path and the
SHA-256, and the verified take appears on the DAW timeline.

**Dependency:** 4.2 cannot start until the group agrees the `AudioClip` shape, and 4.1 is
useless without it. Raise it with the group before anything else.

## 5. Recommendation

Do Option A this week so that integration exists and is merged. Treat Option B as the
demonstrated integration path, and report it as partial if the `AudioClip` work does not
land in time.

Neither option is on the critical path for this component's own research contribution.
Packet segmentation, reassembly and the latency-tolerance measurements stand on their
own, and what they still need is the two-PC run in
[PP1_ACCEPTANCE_MATRIX.md](../requirements/PP1_ACCEPTANCE_MATRIX.md) — not deeper
coupling to the DAW.
