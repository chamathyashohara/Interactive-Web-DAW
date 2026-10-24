# ADR-004: Remote recording (Component 4) is ported into the DAW in TypeScript

**Status:** accepted. **Context date:** 24 October 2026.

## Context

Component 4 was written in C++17 with Qt 6 as two executables (Producer Studio, Performer Client). The DAW is Electron + React + TypeScript
with a JUCE engine process. Qt windows cannot be placed inside the DAW's window, so the first integration only *started* the two programs
beside the DAW and picked up the WAV files they saved. That needed a Qt toolchain to build, two more windows to learn, a manual copy of the
address and pairing code, and a second set of DLLs in the installer.

## Decision

Port Component 4's logic to TypeScript and run it inside the DAW:

- **Protocol and session logic** in a new workspace package `@daw/recording` (control protocol 1.2, media packet v1, RRXF transfer,
  clock-offset estimator, session state machine, readiness checklist, jitter buffer, WAV format). Pure TypeScript, tested without Electron.
  Node-only parts (sockets, files) live in `@daw/recording/node`.
- **The main process owns the session**, the master recording and the sockets (`net`, `dgram`, `fs`, `crypto`). The window only captures and
  plays audio (Web Audio worklets) and encodes/decodes Opus with **WebCodecs**. No native module and no Opus library were added.
- **The wire protocols are kept byte-for-byte** so the port can be checked against the real C++ code and so a DAW can talk to the original
  programs. The interop tests drive `rr_session_probe` (the C++ library on the command line) as the other side.
- **The UI is the DAW's own panel** (four numbered steps), not a copy of the Qt windows.
- The C++ source stays in `components/remote-recording` untouched. The DAW no longer launches it or packages it.

## Alternatives considered

- **Keep launching the Qt programs** (previous state): not "inside the DAW", needs Qt, no auto-share of the join details beyond a copy/paste card.
- **Embed the Qt windows** in the Electron window: not possible in a supported way.
- **Compile the C++ libraries into a Node addon / the JUCE engine process:** keeps one implementation, but needs a native build for Electron,
  JUCE and Qt-free refactoring of libs that use Qt-free sockets plus miniaudio, and puts capture inside the engine process that the window
  cannot easily share with live talkback. The TypeScript port is slower to write once but is the same stack as the rest of the DAW.
- **WebRTC for talkback:** would give echo cancellation and loss concealment for free, but it is not the protocol Component 4 specifies
  and its jitter/latency cannot be measured the way the research question needs. Not chosen.

## Consequences

- One codebase and one window for the whole product; remote recording is available wherever the DAW runs.
- Two implementations now exist (C++ and TypeScript). The interop tests keep them honest; changes to the protocol must be made in both
  or the C++ side retired.
- Loss concealment is cruder (see `docs/recording-integration.md`); capture is mono 48 kHz.
- The timing claims are unchanged in kind: one-PC measurements check the mechanism, not two-PC accuracy.
