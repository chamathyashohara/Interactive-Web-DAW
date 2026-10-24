# ADR-001: Hybrid architecture (Electron UI + separate JUCE audio engine process)

Status: accepted (2026-10-13). Decision gate at the end of M1: if the C++ engine is not stable,
fall back to a Tone.js engine behind the same engine protocol (`packages/engine-protocol`).

- UI: Electron + React + TypeScript (renderer). Main process owns project state, local storage, sync client.
- Audio: JUCE C++ console process, real-time callback, never waits on UI or network.
- Collaboration (later phase): Node/TS server, server-sequenced operation log, same `applyOp` as the client.
- Audio never goes through the collaboration server; assets are referenced by hash, never sent as state updates.

Claims are measured, not assumed: callback overrun counters, soak tests, offline timing tests.
