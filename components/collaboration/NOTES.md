# Progress and decisions

## 2026-10-15
- Decision: product is a standalone Electron desktop app (confirmed by user). Component 3 is a module in it.
- Project root is this folder (`D:\Reseach\Comp3`); layout is flat: `src/server`, `src/main`, `src/renderer`, `src/shared`.
- Built (PLAN.md steps 2-3, first version):
  - Session server: HTTP + WebSocket on port 4000, 6-digit join codes, unknown codes rejected, Yjs sync via y-websocket.
  - Electron shell: "Host session" (starts the server in-app, shows code and LAN IP) and "Join" (IP + code).
  - Stand-in DAW: 3 tracks, 3 draggable clips stored in a Yjs map.
  - `npm test`: headless check that edits sync, concurrent edits converge, bad codes are rejected (all pass).
- Not yet verified by hand: dragging a clip across two real app windows / two laptops.
- Gotcha: VS Code sets `ELECTRON_RUN_AS_NODE=1`; `npm start` goes through `run-electron.mjs` which clears it.
- Not done yet: Zustand store layer (clips are bound straight to Yjs for now), presence, shared playback, saving, cloud mode.
- Ports: 4000 (session + Yjs). Avoid Component 4's 52000-52002.

## Commands
- `npm start` build and launch the app (launch it twice to get two windows; host in one, join with 127.0.0.1 + code in the other)
- `npm test` headless sync test
- `npm run typecheck`

## Packaging (2026-10-15)
- `npm run dist` builds Windows installer + portable exe into `release/` (electron-builder, unsigned, default Electron icon).
- Deps moved to devDependencies because esbuild bundles everything into `dist/`.
- Presence: live mouse pointers for host and guests via Yjs awareness (renderer.ts).
- Session end/leave: host gets "End session" (server closes everyone with code 4001, deletes the doc, code can't be reused); guests get "Leave session". Guests are told "The host ended the session" and return to the start screen. Covered by `npm test`.

## Online mode groundwork (2026-10-15)
- `npm run server` runs the session server alone (no Electron): env `PORT`, `AUTH_TOKEN`. Endpoints: `GET /health`, `POST /sessions` (Bearer token -> {code, hostKey}), `DELETE /sessions/:code` (X-Host-Key), `GET /sessions/:code`.
- App: server address field accepts IP, `ip:port`, domain, or `https://...` (parseServerAddress); "Host online" button + access token field; Join uses the same address field.
- Join-code guessing: after 20 failed joins/min from one IP (X-Forwarded-For aware) joining is blocked for that minute.
- Not done: real hosting + TLS, JWT (a shared AUTH_TOKEN is used for now), persistence across server restarts, latency logging, guest notice when host app is closed.

## Network panel (2026-10-15)
- "Network" button opens a panel: quality rating, users online, ping (now/avg/min/max), jitter, lost pings, sync delay (last/avg/p95), download/upload rate, reconnects, ping graph, Export CSV.
- Ping: separate WebSocket to server `/ping` every 2 s (server echoes with its clock). Sync delay: each client puts a timestamped marker in Yjs awareness every 2 s; receivers compare with their arrival time using a server-clock offset taken from the lowest-RTT ping. Accuracy is about +/- half the ping, so on the same PC it reads near 0 ms.
- Code: `src/renderer/netstats.ts`, `src/shared/stats.ts`; tests in `scripts/netstats-test.ts` (part of `npm test`).
- CSV columns: time, kind (ping|sync), ms. Intended for evaluation conditions A/B/C.

## Switch from Yjs to a server-ordered operation list (2026-10-21)
Supersedes every earlier note about Yjs, y-websocket, awareness and the 3-clip stand-in DAW (those are removed).
- Why: Component 1's design (ADR-001) is a "server-sequenced operation log, same applyOp as the client". Its `applyOp` enforces rules Yjs cannot (max 16 tracks, never zero tracks, note ranges, idempotent opIds).
- `src/daw-shared/`: unchanged copy of Component 1's `packages/shared/src` (commit 16c306b). At integration delete it and import `@daw/shared`.
- Protocol (`src/shared/protocol.ts`): app connects to `/ops/<code>`; sends `hello`, `ops` (all-or-nothing batch), `presence`, `probe`; server answers `welcome` (snapshot or catch-up), `entries` (accepted ops with seq, to everyone incl. sender = ack), `reject`, `users`, `presence`, `probe`.
- Server (`src/server/room.ts`, `sessionServer.ts`): one `Room` per code holds the authoritative Project and the ordered log; every op goes through `applyOp`; clients may only send ops stamped with their own clientId; host's starting project is rebuilt via `buildSeedProject` (never trusted as-is). `/ping`, HTTP API (`POST /sessions` now takes `{project}`), rate limiting, host key, end session (close code 4001) unchanged.
- Client (`src/client/replica.ts`, `collabClient.ts`): own edits show at once (`view` = confirmed + pending); when the server's order differs, pending edits are replayed and any that no longer apply are dropped and reported (`dropped` event, shown as a notice). Auto-reconnect with catch-up by seq; unconfirmed edits are resent.
- Conflict behaviour (all covered by `npm test`): same field -> last in server order wins for everyone; different fields both survive; delete vs edit -> note deleted, the edit is dropped and the editor is told; two people adding the 16th track -> exactly one is kept.
- Test screen now uses Component 1's real model: tempo, master volume, tracks (volume, mute, delete, add), a 13x16 note grid, activity list coloured per person (seed of the planned history panel).
- Tests: `npm test` = 66 checks (room rules, replica fix-ups, seed validation, real sockets, reconnect, online HTTP API, stats). Two real Electron windows were also driven over DevTools (host, join, note, tempo, pointers, Network panel, end session): all passed (script was a scratch file, not kept in the repo).
- Not done yet: history panel with per-person colours and conflict-aware revert (planned), undo (needs Component 1's History hooked in), shared playback, saving sessions, accounts/login, JWT, X-Forwarded-For spoofing fix for the join rate limit, hosting the server.
- Open questions for Chamath: hooks needed in `ProjectService` (`onLocalOps`, `applyRemoteOps` without touching the undo stack); how a joined project is stored locally; project open/save/new.

## Window reset after a session ends (2026-10-21)
- Bug: after the host ended a session, or a guest left, the window kept the old session's data (code box, Network panel numbers, hidden project view) and showed the end message in the status line.
- Fix: `disconnect()` now calls `resetScreen()`, so the window returns to its launch state (status "Not connected", empty code box, empty workspace, Network panel cleared). The reason ("Session ended", "The host ended the session", "You left the session") appears in the notice bar for 6 s. Server address and token are kept on purpose; the Network panel's open/closed state is the user's choice and is kept.
- `npm run test:ui` (scripts/e2e-ui.mjs) drives two real app windows and checks the full flow plus that each window equals its launch state after end/leave, and that the same window can host again. Close other copies of the app first (they hold port 4000).
- Info bar has a Copy code button (copies the 6-digit code, shows "Copied!" for 1.5 s). Covered by npm run test:ui.
- Copy code is done by the main process (IPC copy-text -> Electron clipboard) because the page's own clipboard access is refused when the window is not focused. UI test reads the real Windows clipboard.

## History bar (2026-10-23)
- The right-hand activity list is replaced by a History bar at the top of the workspace: one segment per action (ops accepted together in one batch = one segment), coloured per person; hover shows who, time, what, and the values set (e.g. "Ana, 10:04:49, #5: set the tempo to 132 (132 bpm)"). Newest segment pulses. Legend chips (people + colours) sit at the right of the bar header. Keeps the last 150 segments; the counter shows the total.
- Colours are now chosen by the server (`src/shared/palette.ts`, first unused in join order, remembered per person so reconnecting keeps it), so two people never share a colour. The colour in `hello` is ignored.
- A person who joins late receives the last 100 actions with the snapshot (`welcome.history`), so the bar is not empty for them. People who left keep their colour on old segments.
- `describeDetail()` in `src/shared/describe.ts` writes the values an action set. `describeOp()` now accepts any object that lists track names.
- Not built yet (planned): clicking a segment to revert it with a conflict check ("Lee changed this after you. Revert anyway?"), preview of the project at an earlier step, undo.
- Tests: `npm test` 77 checks; `npm run test:ui` 23 checks (includes hover tooltip text and per-person colours).

## Click a segment to put the project back (2026-10-23)
- Clicking a history segment asks for confirmation, then puts the whole project back to just after that action, undoing everyone's later work. The grey marker at the left end of the bar restores the original project.
- It is a NEW action, not an erasure: the server computes the ops that turn the current project into the project at that step (`diffProjects` in `src/shared/restore.ts`, always verified by replay), records them in the log marked `restore: <step>`, and broadcasts them. History stays complete, so clicking a later segment (the one just before the restore) undoes the restore.
- Server: `Room.stateAt(seq)` rebuilds any step by replaying the log from `initial`; `Room.restoreTo(clientId, toSeq)`; message `{t:'restore', toSeq}`; refusals come back as `{t:'refused', reason}` (no such step, already like that, too old if the log was trimmed after 50,000 ops, cannot be restored exactly).
- Screen: restore segments are striped in the restorer's colour; the current state has a white underline; other people get a notice "<name> put the project back to just after step #N"; tooltips say "restored the project to step #N (M changes applied)" and hint "Click to put the project back to this point".
- Rules kept: track count stays 1..16 during a restore (deletes/adds are ordered to respect it); tracks whose clips differ are replaced.
- Anyone in the session can restore (with confirmation). A host-only option is an easy change if wanted.
- Edits other people had not yet confirmed when a restore lands are replayed on top; those that no longer apply are dropped and the person is told.
- Not integrated with Component 1's own undo stack yet (that needs hooks in ProjectService).
- Tests: `npm test` 94 checks (restore to every step, forward again, tracks added/deleted, 16-track swap, over sockets); `npm run test:ui` 39 checks (click, confirm, both windows change, forward again, start marker).
- Restore confirmation is now a centred popup (dimmed background) instead of a bar: title "Go back to step #N?" (or "...the original project?"), a line naming the person and action at that step, how many later changes it undoes, Cancel (default focus) and Restore. Escape, Cancel, or a click on the dimmed background closes it. The count updates if more actions arrive while it is open. `npm run test:ui` is now 39 checks.
