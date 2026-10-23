# Component 3 Plan Summary: Real-Time Collaborative Production Module

**Project:** J26-IM-303, An Interactive Learning and Collaborative Web Based DAW for Modern Music Production
**Component owner:** B W C L Withanage (IT23403260) · **Supervisor:** Mr. Didula Chamara T. A.
**Summary date:** 15 October 2026

Sources: the proposal report (`IT23403260_Proposal_Report.pdf`), the topic assessment form (`IT4010_TAF_R2 v3 (1).pdf`), the project threads "Component 3 collaboration plan" and "Help me work out a plan for a project", and the [Component 3 Plan](https://claude.ai/code/artifact/1fa17fc8-e668-4154-b576-f6dc5321b280) doc. Items marked **Open** have not been decided yet.

> **Update (15 Oct 2026): the product is a standalone desktop app, not a web app.** It was pitched as a web DAW, but the feature set is too large for a browser, so the whole DAW (Component 1 included) ships as a desktop app (Electron assumed). Component 3 is therefore a module inside that app. The "host app" becomes a "Host session" feature of the app itself: it runs the embedded server on one machine and shows the IP and QR code. Where the sections below say "browser", "browser tab" or "web DAW", read "app window". Yjs, y-websocket, the data model and the evaluation plan do not change. **Open:** confirm Electron with the Component 1 owner and supervisor.

> **Update (21 Oct 2026): sync method changed from Yjs (CRDT) to a server-ordered operation list.** Component 1's design notes (ADR-001) plan exactly this, and its `applyOp` enforces project rules a CRDT cannot. Wherever the sections below say Yjs, CRDT or y-websocket, read "server-ordered operation list". Details and what was built are in NOTES.md. **Open:** confirm this change with the supervisor, because the proposal says CRDT.

---

## 1. Goal

### Problem
When several producers work on one music project, they usually pass files back and forth: one person edits, saves or exports, sends it on, and waits. Nobody is sure which version is current, and nobody can see what the others are doing. Existing products (Soundtrap, BandLab) offer collaboration, and research systems (sequencer.party) show CRDT-based music sessions, but none provides an **evaluated** model for synchronized, timeline-based multitrack editing.

### Main objective
Design, develop and evaluate a real-time collaborative production module that supports synchronized multi-user editing, playback, presence and conflict management inside a browser-based multitrack DAW.

### Specific objectives (from the proposal)
1. Design a shared project model that supports simultaneous editing by multiple producers.
2. Implement real-time sync of project changes, including timeline edits and transport state.
3. Provide workspace awareness: participant presence, live cursors and active-edit indicators.
4. Implement and test conflict management for concurrent edits to the same regions.
5. Measure sync latency, edit-conflict rate, task completion time and collaboration efficiency.
6. Evaluate teamwork satisfaction against a sequential file-passing baseline with remote teams.

### Research gap
Not "collaboration doesn't exist", but: a conflict-managed, timeline-based multitrack collaboration model where concurrent edits, shared playback and awareness are synchronized **and measured** as one workflow.

---

## 2. Method

### Research approach
- **Design Science Research (DSR)** with **iterative prototyping**. The outputs are the working artifact plus evidence about how well it works.
- Each iteration tackles one sync risk (concurrent conflicts, playback drift, cursor lag) and is unit, integration and multi-user tested before the next one starts.
- **Controlled experiment:** collaborative session vs a **sequential file-passing baseline**.

### Technical design
Component 3 is a standalone collaboration layer that the Component 1 DAW connects to. It has three parts:

| Part | What it does | Where it lives |
|---|---|---|
| **Collaboration server** | Node.js + Express + Socket.IO + y-websocket. Manages sessions (create/join/leave with a join code), relays changes, saves to MongoDB. | `server/collab/` |
| **Collaboration SDK** | Runs inside the DAW. Mirrors the DAW's project store into a Yjs document, sends and applies edits, draws remote cursors. | `client/src/modules/collaboration/` |
| **Host app** (the standalone app) | Node or Electron program that runs the server on one laptop and shows its IP, so others on the same network join without internet. | `collab-host/` |

| Concern | Choice | Why |
|---|---|---|
| Sync engine | **Yjs (CRDT)** | Concurrent edits converge; same family as sequencer.party; matches the proposal's CRDT direction |
| Transport | WebSocket (y-websocket), Socket.IO for session events | Already in the team stack |
| Presence | Yjs awareness | User list, colours, cursors, active-edit flags |
| Persistence | MongoDB snapshots of the Yjs doc + version log | Keeps the database out of real-time conflict resolution |
| Playback sync | NTP-style clock-offset ping, then "start at time X" | Everyone presses play together |
| Internet security | `wss://` + JWT auth | JWT already in the team server deps |

**Shared document shape (Yjs):**

```
project: Y.Map              bpm, key, timeSignature, name
tracks:  Y.Map<id, Y.Map>   name, kind, color, volume, muted, solo, order
clips:   Y.Map<id, Y.Map>   trackId, name, startBar, lengthBars
notes:   Y.Map<id, Y.Map>   clipId, pitch, startBeat, durationBeats, velocity
```

Keyed maps keep edits to different items independent. Two users changing the same clip field resolve last-writer-wins, and each such case is logged as a conflict. Audio samples do not travel through the CRDT; only their ids or URLs do.

### The three connection modes
The modes are **one system deployed two ways, tested three ways**:

| Mode | How it connects | Extra work |
|---|---|---|
| 1. Wired LAN | Clients connect to the host laptop's LAN IP | Host app |
| 2. Same-network Wi-Fi | Exactly as mode 1 (same code) | None |
| 3. Different networks | Clients connect to the same server deployed in the cloud over `wss://` | Cloud deploy, TLS, auth, reconnection |

So the server is written once; only where it runs changes. The three modes become the **test conditions** in the evaluation. WebRTC peer-to-peer is treated as an optional extension, not the core.

### Building without Component 1
Component 1 ([Interactive-Web-DAW](https://github.com/chamathyashohara/Interactive-Web-DAW), `develop` branch) is currently a UI on mock data, with no shared store or playback. To avoid being blocked:
1. Copy Component 1's types (`types/daw.ts`: `DawTrack`, `ArrangementClip`, `MidiNote`, `ProjectInfo`) unchanged.
2. Build a small Zustand store with actions such as `moveClip`, `addNote`, `deleteNote`, `setBpm`.
3. Build a mini test DAW (draggable clips, clickable note grid) that only changes that store.
4. Build all collaboration features on top of that store.
5. At integration, swap in Component 1's real screens and store. Because the types match, only the store source changes.

**Ask the Component 1 owner for:** one shared store with edit actions, a `clipId` on `MidiNote`, stable ids that are never regenerated, a split between shared fields (tracks, clips, notes, bpm, key) and local UI fields (selection, zoom, save status), and transport hooks `play(atTime, fromBar)`, `stop()`, `seek(bar)`.

---

## 3. Datasets and data collected

Component 3 does not use an existing external dataset. Its data is **generated by the evaluation itself**, as the proposal and topic assessment form describe.

### Participants
| Item | Plan |
|---|---|
| Participants | Remote production teams of about 3 people |
| Sample | About 8 to 10 teams, subject to recruitment and ethics approval |
| Profile | Producers, composers or students with music-production experience |
| Tasks | Fixed music-production tasks done in both conditions (shared session and file-passing) |
| Ethics | University ethics clearance, informed consent, anonymized data |

### Data collected
| Data | Source | Used for |
|---|---|---|
| **Synchronization logs** | Each edit carries a client timestamp; receivers log arrival time corrected by clock offset | Sync latency (median, p95), jitter |
| **Edit history / session events** | Server and SDK logs | Edit-conflict rate, convergence, reconnect time |
| **Scripted concurrency runs** | A bot client fires concurrent edits on the same clips | Repeatable convergence and conflict tests without people |
| **Transport timing** | Play start time on each client | Playback start offset between machines |
| **Task completion time** | Timed tasks in both conditions | Production efficiency |
| **Collaboration efficiency** | Task outcomes and timing | Coordination effort |
| **Questionnaire** | Likert-scale teamwork satisfaction (proposal Appendix C items) | Perceived collaboration quality |

### Evaluation metrics
| Metric | Comparison |
|---|---|
| Synchronization latency | Across the three network modes |
| Edit-conflict rate | Conflict frequency and unresolved conflicts |
| Convergence / consistency | No unresolved divergence after scripted tests |
| Task completion time | Collaborative vs file-passing |
| Collaboration efficiency | Collaborative vs file-passing |
| Teamwork satisfaction | Questionnaire, collaborative vs file-passing |

### Network experiment conditions
| Condition | Setup | Measured |
|---|---|---|
| A. Wired LAN | Host laptop + 2 to 3 clients on Ethernet via one switch | Latency, transport start offset, convergence |
| B. Wi-Fi LAN | Same machines on one Wi-Fi access point | Same as A, plus jitter |
| C. Internet | Clients on different networks (home broadband, hotspot) to the cloud server | Same as A, plus reconnect time after a forced disconnect |

The user study (8 to 10 teams vs file-passing) is planned to run in condition C, the remote-production case the proposal argues for.

**Open:** exact task scripts, questionnaire wording (after pilot), recruitment source, and how the logs will be stored and analysed have not been decided.

---

## 4. Steps

### Build steps (each with its "done when")
1. **Agree the data with Component 1** (or build the mini test DAW). *Done when:* both sides use the same types and store actions.
2. **Session server.** Create, join, leave with a 6-digit join code. *Done when:* two browser tabs join the same session.
3. **Sync edits.** Bind the store to a Yjs doc with y-websocket. *Done when:* moving a clip in one tab, then on a second laptop on the same network, moves it in the other.
4. **Host app.** Package the server for one laptop with its IP and join code. *Done when:* a second laptop joins without internet.
5. **Presence.** Names, colours, cursors and active-edit outlines via Yjs awareness. *Done when:* each user sees where the others are working.
6. **Shared playback.** Clock-offset ping, scheduled play/stop/seek. *Done when:* play starts together on every machine.
7. **Conflicts and saving.** Conflict logging, scripted convergence tests, MongoDB snapshots and versions, reconnect and resync. *Done when:* every copy ends in the same state and nothing is lost.
8. **Internet mode.** Deploy the same server to the cloud with `wss://` and JWT. *Done when:* people on different networks can work together.
9. **Integrate.** Plug into the real DAW; export session id, user list and awareness for Component 4 (remote recording).
10. **Evaluate.** Run conditions A, B, C, then the user study against file-passing.

**Start with steps 2 and 3** on one laptop with two browser tabs. Once a clip moves in both tabs, the core works.

### Schedule (proposal's 16-week Gantt)
| Weeks | Phase | Proposal link |
|---|---|---|
| W1 to W4 | Literature, requirements, architecture and data model | WBS 1.0 to 3.0 |
| W4 to W5 | Session prototype | WBS 4.0, FR-01, FR-02 |
| W5 to W7 | Shared state on LAN + host app | WBS 5.0, 6.0, FR-03, FR-04 |
| W7 to W9 | Presence and awareness | WBS 7.0, FR-06 |
| W8 to W10 | Transport sync | FR-05 |
| W9 to W11 | Conflicts and persistence | WBS 8.0, 9.0, FR-07 to FR-09 |
| W10 to W12 | Internet mode | NFR-03, NFR-04 |
| W12 to W13 | Integration with Component 1 and Component 4 | WBS 10.0, FR-10 |
| W13 to W16 | Testing, evaluation, analysis, report | WBS 11.0 to 13.0 |

**Open:** calendar dates for these weeks and the next milestone (and its date) have not been set.

---

## 5. Deliverables

### Software
- **Collaboration server** (session management, real-time relay, MongoDB persistence and version history).
- **Collaboration SDK** inside the DAW (store binding, sync, presence UI, transport sync).
- **LAN host app** (standalone; runs the server on one laptop, join by IP and code).
- **Cloud deployment** of the same server for internet mode.
- **Mini test DAW** used until Component 1's store is ready.
- **Integration adapter** to Component 1's project store, plus session and presence exports for Component 4.

### Testing and research outputs
- Automated scripted concurrent-edit tests showing convergence.
- Latency, jitter, conflict and reconnect results for the three network conditions.
- User study results (task time, collaboration efficiency, satisfaction) vs file-passing baseline.
- Analysis, results and discussion for the final dissertation.

### Documents (from the proposal's WBS)
- Literature matrix and research gap; functional and non-functional requirements (FR-01 to FR-10, NFR-01 to NFR-06); component architecture and data model.

### Requirements the deliverables satisfy
FR-01 create session · FR-02 join session · FR-03 sync edits · FR-04 concurrent region editing · FR-05 transport sync · FR-06 presence and cursors · FR-07 conflict handling · FR-08 persistence and history · FR-09 reconnect and restore · FR-10 reusable by Component 4.

---

## 6. Budget (preliminary, from proposal)
Cloud/server testing LKR 15,000 · Database/storage LKR 10,000 · Internet/data for remote experiments LKR 15,000 · Contingency LKR 10,000 · **Total LKR 50,000**. Software is open source (LKR 0).

## 7. Risks
| Risk | Fallback |
|---|---|
| Component 1 has no real store or playback yet | Build on copied types, own Zustand store and mini test DAW |
| Campus Wi-Fi blocks device-to-device traffic | Run mode B on a phone hotspot or own router |
| Large audio files | Sync only sample ids or URLs; upload over HTTP |
| Playback drift in long sessions | Re-sync clock offset every few seconds and on each play |
| Supervisor expects three separate builds | Present as one design tested in three modes; confirm early |

## 8. Open items
- Next milestone and its date.
- Does the supervisor expect three separate builds, or one design tested three ways?
- Confirm Interactive-Web-DAW is Component 1 and who owns its project store. (The proposal calls the core DAW "Component 01", while the topic assessment form numbers the components differently.)
- Is a hosted cloud server allowed for the study?
- Is WebRTC peer-to-peer in scope or future work?
- Task scripts, questionnaire wording, recruitment and ethics approval timing.
