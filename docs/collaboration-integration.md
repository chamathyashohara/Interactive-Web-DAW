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

## Phase 2 — host / join from the DAW (next)

- A `CollabSession` in the DAW's main process owns a `CollabClient`. While a session is active, the renderer's edits are routed to
  the client (not just the local `ProjectService`), and the client's `change` events (the user's own and everyone else's) are pushed
  to the engine and the renderer, so the shared project is what plays and shows.
- UI: **Host a session** (start a server, show a 6-digit code) and **Join** (enter a code), plus who-is-here presence.
- The session's seed is the current project — the project system gives it a stable identity to share.

## Phase 3 — later

Presence cursors/selection, the history/restore bar wired to the DAW, the DAW's own undo reconciled with the session (the module's
notes flag this as needing hooks in `ProjectService`), and hosting choices (same Wi-Fi vs online via a tunnel).

## Not changed

The standalone collaboration app and server on `feature/collaboration` are untouched; `@daw/collab` is a re-homed copy for
integration. The `components/collaboration` subtree on `demo/integration` (the standalone app, for the supervisor demo) is separate
from this package.
