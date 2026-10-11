# Architecture-to-Code Map

**As of Stage 3 (version 0.1.0).**

**Status labels:**
- **Implemented**: code and tests exist and pass in the core check.
- **Implemented, unverified**: code exists but has never been compiled with MSVC/Qt.
- **Planned**: folder or design only.

## Layering (ADR-001), with names used in code
| ADR-001 name | Code | CMake target | Qt? | Status |
|---|---|---|---|---|
| `rr_core` (Qt-free) | `libs/shared`, `libs/session`, later `libs/audio`, `libs/network` | `rr_shared`, `rr_session` | No (checked by the `core_has_no_qt_includes` test) | shared and session: Implemented. audio and network: Planned. |
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
| Real-time thread marker (THREADING §5) | `libs/shared/.../realtime_guard.hpp` | Implemented. Used by the logger. Audio callbacks will use it. |
| Structured, non-blocking logging | `libs/shared/.../log.hpp`, `log_sinks.hpp`, `src/logger.cpp`, `src/log_record.cpp` | Implemented |
| Qt messages → structured log | `libs/ui_common/src/qt_log_bridge.*` | Implemented, unverified |
| Link and session state names, initial snapshot (SESSION_STATE_MACHINE §2, §3, §5) | `libs/session/.../states.hpp` | Implemented (definitions only) |
| State transition tables | — | **Planned** (I-3) |
| App start-up/shutdown, command line, smoke test | `libs/ui_common/src/app_runner.cpp` | Implemented, unverified |
| Main window, status display, diagnostics, About/LGPL/security notices | `libs/ui_common/src/main_window.*`, `diagnostics.*` | Implemented, unverified |
| Audio devices, rings, recorder, WAV writer (ADR-003, ADR-007) | `libs/audio/` (README only) | Planned |
| Media header, control TLV, UDP threads, jitter buffer (ADR-005, 008, 009, 011) | `libs/network/` (README only) | Planned |
| Toolchain and Qt checks with clear messages (ADR-002/004) | `cmake/RrToolchainChecks.cmake`, `cmake/RrQt.cmake` | Implemented (messages captured) |
| Compiler warnings and conformance | `cmake/RrCompilerOptions.cmake` | Implemented (GCC: 0 warnings) |
| Presets: debug/release, core-only, GCC check | `CMakePresets.json` | GCC preset run. MSVC presets not run. |
| Unit tests (ADR-015) | `tests/` | Implemented, 26/26 pass (GCC) |

## Deviations from the Stage 2 documents (recorded in DECISION_LOG D-22, D-23)
- **Generator:** ADR-002 said Ninja. The presets use **"Visual Studio 17 2022" with `toolset v143` pinned**. That generator selects the toolset itself and needs no Developer Command Prompt, which makes the build easier to reproduce from a plain terminal.
- **Library names:** see the layering note above.
