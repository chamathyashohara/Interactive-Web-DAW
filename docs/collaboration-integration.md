# Collaboration integration (Component 3 → the DAW)

Bringing the real-time collaboration module into the DAW so several people edit one project live. Done in phases.

## Phase 1 — the module runs on the DAW's shared model (done)

The collaboration code is now a workspace package, **`@daw/collab`** (`packages/collab`), importing the DAW's real
`@daw/shared` instead of the frozen copy it shipped with (`src/daw-shared`). It exports `CollabClient` (the DAW connects with
this), `startSessionServer` (a host runs this), `Room`, `Replica`, the protocol and `buildSeedProject`.

Proven in `packages/collab/test/sync.test.ts` (7 checks): the server orders ops through the current `applyOp`, two replicas
converge, and over real sockets one client's edit reaches the other and both converge — **including the ops added since the module
was written** (loop region, section markers, automation), which now sync because the module uses the live shared model.

### Changes made while re-homing the module (tell the Component 3 author so they can sync back)

- Imports `../daw-shared` → `@daw/shared`.
- `shared/seed.ts`: the seed project is now based on `createProject`, so the fields added since (song length, key) are set; the host's
  tracks are still rebuilt through `applyOp` as before.
- `shared/describe.ts`: added plain-English cases for the new op types, with a default, so the activity list covers every op.
- `server/sessionServer.ts`: `startSessionServer` now reports the **actually bound port** (was returning the requested port, so
  starting on port 0 gave an unusable `0`). Needed for hosting on an ephemeral port from the app.
- The package's `tsconfig` turns off `noUncheckedIndexedAccess` to match the module's original strictness (its logic is unchanged).

## Phase 2 — host / join from the DAW (done)

The DAW's main process holds a live session (a `CollabClient`, and a `SessionServer` when hosting). While a session is active:

- The renderer's edits (`op:dispatch` / `op:batch`) are routed to the collaboration client instead of the local `ProjectService`,
  and the client's `change` events (the user's own and everyone else's) are pushed to the engine and the renderer through the same
  `project:update` channel — so the shared project is what plays and shows, with no change needed in the rest of the UI.
- **Undo is off (option A):** `history:undo/redo` do nothing during a session and the buttons are disabled (the shared history/restore
  takes their place). This avoids two people's undos fighting.
- On leaving (or the host ending it), the final shared project is **adopted into the local project** so the result is kept, and solo
  editing (with local undo) resumes.

**UI:** a **Collaborate** button in the header opens a popover to *Host a new session* (shows the 6-digit code and the host
`address:port` to share) or *Join with a code* (enter the host address and code). While in a session the button shows a green **Live ·
N** with the people in the room. `CollabPanel.tsx`, main handlers `collab:host` / `collab:join` / `collab:leave` / `collab:state`.

Proven by `apps/desktop/e2e/collab.mjs` (12 checks): it launches **two app windows**, one hosts and the other joins by code, and
checks the joiner receives the host's project, edits sync **both ways**, both see two people, local undo is a no-op during the session,
and ending it returns both to solo editing with the result kept.

### Two integration bugs found and fixed (for the Component 3 author)

- **The client must be given the `ws` WebSocket in the Electron main process.** With `globalThis.WebSocket` the host's own client
  never connected to its in-process server (it sat in `connecting` forever, so the host never joined its own room). Passing
  `WebSocketImpl: NodeWebSocket` (the `ws` package) fixes it; `@daw/collab` now lists `ws` and the DAW imports it for this.
- **Ending a session must close clients with the `SESSION_ENDED` code.** `SessionServer.close()` `terminate()`s sockets abruptly, so
  a joiner saw a dropped link and tried to **reconnect** instead of leaving. The host now calls `server.endSession(code)` (which closes
  with code 4001) and waits briefly for the frames to flush before `close()`, so joiners get a clean "the host ended the session".

## Phase 3 — later

Presence cursors/selection, the history/restore bar wired to the DAW, the DAW's own undo reconciled with the session (the module's
notes flag this as needing hooks in `ProjectService`), and hosting choices (same Wi-Fi vs online via a tunnel).

## Not changed

The standalone collaboration app and server on `feature/collaboration` are untouched; `@daw/collab` is a re-homed copy for
integration. The `components/collaboration` subtree on `demo/integration` (the standalone app, for the supervisor demo) is separate
from this package.
