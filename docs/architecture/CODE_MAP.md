# Architecture-to-Code Map

**As of Stage 3 (version 0.1.0).**

**Status labels:**
- **Implemented**: code and tests exist and pass in the core check.
- **Implemented, unverified**: code exists but has never been compiled with MSVC/Qt.
- **Planned**: folder or design only.

## Layering (ADR-001), with names used in code
| ADR-001 name | Code | CMake target | Qt? | Status |
|---|---|---|---|---|
| `rr_core` (Qt-free) | `libs/shared`, `libs/session`, `libs/audio`, later `libs/network` | `rr_shared`, `rr_session`, `rr_audio` (+ `rr_miniaudio`) | No (checked by the `core_has_no_qt_includes` test) | shared, session, audio: Implemented. network: Planned. |
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
| State transition tables | — | **Planned** (I-3) |
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
| Media header, control TLV, UDP threads, jitter buffer (ADR-005, 008, 009, 011) | `libs/network/` (README only) | Planned |
| Toolchain and Qt checks with clear messages (ADR-002/004) | `cmake/RrToolchainChecks.cmake`, `cmake/RrQt.cmake` | Implemented (messages captured) |
| Compiler warnings and conformance | `cmake/RrCompilerOptions.cmake` | Implemented (GCC: 0 warnings) |
| Presets: debug/release, core-only, GCC check | `CMakePresets.json` | GCC preset run. MSVC presets not run. |
| Unit tests (ADR-015) | `tests/` | Implemented, 64/64 pass (GCC), stable over 10 repeats |

## Deviations from the Stage 2 documents (recorded in DECISION_LOG D-22, D-23)
- **Generator:** ADR-002 said Ninja. The presets use **"Visual Studio 17 2022" with `toolset v143` pinned**. That generator selects the toolset itself and needs no Developer Command Prompt, which makes the build easier to reproduce from a plain terminal.
- **Library names:** see the layering note above.
