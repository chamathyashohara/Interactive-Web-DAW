# Stage Plan

**The researcher defines the stages.** Each stage ends with the mandatory report
and **stops for review**. Nothing starts automatically.

| Stage | Defined by researcher | Status |
|---|---|---|
| 0 | Repository, prototype and research audit | ✔ Done (11 Oct 2026). See `docs/project/REPOSITORY_AUDIT.md`. |
| 1 | Requirements and acceptance baseline | ✔ Done (11 Oct 2026). See `docs/requirements/`. |
| 2 | System architecture and ADRs | Drafted (11 Oct 2026). The researcher issued Stage 3, but the ADRs still read "Proposed" until they are explicitly accepted. |
| 3 | Buildable two-application foundation | Done (11 Oct 2026). The core is verified with GCC. **MSVC and the Qt apps are not verified** (toolchain not installed). See `docs/build/WINDOWS_BUILD.md`. |
| 4 | Real local audio capture and WAV recording | Done (11 Oct 2026). The core and the real WASAPI capture path are verified with GCC and the CLI probe. The endpoint was muted, so no signal content was verified. **The Qt apps and MSVC are not verified.** See `docs/testing/AUDIO_DEVICE_TEST_PROTOCOL.md`. |
| 5 | Local playback and audio-engine diagnostics | Done (11 Oct 2026). Monitor path and diagnostics verified with GCC, unit tests and real WASAPI devices (mic muted: silent input). **The Qt GUI and MSVC are not verified.** See `docs/architecture/MONITOR_PATH.md`. |
| 6 | Producer/performer session control over a controlled LAN | Implemented (11 Oct 2026). Core, link and controller verified with GCC, unit tests and two-process runs on **one** PC. **Two PCs not run; the Qt Session panel and MSVC are not compiled.** LAN-only, unencrypted. See `docs/testing/SESSION_TEST_PROTOCOL.md`, ADR-016. |
| 7 | One-way live audio over UDP/Opus | Implemented (11 Oct 2026). Producer → performer, libopus 1.6.1, ADR-008 header, jitter buffer, counters on both sides, test loss simulation, Live audio panel. Verified with GCC, unit tests and two-process runs on **one** PC (test tone and test clock, plus one real-device run at −60 dB). **Not heard at a remote PC (two PCs not run); Qt panel and MSVC not compiled.** See `docs/testing/LIVE_AUDIO_TEST_PROTOCOL.md`, ADR-017. |
| 8 | Bidirectional live audio | Implemented (11 Oct 2026). Two streams on one UDP flow, per-direction counters, send mute / receive mute / gain, five status rows, asymmetric-failure handling, catch-up and resync in the jitter buffer, one-page live report. Verified with GCC, unit tests and two-process runs on **one** PC (incl. real devices at −60 dB, recording during mute and failure). **Not run on the target set-up (two PCs, two listeners); Qt panel and MSVC not compiled.** See LIVE_AUDIO_TEST_PROTOCOL §4–§6, ADR-018. |
| 9 | Coordinated recording state and scheduled start/stop | Implemented (11 Oct 2026). Itemised readiness on both PCs, session id on commands (protocol 1.1), configurable lead with a minimum, countdown, per-PC rows, stop-before-start, stop-during-finalisation, full timing record. Verified with GCC, unit tests and real-device runs on **one** PC (5 coordinated takes; start difference measured on the shared clock). **Not run on two physical PCs; Qt panels and MSVC not compiled.** See SESSION_TEST_PROTOCOL §4, ADR-019. |
| 10+ | To be issued by the researcher | — |

## Proposed implementation increments (input for later stages, not a commitment)

This was proposed in Stage 0 and called "stages 1–7" there. It is renamed here to
**increments I-1…I-7** to avoid clashing with the researcher's stage numbers.
Each increment's acceptance is now defined by the tests in
`docs/requirements/PP1_ACCEPTANCE_MATRIX.md`.

**Schedule pressure:** PP1 is around 20 October 2026 (OQ-08). Keep the Rust
prototype ready as the declared fallback (OQ-07).

| Increment | Scope | Main tests |
|---|---|---|
| I-1 | Toolchain installed. CMake + MSVC. Core library (ring buffer, WAV writer, header/CRC) with unit tests. Both exes start and list real devices. | T-01, T-02, T-16 (unit part) |
| I-2 | Local recording in each app: meters, safe `.partial` → `.wav`, metadata, disk check, device and disk errors, verification tool | T-03, T-04, T-10, T-11, T-13, T-15 |
| I-3 | TCP control: pairing, consent, readiness, ARM/ACK scheduled start, STOP, finalisation reports, heartbeat | T-05, T-06, T-07b, T-09, T-14 |
| I-4 | Live talk over UDP (PCM16), jitter buffer, concealment, counters, test mode. **Full PP1 matrix on two PCs.** | T-07, T-08, T-12 |
| I-5 | Opus for the live stream (COM-07) | T-17 |
| I-6 | Take delivery with SHA-256 verification (XFER) | T-18 |
| I-7 | Measurement: drift, alignment residual, latency impulse (LATER-04/10) | Later test plan |
