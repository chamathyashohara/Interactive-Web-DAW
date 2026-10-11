# Architecture-to-Code Map

**As of Stage 6 (version 0.1.0).** (Created in Stage 3; rows are updated as stages land.)

**Status labels:**
- **Implemented**: code and tests exist and pass in the core check.
- **Implemented, unverified**: code exists but has never been compiled with MSVC/Qt.
- **Planned**: folder or design only.

## Layering (ADR-001), with names used in code
| ADR-001 name | Code | CMake target | Qt? | Status |
|---|---|---|---|---|
| `rr_core` (Qt-free) | `libs/shared`, `libs/session`, `libs/audio`, `libs/network`, `libs/control` | `rr_shared`, `rr_session`, `rr_audio` (+ `rr_miniaudio`), `rr_network`, `rr_control` | No (checked by the `core_has_no_qt_includes` test) | Implemented. network: control path only (UDP media planned). |
| `rr_app` (Qt shared layer) | `libs/ui_common` | `rr_ui` | Yes | Implemented, unverified |
| ProducerStudio.exe | `apps/producer` | `ProducerStudio` | Yes | Implemented, unverified |
| PerformerClient.exe | `apps/performer` | `PerformerClient` | Yes | Implemented, unverified |
| `rr_verify.exe` | — | — | No | Planned (VER-01) |

**Why the split differs from the ADR-001 names:** the Stage 3 brief suggested
`libs/shared`, `libs/audio`, `libs/session` and `libs/network`. The ADR's
single `rr_core` is now spread over those Qt-free folders, which keeps module
boundaries visible at the file-system level. The rule is unchanged: Qt only in
`libs/ui_common` and `apps/`.

## Concepts → files
| Concept (document) | File(s) | Status |
|---|---|---|
| Roles, display names (APP-01) | `libs/shared/include/rr/shared/role.hpp`, `src/role.cpp` | Implemented |
| Version, commit, protocol 1.0, compiler, deviation (APP-02) | `cmake/RrVersion.cmake`, `cmake/version_info.hpp.in`, `libs/shared/.../build_info.hpp` | Implemented |
| Error codes and take statuses (PROTOCOL §6) | `libs/shared/.../error_codes.hpp` | Implemented (numbering tested) |
| Provisional configuration (PROTOCOL §8, ASSUMPTIONS §3) | `libs/shared/.../config.hpp` | Implemented. Defaults only, no config file yet. |
| Monotonic and UTC time (ADR-010) | `libs/shared/.../clock.hpp` | Implemented |
| Real-time thread marker (THREADING §5) | `libs/shared/.../realtime_guard.hpp` | Implemented. Used by the logger and set by `CaptureIngest::on_block`. |
| Structured, non-blocking logging | `libs/shared/.../log.hpp`, `log_sinks.hpp`, `src/logger.cpp`, `src/log_record.cpp` | Implemented |
| Qt messages → structured log | `libs/ui_common/src/qt_log_bridge.*` | Implemented, unverified |
| Link and session state names, initial snapshot (SESSION_STATE_MACHINE §2, §3, §5) | `libs/session/.../states.hpp` | Implemented (definitions only) |
| State transition tables (SESSION_STATE_MACHINE §3, §7) | `libs/session/.../session_machine.hpp`, `src/session_machine.cpp` | Implemented, tested exhaustively (every state × event) |
| App start-up/shutdown, command line, smoke test | `libs/ui_common/src/app_runner.cpp` | Implemented, unverified |
| Main window, status display, diagnostics, About/LGPL/security notices | `libs/ui_common/src/main_window.*`, `diagnostics.*` | Implemented, unverified |
| Audio engine: miniaudio context, enumeration, explicit-ID capture, notifications (ADR-003) | `libs/audio/.../audio_engine.hpp`, `src/audio_engine.cpp` | Implemented. Real WASAPI capture run via `rr_audio_probe` (GCC build). |
| Callback-side ingest: ring, meters, counters, gap events (THREADING §3) | `libs/audio/.../capture_ingest.hpp` | Implemented, tested (test signal) |
| SPSC ring | `libs/audio/.../spsc_ring.hpp` | Implemented, tested (2-thread stress) |
| Recorder worker: drain, gaps → silence, watchdog, header refresh, finalisation (THREADING §7) | `libs/audio/.../take_recorder.hpp` | Implemented, tested (test signal) |
| Safe WAV writer and inspector/recovery (ADR-007) | `libs/audio/.../wav_format.hpp`, `wav_writer.hpp`, `wav_inspect.hpp`, `file_io.hpp` | Implemented, tested |
| Take/session naming, JSON metadata (REC-03/04, VER-02) | `libs/audio/.../take_naming.hpp`, `take_metadata.hpp` | Implemented, tested |
| Audio panel: devices, meters, record/stop, results, recovery (DEV-01..05, REC-01..10, ERR-05/06) | `libs/ui_common/src/audio_panel.*` | Implemented, unverified (no Qt) |
| Monitor bus: capture to output monitoring, test tone, buffer policy, counters (MONITOR_PATH) | `libs/audio/.../monitor_bus.hpp` | Implemented, tested, run on real devices |
| Output device, reopen logic, device event counters | `libs/audio/src/audio_engine.cpp` | Implemented, run on real devices |
| Engine diagnostic snapshot (JSON) | `libs/audio/src/engine_report.cpp` | Implemented, output validated as JSON |
| Diagnostic report export (rr.diagnostics.v1) | `libs/ui_common/src/diagnostics.*`, `main_window.cpp` | Implemented, unverified (no Qt) |
| Device/recording/monitor CLI check | `tools/rr_audio_probe/` | Implemented. Run on this PC. |
| Lexical check for broken literals | `tools/check_sources.py` | Implemented, a ctest test |
| Control protocol 1.0 codec: frames, TLV, validation, bounded decoder (PROTOCOL §11, ADR-009) | `libs/network/.../control_protocol.hpp`, `src/control_protocol.cpp` | Implemented, tested (malformed, oversize, duplicate tags, split reads) |
| Sockets: interface listing, explicit-interface listen, non-blocking connect (ADR-016) | `libs/network/.../socket.hpp`, `src/socket.cpp` | Implemented, run on loopback and the Wi-Fi address |
| Control link: HELLO/JOIN, pairing code, resume token, heartbeats, link loss, reconnect, session-full, graceful close | `libs/network/.../control_link.hpp`, `src/control_link.cpp` | Implemented, tested (loopback) |
| Clock offset from heartbeat timestamps (min-δ, u = δmin/2) (ADR-010) | `libs/network/.../clock_offset.hpp` | Implemented, tested |
| Session controller: readiness, consent, two-step start, stop, reports, duplicates, timeouts | `libs/control/.../session_controller.hpp` | Implemented, tested (test recorder), two-process runs |
| Recorder ports: real (AudioEngine) and test recorder | `libs/control/.../recorder_port.hpp` | Implemented. Real port run with `--audio`. |
| Scheduled start/stop in the recorder (capture stamps, pre-roll, late-start report) | `libs/audio/.../take_recorder.hpp`, `capture_ingest.hpp` | Implemented, tested (test signal) |
| Session panel (producer/performer UI) | `libs/ui_common/src/session_panel.*` | Implemented, **unverified** (no Qt; syntax-checked against stub headers only) |
| Session CLI | `tools/rr_session_probe/` | Implemented. Run on this PC. |
| Media header v1 codec, CRC-32, validation order, receiver report (PROTOCOL §12, ADR-008/017) | `libs/media/.../media_packet.hpp`, `src/media_packet.cpp` | Implemented, tested (every rejection reason) |
| Opus 1.6.1 encoder/decoder wrappers, bounded live settings (ADR-006/017) | `libs/media/.../opus_codec.hpp`, `live_settings.hpp`, `cmake/RrOpus.cmake` | Implemented, tested (all frames x both modes, CBR size, tone round trip, PLC) |
| Jitter buffer (ADR-011) | `libs/media/.../jitter_buffer.hpp` | Implemented, tested (loss, reorder, late, duplicates, underrun/refill, too-early, 2^32 wrap, drift skip) |
| Arrival statistics: loss estimate, duplicates, reordering, RFC 3550 jitter | `libs/media/.../arrival_stats.hpp` | Implemented, tested |
| Capture -> sender hand-over (mono tap) and playback-contributor hook | `libs/audio/.../live_tap.hpp`, `src/audio_engine.cpp` | Implemented, tested (tap); hook run on a real output device |
| Live sender (media-send thread) and live receiver (media-receive thread + playback render) | `libs/media/.../live_sender.hpp`, `live_receiver.hpp` | Implemented, tested over loopback UDP, two-process runs |
| UDP socket: explicit-interface bind, connected client, ICMP-reset workaround | `libs/network/.../socket.hpp` (`UdpSocket`) | Implemented, run on loopback and the Wi-Fi address |
| Test-only network impairment (loss, duplicates, reordering, bursts) | `libs/media/.../net_impairment.hpp` | Implemented (test/probe only) |
| Live audio panel (producer/performer UI) | `libs/ui_common/src/live_panel.*` | Implemented, **unverified** (no Qt; syntax-checked against stub headers only) |
| Live-sink WAV analysis | `tools/audit/analyse_live_sink.py` | Implemented, used for the Stage 7 evidence |
| Two-way endpoint: one socket/thread, peer learning, reachability, direction check, reports (ADR-018) | `libs/media/.../live_endpoint.hpp` | Implemented, tested (loopback duplex tests), two-process runs |
| Outgoing stream (tap -> Opus -> datagrams, send mute) / incoming stream (arrival, queue, jitter buffer, decode, receive mute) | `libs/media/.../outgoing_stream.hpp`, `incoming_stream.hpp` | Implemented, tested |
| One-page live report, per-direction status texts | `libs/media/.../live_report.hpp` | Implemented, used by the probe; app export unverified (Qt) |
| Two-way analysis (own/remote tone share, burst round trip) | `tools/audit/analyse_live_duplex.py` | Implemented, used for the Stage 8 evidence |
| Readiness checklist items, encoding (ADR-019) | `libs/control/.../readiness.hpp` | Implemented, tested |
| Coordinated take hardening: session id check, start-lead minimum, stop-before-start, timing record | `libs/control/src/session_controller.cpp` | Implemented, tested, real-device runs on one PC |
| Take timing analysis; WAV verification (independent reader; Windows MCI open check) | `tools/audit/analyse_take_timing.py`, `verify_take_wav.py`, `mci_open_check.c` | Implemented, used for the Stage 9 evidence |
| UDP clock probes (ADR-010) | - | Planned |
| Toolchain and Qt checks with clear messages (ADR-002/004) | `cmake/RrToolchainChecks.cmake`, `cmake/RrQt.cmake` | Implemented (messages captured) |
| Compiler warnings and conformance | `cmake/RrCompilerOptions.cmake` | Implemented (GCC: 0 warnings) |
| Presets: debug/release, core-only, GCC check | `CMakePresets.json` | GCC preset run. MSVC presets not run. |
| Unit tests (ADR-015) | `tests/` | Implemented. All pass (GCC), stable over 10 repeats; see the Stage 6 report for the count. |

## Deviations from the Stage 2 documents (recorded in DECISION_LOG D-22, D-23)
- **Generator:** ADR-002 said Ninja. The presets use **"Visual Studio 17 2022" with `toolset v143` pinned**. That generator selects the toolset itself and needs no Developer Command Prompt, which makes the build easier to reproduce from a plain terminal.
- **Library names:** see the layering note above.
