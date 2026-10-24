# Component 3: Real-Time Collaborative Production Module

Full plan is in [PLAN.md](PLAN.md). Read it before starting work.

- Product is a **standalone desktop app** (pitched as web, but features are too heavy for a browser). Assumed Electron; not yet confirmed with Component 1 owner.
- Component 3 is the collaboration module inside that app: any instance can "Host session" (embedded Node server, shows IP and code) or "Join session" (join code / IP). Cloud mode runs the same server remotely over wss.
- Sync: server-ordered operation list (not Yjs). The server holds the authoritative project and applies every op with Component 1's own `applyOp`; apps show their own edits at once and are corrected if the server's order differs. See NOTES.md.
- Stack: Node.js, `ws`, Electron, TypeScript, esbuild. Storage idea: local files (journal + snapshot) like Component 1; MongoDB is optional. Accounts/login are planned as an optional online feature.
- Keep the sync core (server + SDK) as plain TypeScript modules with no Electron or DOM dependency, so it is testable headless and works with whatever shell Component 1 uses.
- Layout: `src/server/` (room + session server), `src/client/` (replica + connection client, no DOM), `src/shared/` (protocol, seed, describe, stats), `src/daw-shared/` (vendored Component 1 model, do not edit), `src/main/` + `src/renderer/` (Electron test app).
- Component 1's real model (tracks -> clips -> notes in ticks, ops, `applyOp`) lives unchanged in `src/daw-shared/` (from branch feature/collaboration, commit 16c306b). The renderer is a small test screen, not the real DAW.
- Audio samples never go through the session server, only ids/hashes.
- Build order: PLAN.md section 4 (its Yjs wording is out of date; see NOTES.md). Done: session server, op-list sync, presence, network panel, online mode groundwork.
- Progress and decisions: record in NOTES.md.
