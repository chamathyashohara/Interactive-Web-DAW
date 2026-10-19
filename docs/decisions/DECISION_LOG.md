# Decision Log: C++17 Implementation

This log continues proposal v2 **Appendix B** (Table 9). Earlier rows from
2026-08 to 2026-09-10 stay in the proposal. They are summarised in
`docs/research/RESEARCH_PRESERVATION_INDEX.md` and are not repeated here.
Status: **Proposed** = waiting for the researcher's or supervisor's review. **Accepted** = confirmed.

| # | Date | Decision | Alternatives considered | Reason | Status |
|---|---|---|---|---|---|
| D-01 | 2026-09-10 | Standalone native app, not browser | In-browser, hybrid | Proposal v2 §1.2/§4.5: browser APIs hide buffer and transport control | Accepted (proposal) |
| D-02 | 2026-10-09 | Rust (cpal) used for the PP1 prototype | C++ prototype of the same day | Chat record §10: compiler-enforced thread safety | Historical. Superseded by D-03. **Prototype preserved.** |
| D-03 | 2026-10-11 | **Final implementation language: C++17** with CMake on Windows | Continue in Rust | Researcher's final decision of 11 Oct 2026. Matches proposal v2 §4.6 and the panel's suggestion. The Rust prototype stays as a reference and as a PP1 fallback. | Accepted (researcher) |
| D-04 | 2026-10-11 | **Two executables** (ProducerStudio.exe, PerformerClient.exe) over one Qt-free core library | One exe with a role switch (as in the prototypes) | Brief requirement. Producer is the session authority. Separate exes stop a role from being mixed up on the day. | Accepted (brief) |
| D-05 | 2026-10-11 | Audio I/O: **miniaudio 0.11.25** (vendored) | JUCE 7 (proposal), PortAudio, RtAudio | One header, public domain/MIT-0, WASAPI duplex, already used successfully in the 9 Oct C++ prototype | Proposed |
| D-06 | 2026-10-11 | UI: **Qt 6.11.3 Widgets**, dynamic LGPL-3.0 | JUCE GUI, raw Win32, Dear ImGui | Mature native widgets. LGPL is fine for academic use with dynamic linking. Kept out of the core library. | Proposed (needs the licence/deployment review in DEPENDENCIES.md) |
| D-07 | 2026-10-11 | Networking: **plain Winsock2 wrapper**, no Asio | Standalone Asio 1.36, Qt Network | Smallest set. Two peers, one UDP and one TCP socket. | Proposed |
| D-08 | 2026-10-11 | **Monitor codec: PCM16 first (Stage 4), Opus 1.6.1 next (Stage 5)** | Opus from the start | Lowers risk for the panel acceptance test: PCM16 10 ms fits the MTU and is proven in the prototype, and LAN bandwidth (about 0.8 Mbit/s each way) is no problem. Opus then removes the MTU limit and lowers bitrate. | **Needs the researcher's decision** |
| D-09 | 2026-10-11 | Master format: **WAV float32 mono at device rate (48 kHz required)**, `.partial` → rename on finalise | PCM24 WAV | No quantisation of the master. Same as the Rust prototype. Incomplete files are obvious. | Proposed |
| D-10 | 2026-10-11 | Offset estimation uses the **monotonic clock (QPC)**, not wall clock | Wall clock (as in the Rust prototype; the C++ prototype already used `steady_clock`) | Wall clock can step during NTP corrections | Proposed |
| D-11 | 2026-10-11 | Performer **keeps recording** if the control link drops mid-take | Auto-stop on disconnect | Protects the master take, which is the core claim | **Needs the researcher's decision** |
| D-12 | 2026-10-11 | **Toolchain: MSVC v143 (VS 2022 Build Tools)** side by side with VS 2026 | v145 from VS 2026 | Brief says "MSVC 2022". v145 would also compile C++17. | **Needs the researcher's decision** (see TOOLCHAIN_AUDIT.md) |
| D-13 | 2026-10-11 | PP1 prototype is **LAN-only and unencrypted**, and this is stated openly | TLS from day one | Scope and time. NFR7 deferred to a separate security stage. | Proposed |

## Stage 2 (11 Oct 2026): architecture decisions

The detailed records are in `docs/architecture/adr/`. All are **Proposed**
until the architecture review.

| # | Date | Decision | Record | Status |
|---|---|---|---|---|
| D-14 | 2026-10-11 | Layering: `rr_core` (no Qt) / `rr_app` (Qt) / two exes / `rr_verify` | ADR-001 | Proposed |
| D-15 | 2026-10-11 | Separate capture and playback devices, explicit device IDs, `noAutoStreamRouting`, native 48 kHz, device watchdog | ADR-003 | Proposed |
| D-16 | 2026-10-11 | **Revises D-07:** TCP control on Qt Network in a control thread. UDP media and probes stay on Winsock. | ADR-005 | Proposed |
| D-17 | 2026-10-11 | Media header v1: version nibble, CRC over header and payload (not compatible with the prototypes) | ADR-008 | Proposed |
| D-18 | 2026-10-11 | Control protocol: TLV frames, major/minor versions, explicit ACK/NACK with error codes | ADR-009 | Proposed |
| D-19 | 2026-10-11 | Fixed-depth jitter buffer owned by the playback callback, decoding in the callback (measured) | ADR-011 | Proposed |
| D-20 | 2026-10-11 | Catch2 v3.16.0, test-only | ADR-015 | Proposed |
| D-21 | 2026-10-11 | Proposed requirement amendments A-1…A-4 (SYSTEM_ARCHITECTURE §10) | — | **Needs the researcher's decision** |

## Stage 3 (11 Oct 2026): build foundation

| # | Date | Decision | Reason | Status |
|---|---|---|---|---|
| D-22 | 2026-10-11 | CMake presets use the **"Visual Studio 17 2022" generator with toolset `v143` pinned**, not Ninja (amends ADR-002) | The VS generator selects the pinned toolset itself and needs no Developer Command Prompt, which is easier to reproduce. Ninja stays in use for the GCC core check. | Implemented. Not run with MSVC. |
| D-23 | 2026-10-11 | ADR-001's `rr_core` is split into the Qt-free folders `libs/shared` and `libs/session` (and later `libs/audio`, `libs/network`). `rr_app` becomes `libs/ui_common` (`rr_ui`). | Follows the Stage 3 brief's suggested layout. Module boundaries are visible in the file system. The Qt-free rule is enforced by a test. | Implemented |
| D-24 | 2026-10-11 | Catch2 fetched by URL with a pinned SHA-256. Offline override documented. Nothing vendored yet. | Reproducible without committing third-party code | Implemented. Fetch verified. |
| D-25 | 2026-10-11 | AUTOMOC per Qt target instead of `qt_standard_project_setup()` | Keeps moc away from the Qt-free libraries and the tests | Implemented. Not run with Qt. |

## Stage 4 (11 Oct 2026): local capture and recording

| # | Date | Decision | Reason | Status |
|---|---|---|---|---|
| D-26 | 2026-10-11 | When the capture ring overflows, the missing frames are **filled with silence** in the file, and each gap's position and length are written to the take JSON (`gaps`, `has_gaps`). The UI shows a warning. | Keeps the take's timeline (sample positions) correct for later alignment. Dropping frames would silently shift everything after them. The inserted silence is documented, never hidden. | Implemented, tested (test signal) |
| D-27 | 2026-10-11 | Proposed amendment A-1 applied: the master records the device's **native channel count** (1–8). Float WAV tag 3 for ≤ 2 ch, WAVE_FORMAT_EXTENSIBLE above that. | Avoids a hidden miniaudio down-mix. The development PC's mic array delivers 2 channels. | Implemented. Needs the researcher's confirmation (A-1). |
| D-28 | 2026-10-11 | The performer app gets a clearly labelled **"Record (local test)"** button in Stage 4 | The Stage 4 brief requires both apps to record independently. SES-08 (the performer cannot start session takes) applies from the session stage and will gate this button then. | Implemented. Temporary. |
| D-29 | 2026-10-11 | A device that is stopped, rerouted, or silent for 500 ms (no callbacks) while recording ends the take as `incomplete_device`. The audio captured so far is finalised. | ERR-06. Never present a truncated take as complete. Rerouting is disabled (ADR-003), so any reroute is treated as a fault. | Implemented, tested (test signal) |
| D-30 | 2026-10-11 | WAV writing is in-house (`WavWriter`), not `ma_encoder`. The `.partial` file is created exclusively (`wbx`), the header refreshed every 5 s, then flush + `MoveFileExW` without replace. | ADR-007 requirements: crash-recoverable, no overwrite, explicit failure states | Implemented, tested |
| D-31 | 2026-10-11 | miniaudio 0.11.25 vendored unmodified (`third_party/miniaudio`, SHA-256 recorded). Only device I/O compiled (`MA_NO_DECODING`, `MA_NO_ENCODING`, …), WASAPI only on Windows. | ADR-003. Smallest build surface. | Implemented |

## Stage 5 (11 Oct 2026): local playback, monitoring and diagnostics

| # | Date | Decision | Reason | Status |
|---|---|---|---|---|
| D-32 | 2026-10-11 | A separate `MonitorBus` (stereo SPSC ring) between the capture and playback callbacks, separate from the record ring. Monitor-only gain and channel maps. | Monitor processing must never reach the master (brief rule 6). One fixed ring format avoids lifetime problems when devices change. | Implemented, tested, run on real devices |
| D-33 | 2026-10-11 | The output renders at the capture rate. If the output device differs, miniaudio resamples the **monitor only**, and this is stated. | No sample-rate conversion anywhere near the master | Implemented |
| D-34 | 2026-10-11 | Monitoring is **off by default**, an explicit checkbox, with a permanent feedback warning and a "processing differences" line in the UI | Brief rule 5 | Implemented (Qt not compiled) |
| D-35 | 2026-10-11 | Start trim: at each monitor (re)start the backlog above the target is dropped and counted | A real-device run showed monitor delay stuck at 40 ms after an input reopen. After the fix it returns to 10 ms. | Implemented, verified on real devices |
| D-36 | 2026-10-11 | Diagnostic report: JSON (`rr.diagnostics.v1`) exported from the Diagnostics tab. The same audio snapshot is printed by `rr_audio_probe`. | Brief rule 7. Machine-readable for later analysis. | Implemented (GUI export not compiled; probe JSON validated) |
| D-37 | 2026-10-11 | `tools/check_sources.py` lexical check added as a test | It found two broken string literals in the committed Stage 4 Qt code, which cannot be compiled here | Implemented |

## Stage 6 (11 Oct 2026): producer/performer session control over a LAN

| # | Date | Decision | Reason | Status |
|---|---|---|---|---|
| D-38 | 2026-10-11 | Control transport on **Qt-free sockets** in `libs/network` (one link thread, non-blocking + `select`). Supersedes ADR-005's control row (**ADR-016**). | Makes the control path buildable and testable without Qt on the development PC. Keeps the protocol in the core (ADR-001). | Implemented, tested |
| D-39 | 2026-10-11 | Session logic in a new Qt-free `libs/control` (`rr_control`): a single-threaded `SessionController` polled by the UI. Recording goes through a `RecorderPort` (real or test). | The UI only renders snapshots, so states cannot be faked by widgets. The test recorder makes the controller testable without devices. | Implemented, tested |
| D-40 | 2026-10-11 | Start is a **two-step**: ARM → ARM_ACK → SCHEDULE_START → START_ACK. The producer schedules its own recorder only after START_ACK. | A start time is only fixed once the performer has said it can record. Neither side starts alone. | Implemented, tested |
| D-41 | 2026-10-11 | Protocol message names refined (HELLO_REJECT→ERROR, STOP→STOP_SCHEDULE, BYE→SESSION_CLOSED, STATUS→READY_STATUS) and JOIN separated from HELLO. Frame limit **16 KiB** (draft: 64 KiB). Documented in PROTOCOL_OVERVIEW §11. | Matches the brief's message list. Control messages are small, and a smaller cap bounds memory. | Implemented |
| D-42 | 2026-10-11 | Clock offset for scheduling in Stage 6 comes from **TCP heartbeat** four-timestamp samples (min-δ of 16, u = δmin/2). The UDP probes of ADR-010 come with the media stage. | No UDP path exists yet. TCP errors only widen δ and so u, and the reported uncertainty covers that. | Implemented, tested |
| D-43 | 2026-10-11 | The producer listens on **one explicitly selected IPv4 interface**. `0.0.0.0` is refused. The apps never modify Windows Firewall; a narrow manual rule is documented. | Brief: explicit interface, no silent broad firewall access | Implemented, tested |
| D-44 | 2026-10-11 | Stop during a link outage: the producer stops at its time, and **STOP_SCHEDULE is re-sent after the reconnect** (the performer's take ends later). A performer whose session ends for good while recording stops and saves its own take. | Found by the Wi-Fi-bound two-process run (scenario E): the stop was lost and the performer recorded until the session closed | Implemented, regression tests |
| D-45 | 2026-10-11 | Link shutdown sends SESSION_CLOSED, then **half-closes and drains ≤ 500 ms** before closing | Found by a new test: closing with unread data made Windows send a reset (WSA 10054), destroying SESSION_CLOSED | Implemented, tested 30× |
| D-46 | 2026-10-11 | While a session is active, the AudioPanel's local Record is disabled (SES-08), and its recorder take reports go to the session controller only (one consumer) | Two consumers of the recorder's report queue would steal each other's results | Implemented, **unverified** (Qt) |
| D-47 | 2026-10-11 | PP1 control link stays **unencrypted, LAN-only**. Pairing code: 6 digits, single use, 10 min, 5 attempts; resume token 32 hex; both from `std::random_device`; never logged. TLS options recorded in ADR-016. | Brief: no invented cryptography; label unencrypted builds LAN-only | Implemented. Labelled in the UI, README and docs. |

## Stage 7 (11 Oct 2026): one-way live audio over UDP/Opus

| # | Date | Decision | Reason | Status |
|---|---|---|---|---|
| D-48 | 2026-10-11 | First live direction is **producer → performer** (ADR-017). | The brief's default. The performer then needs no inbound firewall rule, and hears the producer's cues. | Implemented |
| D-49 | 2026-10-11 | **libopus 1.6.1** via CMake FetchContent from downloads.xiph.org, pinned by the published SHA-256 `6ffcb593…a411a1`, statically linked. DRED/OSCE, tests and programs off. Configuration fails if libopus would use its non-thread-safe pseudostack. | ADR-006 named 1.6.1. The hash was verified against Xiph's SHA256SUMS.txt. Decoding in the callback needs stack scratch (VLA/alloca). | Implemented. GCC build verified; MSVC not built. |
| D-50 | 2026-10-11 | Codec defaults: 48 kHz mono, 10 ms, RESTRICTED_LOWDELAY, 64 kbit/s **hard CBR**, complexity 5, FEC off. Allowed: frames 2.5/5/10/20 ms, 16–128 kbit/s, AUDIO mode. Lookahead read back, not assumed. | Legal per opus.h / opus_defines.h. CBR gives constant packets. FEC is an LPC-layer feature that RESTRICTED_LOWDELAY does not use. | Implemented, tested (all frame sizes × both modes) |
| D-51 | 2026-10-11 | Header v1 as built: offset 4 = **48 kHz live-stream sample counter** (gaps included); new type 4 **RECEIVER_REPORT**; PCM16 and the PROBE types are refused. PROTOCOL_OVERVIEW §12. | The capture-device index is meaningless to the receiver once samples are trimmed. The report gives the producer receiver counters and an address to send to. | Implemented, tested |
| D-52 | 2026-10-11 | **No control-protocol change:** media session = the session id as u32; media port = control port + 1; the producer sends only to an endpoint learned from a valid report whose source IP is the performer's control address; it stops after a closing report or 3 s without reports. | Brief: do not change the control channel without an ADR. Never send to an address that was only claimed. Stop on its own when the performer goes away. | Implemented, tested |
| D-53 | 2026-10-11 | Capture → sender hand-over through `LiveTap`: mono average in the callback, all-or-nothing copy, overflow counted, **no kernel call** (THREADING §5's polling alternative instead of `SetEvent`). The sender polls with `select(1 ms)` under `timeBeginPeriod(1)` and trims a backlog above 6 frames. | Keeps network and codec out of the capture callback. Measured wake: 1.6 ms median (15.6 ms without `timeBeginPeriod`). | Implemented, measured |
| D-54 | 2026-10-11 | Playback through an engine **playback-contributor** hook. The receiver decodes in the playback callback (ADR-011) and adds after the local monitor. `detach` waits only on the control thread. | One playback device and one callback. The receiver can be destroyed safely. | Implemented. Real-device run at −60 dB: worst 0.17 ms per callback. |
| D-55 | 2026-10-11 | Live monitor only: Opus PLC for lost and underrun frames, never written to any take. Live off by default on both sides; gain −60…0 dB (default −12, no boost); headphones advice in the UI. | Brief items 6 and 8. Master recordings stay independent (ADR-007). | Implemented. Qt UI unverified (not compiled). |
| D-56 | 2026-10-11 | The probe's 10 ms **test clocks** wait in `Sleep(1)` steps on Windows. | Measured: MinGW's `sleep_until` stays on the 15.6 ms tick even with `timeBeginPeriod(1)` (10 ms deadlines p95 21 ms). This made the first loopback run show 7.4 ms jitter that was the test clock's, not the network's. | Implemented, measured |
| D-57 | 2026-10-11 | The sender counter `packets_sent` counts **AUDIO datagrams only**. END_OF_STREAM has its own counter; `bytes_sent` covers all datagrams. | Found in the Stage 7 runs: the final sent count was exactly 2 above the received count in every run without impairment (the two END_OF_STREAM datagrams), which looked like loss | Fixed, re-run (L1-recheck: 1202 = 1202) |

## Stage 8 (11 Oct 2026): two-way live audio

| # | Date | Decision | Reason | Status |
|---|---|---|---|---|
| D-58 | 2026-10-11 | One `LiveEndpoint` per side (one socket, one media thread, one outgoing + one incoming stream). The Stage 7 `LiveSender`/`LiveReceiver` become thin wrappers (ADR-018). | Symmetric code for both directions. The unchanged Stage 7 tests act as regression tests. | Implemented, tested |
| D-59 | 2026-10-11 | Both directions on **one UDP flow** (the producer's media port). Stream 2 = performer microphone. Strict direction check (`wrong_stream`). | No new port and no inbound rule on the performer PC. A side never plays its own stream. | Implemented, tested |
| D-60 | 2026-10-11 | **Send mute** = flagged encoded silence (header flag bit 2); the stream keeps running. **Send off** = END_OF_STREAM. **Receive mute** = play nothing but keep receiving and reporting. None of these touch the recorder. | COM-04; brief: never conflate muting with stopping recording; the other side must see "muted", not "failure" | Implemented, tested |
| D-61 | 2026-10-11 | No push-to-talk; continuous talkback with per-side mute | No requirement asks for push-to-talk (COM-01, COM-04) | Decided |
| D-62 | 2026-10-11 | Reachability = datagram within 3 s **or** control link Connected (closing report overrides) | Brief task 5: one direction can fail while the other continues | Implemented, tested (unit + D4) |
| D-63 | 2026-10-11 | Sequence numbers continue across pauses; a step back of ≥ 64 is a stream restart | Found by run D4b: a restarted stream was dropped as duplicates for about 9 s | Fixed, regression tests, re-run |
| D-64 | 2026-10-11 | Jitter buffer **catch-up** (more than target + max(8, target) held → drop to the target) | Excessive buffering: after a 300 ms playback stall the drift skip alone needs about 30 s to remove the delay | Implemented, tested |
| D-65 | 2026-10-11 | Jitter buffer **resync** after 3 consecutive late arrivals | Found by run D5: a 60 ms sender pause (input re-open) cost 20 underruns + 18 late; now 4 + 3 | Fixed, regression tests, re-run |
| D-66 | 2026-10-11 | One-page live report (`live_report_text`), shared by the apps (Export) and the probe (`--report`). Five separate status rows. **No echo cancellation**; headphones required and stated. | Brief tasks 4, 6, 8; LATER-03 | Implemented. Apps unverified (Qt not compiled). |

## Stage 9 (11 Oct 2026): coordinated recording state and scheduled start/stop

| # | Date | Decision | Reason | Status |
|---|---|---|---|---|
| D-67 | 2026-10-11 | Itemised readiness checklist (input, engine health, folder writable, disk policy, no other recording, consent, connected, clock offset), shown for both PCs; the performer's items travel in READY_STATUS tag 33 | Brief steps 2–3: display each item; refuse to schedule while one fails | Implemented, tested |
| D-68 | 2026-10-11 | The performer's consent tick is its explicit **arm** action; no separate arm button | Consent already gates ARM (SES-06). A second checkbox would add a step without new information. | Decided; open for review |
| D-69 | 2026-10-11 | Control protocol **1.1**: session id on every command and acknowledgement (mismatch refused); command id = `msg_id`. Additive, so 1.0 still interoperates. | Brief step 4: session id and command id in the command | Implemented, tested |
| D-70 | 2026-10-11 | Configurable start lead 300–10 000 ms (default 1000) with a stated minimum: margin + 2 RTT + 2 u + 200 ms | Timing requirement: a lead large enough for the measured uncertainty and processing | Implemented, tested. The rule is provisional. |
| D-71 | 2026-10-11 | Stop before the start = CANCEL on both PCs (stop right after the start if within 150 ms); CANCEL after the performer's start = stop and save | Brief: stop-before-start; never lose a started recording | Implemented, tested |
| D-72 | 2026-10-11 | Stop during stopping/finalisation is refused locally; duplicates are answered idempotently | Brief: stop during finalisation | Implemented, tested |
| D-73 | 2026-10-11 | One `take_timing` JSONL record per take on each PC (all command, receipt, acknowledgement, start, stop and finalisation times, frames, device period, θ, u) plus `analyse_take_timing.py` | Brief timing log; evidence of measured, not invented, offsets | Implemented, used for the evidence |
| D-74 | 2026-10-11 | On one PC, the start difference is **measured** on the shared QPC clock (true offset 0). It is reported only as a check of the mechanism, never as a two-PC or acoustic result. | The only measurement available without two PCs and an unmuted microphone | Done (Stage 9 evidence) |
| D-75 | 2026-10-11 | Files "finalise and play" is verified by an independent Python structural reader (every sample) and the Windows MCI decoder (opens, reports length). Audible playback is not tested. | No ffprobe/numpy installed; the microphone is muted, so there is nothing to listen to | Done |
| D-76 | 2026-10-11 | A link loss before the start (Armed/Scheduled) now marks the take **cancelled** on that PC and logs its `take_timing` record, as CANCEL does. The probe prints "n/a" instead of -1.000 for missing timing values, and "n/a" for the lead on the performer. | Found while checking the C3 evidence: the producer's take was not flagged cancelled (a panel could show a stale "SCHEDULED" row after reconnecting), and -1.000 read like a measurement | Fixed, tested (C3 assertions added); C2/C3 rerun on the fixed build |

## Stage 11 (11 Oct 2026): verified post-session take transfer

| # | Date | Decision | Reason | Status |
|---|---|---|---|---|
| D-77 | 2026-10-11 | Transfer on its own TCP connection, control port + 2, on the session's selected interface; the producer accepts only the joined performer's address, one connection at a time; the performer connects out | ADR-014 (never delay control); no inbound rule on the performer PC; no broad listener | Implemented, tested (stranger address refused) |
| D-78 | 2026-10-11 | Own wire format RRXF v1 with bounded frames (≤ 64 KiB + 44 B) and exact payload checks, instead of the control TLV codec | Control fields are limited to 64 KiB and frames to 16 KiB; keeps transfer versioning separate | Implemented, tested (malformed input) |
| D-79 | 2026-10-11 | Per-chunk SHA-256 (32 KiB chunks) and whole-file SHA-256 of the bytes read back from the producer's disk, both via Windows CNG | Brief: per-chunk and whole-file cryptographic checks with a standard library; ADR-012/014: no custom crypto | Implemented, tested (FIPS vectors, damaged chunk, whole-file mismatch) |
| D-80 | 2026-10-11 | VERIFIED = hash match AND complete float32 WAV whose rate/channels/frames match the offer AND the performer's TAKE_FINALISED, AND a no-replace rename; a duplicate request re-checks the existing copy the same way | Brief: never show verified before both integrity and format checks pass | Implemented, tested |
| D-81 | 2026-10-11 | Resume from a journal (session, take, size, hash, chunk size, chunks on disk) next to `<final>.xfer.partial`; anything that does not match exactly restarts from 0; rejected and stale data is renamed aside, never deleted | Brief: resume mapped to the correct take; research data is never deleted | Implemented, tested (both sides cut, producer restart) |
| D-82 | 2026-10-11 | A one-time 32-hex token per request, sent on the control link, never logged; HELLO with another session, take or token is refused before anything is written | Brief: wrong-session protection; no tokens in logs | Implemented, tested; logs checked |
| D-83 | 2026-10-11 | Delivery consent (XFER-05) per session, explicit performer checkbox, default off (OQ-10 answered as proposed) | Consent | Implemented, tested (refused without it) |
| D-84 | 2026-10-11 | A queued/running transfer makes the producer NOT READY and a sending performer not ready; requests refused while a take is armed/scheduled/recording; QUEUED/PAUSED end FAILED after 60 s; Cancel available | No recording while a file is moving; a failed performer must not block the producer | Implemented, tested |
| D-85 | 2026-10-11 | Control protocol 1.2 (TRANSFER_REQUEST/ACK, tags 34–36); error code 23 `E_TRANSFER_INVALID_FILE` appended | Additive; a 1.1 performer is never sent the new messages | Implemented, tested |

## Product build (11 Oct 2026, after Stage 11, researcher's request)

| # | Date | Decision | Reason | Status |
|---|---|---|---|---|
| D-86 | 2026-10-11 | Installed **VS 2022 Build Tools** (MSVC 14.44 = v143, Windows SDK 10.0.26100) with `winget`, approved by the researcher (UAC). The existing VS 2026 Community install (no C++ tools) was left untouched. Fixed all 6 MSVC warnings in our code: C4458 (local `data` hid `QWidget::data`), C4996 (`strerror` -> `strerror_s`, `_wfopen` -> `_wfsopen(..., _SH_DENYNO)` keeping the same sharing, `getenv` -> `_dupenv_s` in a test). | ADR-002 pins v143; the researcher chose this option | Done: 0 warnings, 170/170 tests |
| D-87 | 2026-10-11 | Qt 6.11.3 msvc2022_64 installed from the official repository archives (qtbase, qtsvg), SHA1-checked, to `D:\Qt` without an account; `RR_QT_DIR` set for the user. aqtinstall 3.3.0 could not read the 6.11 repository layout. | The researcher chose a no-admin, no-account install | Done; translations package not installed |

## Stage 10 (19 Oct 2026): guided interfaces

| # | Date | Decision | Reason | Status |
|---|---|---|---|---|
| D-88 | 2026-10-19 | Add a guided "Start here" tab as the default and keep every existing control in an "All controls" tab, rather than rebuilding the panels | Stage 10 brief: do not replace working engine code to restructure the interface; the research still needs the detailed readouts | Implemented, GUI-tested |
| D-89 | 2026-10-19 | The guided view holds no state: its buttons drive the existing panels' widgets, and everything it shows is read from the controller snapshot on a timer | Brief: UI state must correspond to engine state, not to button clicks; it also makes the two views impossible to desynchronise | Implemented |
| D-90 | 2026-10-19 | One fixed light style sheet for both apps instead of following the system theme | Screenshots go into test reports, so the status colours must have known contrast | Implemented |
| D-91 | 2026-10-19 | Force the Fusion style and a light palette before the style sheet; set the app font with `QApplication::setFont`; ship the check-box indicators as SVG images in a Qt resource | On a PC in dark mode (this one) every unstyled widget drew white text on the white cards, and the consent box was invisible. A style-sheet indicator with no image is a blank square, so the tick had to be supplied. | Implemented; both faults were seen in screenshots of the built app |
| D-92 | 2026-10-19 | Consent and delivery tick boxes are read back from the session panel's own boxes, not from the controller snapshot | The controller does not exist until the session starts, so consent ticked beforehand was being discarded | Fixed; found by the GUI test |
| D-93 | 2026-10-19 | The interface picker ranks a real private address above a `169.254.x` link-local one, and labels the latter "the other PC cannot reach this" | A link-local address means the adapter never got one; choosing it would make the two-PC test fail for a reason the user cannot see | Fixed |
| D-94 | 2026-10-19 | The reference design's features (waveforms, MIDI, samples, plugins) were deliberately not copied; only its layout style was | The engine has none of them, and a control that does nothing would be a false claim in the interface | Decided; open for review |
