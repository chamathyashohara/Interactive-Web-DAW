# ADR-002: Reuse of the legacy web prototype

The earlier web prototype (`C:\Users\MSI GF63\interactive-web-daw`) is kept untouched as a read-only reference.
Selected UI ideas (dark console styling, piano-roll interaction model, MidiNote shape) are re-implemented here.
Not carried over: `nextId` counters (replaced by UUIDs), float beat positions (replaced by integer ticks),
notes keyed by track (replaced by track -> clip -> note), UI state mixed into project state.
