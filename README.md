# Component 3: Real-Time Collaborative Production (J26-IM-303)

Collaboration layer for the Collab DAW: several producers edit one project at the same time, see each other,
and can measure how the connection performs. Standalone Electron app (test screen) plus a session server.

## How it works
- A session server keeps the real project for each session and puts every edit in one order (a server-ordered
  operation list). Every edit is checked with Component 1's own `applyOp`, so the server enforces the same rules as the DAW.
- Each app shows its own edits at once and is corrected if the server's order differs. Dropped connections reconnect and catch up.
- Presence (names, colours, live pointers), an activity list, and a Network panel (ping, jitter, loss, sync delay, CSV export).
- Hosting on the same network (the app runs the server) or online (`npm run server` behind a tunnel or on a host).

## Layout
| Path | What it is |
|---|---|
| `src/server/` | Room (ordering + rules) and session server (WebSocket, HTTP API, `/ping`) |
| `src/client/` | Connection client and replica (no DOM, reusable by the real DAW) |
| `src/shared/` | Protocol, seed-project check, plain-English op descriptions, stats, address parsing |
| `src/daw-shared/` | Unchanged copy of Component 1's shared model (see `SOURCE.md`); replace with `@daw/shared` at integration |
| `src/main/`, `src/renderer/` | Electron test app |
| `scripts/` | Automated tests |

## Run
```bash
npm install
npm start                 # build and launch the test app (open it twice for two windows)
npm run server            # standalone session server (env PORT, AUTH_TOKEN)
npm test                  # 68 headless checks
npm run test:ui           # drives two real app windows (close other copies of the app first)
npm run typecheck
npm run dist              # Windows installer + portable exe in release/
```

See `NOTES.md` for decisions and progress, `PLAN.md` for the research plan (its Yjs wording is superseded; see the update note at its top).
