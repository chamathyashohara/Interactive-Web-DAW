# Remote recording in the DAW (Component 4, ported to TypeScript)

Component 4 (`components/remote-recording`) was two separate C++/Qt programs, **Producer Studio** and **Performer Client**. They are now
**part of the DAW**: the **Remote recording** button in the header opens one panel that does everything they did, in the DAW's own window,
with the same wire protocols. The Qt source stays in `components/remote-recording` as the reference implementation (and as the test peer
below); the DAW no longer starts it and the installer no longer ships it. Decision: `docs/adr/ADR-004-remote-recording-in-typescript.md`.

## What the panel does

Four steps, one panel (`apps/desktop/src/renderer/src/components/RecordingPanel.tsx`):

1. **Your microphone.** Pick a device and turn it on. A level meter shows it is alive. Audio is captured at 48 kHz in the window.
2. **Connect.** *I'm the Producer*: choose the network address (and port) and **Create session**; the panel shows the address, port and a
   6-digit pairing code. *I'm the Singer*: type the producer's address, port and code, **Join**. Inside a same-network collaboration room
   nothing needs typing: the Producer's session is shared with the room automatically and the Singer presses *Join <name>'s session*.
3. **Record.** Both people tick "I agree to be recorded"; an itemised checklist for **both PCs** shows what is ready (microphone, audio
   healthy, folder writable, disk space, nothing else recording, consent, connected, clock measured). **Record** (Producer) starts a take on
   both PCs at the same planned moment; **Stop** ends it; the Singer can also **Stop & save**. Every take is recorded **locally on each
   PC** as a 32-bit-float 48 kHz WAV, so the network cannot damage a recording.
4. **Takes.** Finished takes are listed with **Add to project** (new sample track at the start of the song). With the Singer's permission
   the Producer also receives a **verified copy** of the Singer's take (resumable, SHA-256 per chunk and for the whole file; the original
   is only opened read-only and is shown as unchanged).

**Talkback** (talk and listen while recording, headphones recommended) is a separate live path: Opus over UDP, with a jitter buffer, so
the recordings never depend on it.

Beginner mode still applies: adding a sound is locked until its lesson, and the panel names the lesson.

## How it is built

```
packages/recording            pure TypeScript, no Electron: the protocols and the session logic, testable on their own
  src/                          control protocol 1.2 (TLV frames), media packet v1 (26-byte header, CRC), RRXF transfer frames,
                                clock-offset estimator, session state machine + readiness checklist, jitter buffer, WAV header/inspector,
                                capture clock (sample counter <-> clock time)
  src/node/                     ControlLink (TCP), SessionController (the producer/performer logic), CaptureRecorderPort (master WAV),
                                MediaEndpoint (UDP talkback), TakeSender / TakeReceiver (verified copy), test recorder, logger
apps/desktop/src/main/recording/liveRecording.ts    the service: owns the controller, recorder and sockets; one IPC surface
apps/desktop/src/renderer/src/recording/            the window's half: microphone -> 480-frame blocks, Opus (WebCodecs), playback worklet
apps/desktop/src/renderer/src/components/RecordingPanel.tsx   the panel
```

**Who decides what.** The window only captures and plays audio. It streams the microphone to the main process in 10 ms blocks with a running
frame number. The **main process** decides which sample is the first and last of a take (from the shared clock), writes the WAV, runs the
sockets and the session state machine. The recording is therefore exact to the sample whatever the window is doing.

**The timing model** (unchanged from the C++ design): the Producer measures the offset between the two PCs' clocks (four-timestamp
heartbeats, smallest-round-trip sample, uncertainty = round trip / 2), schedules `start = now + lead` on its own clock, and the Singer converts
it to its clock. The lead is sized for the measured link (`min = margin + 2 RTT + 2 uncertainty + 200 ms`, plus 250 ms headroom). After a take
the panel shows the estimated difference between the two recording starts with its uncertainty. This is **not** an acoustic alignment
measurement: it does not include the sound cards' own input delay.

**Wire compatibility.** The control protocol (1.2), the media packet header and the transfer protocol are byte-for-byte the C++ ones, so a
DAW can in principle talk to the original Producer Studio / Performer Client. This is tested against the real C++ library (below).

## Differences from the Qt programs (honest list)

- **Packet-loss concealment.** libopus's PLC is not reachable through WebCodecs, so a lost talkback frame repeats the previous one with a
  fast fade instead. Only the live monitor is affected, never a recording.
- **Capture format.** The window captures **mono at 48 kHz** (the C++ recorder used the device's own format). Stereo and other rates are not offered.
- **Input latency.** The capture clock is anchored to when audio blocks reach the main process (smallest delay over 2 s), which filters
  scheduling jitter but, like the C++ estimate, does not include the sound card's input delay. The number shown is the start-time difference
  of the two recording streams, not of the sound in the room.
- **Echo/noise processing is off** on the microphone (browser echo cancellation, noise suppression and auto-gain would alter the recording).
- **Not ported:** the C++ audio probe tools, the stage-by-stage test protocol documents, the live-audio impairment simulator.
- **Security** is unchanged: a trusted private LAN only, unencrypted; the pairing code prevents accidents, not attacks (ADR-012 of Component 4).

## Network

The Producer chooses **one** address to listen on (never all interfaces). Ports (default): TCP **52000** control, UDP **52001** talkback,
TCP **52002** take transfer. Windows Firewall asks once when a session is created: allow the private network. The Singer opens only
outgoing connections. Two PCs on the same network are needed for the real use; one PC can try everything with the *This PC only* address.

## Tests

| Test | What it proves |
|---|---|
| `npm test -w @daw/recording` | protocol round trips (byte-exact against the C++ layout), jitter buffer, clock offset, sample-exact start/stop of a take, session handshake / consent / take / cancel / device fault / lost link, verified transfer, UDP talkback and its rejection counters |
| `RR_PROBE=<rr_session_probe.exe> npx vitest run --root packages/recording interop` | the TypeScript session against the **real C++ library**: TS producer + C++ performer, C++ producer + TS performer (a coordinated take each), and live Opus both ways (CRC, header, reports) |
| `npm test -w @daw/desktop` | the main-process service with two instances and synthetic microphones: full session, verified copy, microphone off, leaving |
| `node apps/desktop/e2e/remote-recording.mjs` | **two real DAW windows** with Chromium's fake microphone: connect, consent, talkback (real WebCodecs Opus over UDP), a coordinated take, both WAVs checked, verified copy byte-identical, Add to project, the engine plays it (`RR_SHOT_DIR=<folder>` saves screenshots) |
| `node apps/desktop/e2e/recording-room.mjs` | the Producer's session reaches the collaboration room and the Singer joins in one click |
| `node apps/desktop/e2e/recording.mjs` | new WAVs in the recordings folder are listed; Add to project; beginner-mode lock |

## What has and has not been verified

Verified on the development PC (both sides on one PC, loopback and the PC's own LAN address): everything in the table above.

**Not verified:** two physical PCs, a Wi-Fi link, the Windows Firewall prompt, a real sound card or headphones (all end-to-end runs used a fake
microphone and no audible playback), clock drift between two PCs over a long take, and any listening test of the Opus talkback quality.
Component 4's own `SESSION_TEST_PROTOCOL` describes the tests that still need two PCs.

## Limits to know

- Both the DAW's playback and the recorder use the sound card at once; this was not tested. A singer on headphones avoids the backing track
  bleeding into the microphone. There is no shared start time between the DAW's playback and a take.
- In a collaboration session the new track refers to the recording by library id only, so other people see the track but not its audio until
  a file-sharing channel exists (the audio is on the Producer's PC).
- Only one remote-recording session at a time, one Singer per Producer (as in the Qt programs).
