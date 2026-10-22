# ADR-001: Two executables over a shared, Qt-free core

- **Status:** Proposed (Stage 2, 11 Oct 2026) · **Traces:** APP-01, BRIEF, D-04

## Context
The brief requires ProducerStudio.exe and PerformerClient.exe as separate
executables, built without copying all the audio and network code into each.
The real-time and protocol code must be unit-testable without a GUI or audio
hardware (T-16).

## Decision
There are three layers of libraries plus two thin executables:

1. **`rr_core`**: a static library in **plain C++17 with no Qt**. It holds
   audio, recording, media transport, codecs, the jitter buffer, the
   protocol codecs, the session state machines (pure logic), timing,
   telemetry, hashing and take verification.
2. **`rr_app`**: a static library on **Qt 6 Core/Network/Widgets** shared by
   both apps. It holds the control transport (TCP), the session controller
   that connects the state machine to the engine and transport, and the
   shared widgets (meters, device picker, status and telemetry panels,
   consent dialog).
3. **`ProducerStudio.exe`** and **`PerformerClient.exe`**: role-specific
   windows and wiring only.
4. **`rr_verify.exe`**: the command-line verification tool (VER-01), built
   on `rr_core` only.

## Consequences
- Role differences live in data (`Role::Producer` / `Role::Performer`) and in
  the state-machine tables, not in duplicated code.
- `rr_core` tests run with Catch2 only.
- Qt (LGPL) is kept out of the audio and network core.
- **Risk:** the boundary needs discipline. Rule: no `#include <Q…>` under
  `core/`, enforced by a CMake check in I-1.

## Alternatives rejected
- **One exe with a role switch** (the prototypes): breaks APP-01.
- **Qt everywhere**, including the audio and media threads: Qt event-loop
  timing is unsuitable for the media threads, and the core would need Qt to
  run its tests.
