# Stage Plan

Each stage ends with the mandatory report (summary, files, commands and results,
acceptance checklist, limitations, preserved material, next stage) and **stops
for review**. No stage starts automatically.

**Schedule pressure:** PP1 is expected around **20 October 2026**, nine days
after the C++ decision. The panel acceptance target needs Stages 1–4, plus a
two-PC test, to pass in that time, and none of the C++ toolchain is installed
yet. **Keep the Rust prototype (`duplexrec-rs`, 14/14 tests passing) ready as
the PP1 fallback** and do its two-PC rehearsal anyway (chat record §12, day 4).
The C++ stages below are not shortened to hit a date: a stage that is not
verified is reported as not verified.

| Stage | Scope | Acceptance (summary) |
|---|---|---|
| **0** ✔ | Inventory, toolchain audit, architecture, dependency review, decision log, this plan | Docs exist. Nothing moved or deleted. Rust prototype re-verified. |
| **1** | Toolchain installed. CMake + presets + MSVC build. `dawrr_core` with SPSC ring, WAV writer, media-header codec (26 B, CRC-32), plus Catch2 tests. Both exes open a Qt window that lists the **real** audio devices via miniaudio. | Clean configure and build with MSVC from a fresh clone. All unit tests pass. Both exes start on this PC and list real devices. |
| **2** | Local recording in each app: choose devices, live input meter, record to `takeNN_<role>.wav.partial` → finalise, overrun, disk and device error reporting, take JSON | Single PC: 5-minute take with real mic, file plays, frame count matches, zero overruns; forced error cases (disk full simulation, unplug) shown correctly |
| **3** | TCP control: pairing code, HELLO, readiness, time exchange, producer-scheduled ARM/ACK start and STOP, TAKE_FINALISED reporting, heartbeat and disconnect policy | Two instances on one PC, then two PCs: producer starts and stops both recordings, both files are complete, offset and uncertainty are logged under their own names |
| **4** | Live talkback over UDP (PCM16 10 ms), jitter buffer, PLC, loss, late and jitter counters, peer meter, runtime segment and depth settings | **Panel acceptance test on two real Windows PCs:** both record their own original-quality audio locally, both hear each other live, the producer controls start and stop. `--sim-loss` style test shows the master is unaffected. |
| 5 | Opus 1.6.1 monitor codec (10/20 ms), codec flag in the header | Same as 4, with bitrate and latency compared against PCM16 |
| 6 | Performer → producer take transfer: reliable TCP, chunked, SHA-256 per chunk and per file (Windows CNG), retry and resume, final verification. The performer's original is kept. | Transferred file is byte-identical (hash). Resume works after a forced disconnect. |
| 7 | Measurement: drift (ppm), alignment residual from a reference signal (proposal Test 1), derived aligned export plus manifest | Measured numbers, reported with method and uncertainty |
| Later | TLS for control, NAT/internet, SQLite sessions, usability study (RQ4), Web DAW export (FR9), macOS (NFR10) | Separately designed and documented |
