# Component 04: Interactive Remote Recording & Communication (C++17)

J26-IM-303 · IT4010 Research Project, SLIIT · Chandrasena P K H P (IT23251182)

Two Windows desktop applications from one C++17 codebase:

- **ProducerStudio.exe** creates and controls the recording session (the authority).
- **PerformerClient.exe** joins the session, follows the producer's schedule, and records locally.

Each PC records its own microphone to a local WAV file at full quality, and the
two people talk over a separate live audio stream (the dual-path design, proposal
v2 §4.1).

## Status

**Stage 4 (real local audio capture and WAV recording) is implemented.** Version 0.1.0.

- **Implemented:**
  - audio engine (miniaudio 0.11.25, WASAPI, explicit device IDs, native rate and channels);
  - a lock-free capture path;
  - a recorder worker that writes float32 WAV `.partial` files, finalises them and never overwrites;
  - gap, device-loss and disk-error handling;
  - crash recovery;
  - JSON take metadata;
  - an audio panel in both apps;
  - the `rr_audio_probe` CLI.
- **Verified on the development PC** (GCC 16.2 build):
  - 52/52 tests pass, 0 warnings, stable over 15 repeats;
  - a real WASAPI capture of 4.07 s gives a finalised WAV whose header matches the file, and Windows' media pipeline opens it.
- **Not verified:**
  - **audible signal content**: the PC's microphone endpoint is muted in Windows, so all samples were 0;
  - the MSVC build and the Qt apps, because MSVC v143 and Qt are not installed.

See `docs/testing/AUDIO_DEVICE_TEST_PROTOCOL.md`, [docs/build/WINDOWS_BUILD.md](docs/build/WINDOWS_BUILD.md) and [docs/STAGE_PLAN.md](docs/STAGE_PLAN.md).

## Build (Windows, MSVC 2022, Qt 6.11.3)

```powershell
$env:RR_QT_DIR = "C:\Qt\6.11.3\msvc2022_64"
cmake --preset msvc-x64
cmake --build --preset msvc-x64-debug
ctest --preset msvc-x64-debug
```
Prerequisites, offline use and troubleshooting: [docs/build/WINDOWS_BUILD.md](docs/build/WINDOWS_BUILD.md).

## Layout

| Path | Contents |
|---|---|
| `apps/producer`, `apps/performer` | The two executables (role wiring only) |
| `libs/shared` | Qt-free: roles, version/build info, error codes, configuration, clock, logging |
| `libs/session` | Qt-free: link/session state definitions and the initial snapshot |
| `libs/ui_common` | Qt Widgets code shared by both apps: start-up/shutdown, main window, diagnostics |
| `libs/audio` | Qt-free: capture engine, ring, recorder worker, WAV writer/inspector, take naming/metadata |
| `libs/network` | Module boundary only (README) |
| `tools/rr_audio_probe` | CLI device and recording check (no Qt) |
| `tests/` | Catch2 unit tests and the no-Qt-in-core boundary check |
| `cmake/` | Toolchain/Qt checks, version generation, compiler options |
| `scripts/build-windows.ps1` | Configure + build + test with the presets |
| `third_party/` | Dependency policy. miniaudio 0.11.25 vendored. |
| `docs/` | Research index, audit, requirements, architecture, ADRs, build guide |

Architecture-to-code map: [docs/architecture/CODE_MAP.md](docs/architecture/CODE_MAP.md).

## Documents

| Document | Contents |
|---|---|
| [docs/research/RESEARCH_PRESERVATION_INDEX.md](docs/research/RESEARCH_PRESERVATION_INDEX.md) | Every existing paper, proposal, prototype and data file, with hashes, scope extraction and missing items. Nothing was moved or deleted. |
| [docs/project/REPOSITORY_AUDIT.md](docs/project/REPOSITORY_AUDIT.md) | Repository map, actual build and run results of both prototypes, C++ vs Rust comparison, path to the PP1 demo |
| [docs/requirements/PRODUCT_REQUIREMENTS.md](docs/requirements/PRODUCT_REQUIREMENTS.md) | MoSCoW requirements with trace, test and evidence for each |
| [docs/requirements/USE_CASES.md](docs/requirements/USE_CASES.md) | UC-01…UC-10 |
| [docs/requirements/PP1_ACCEPTANCE_MATRIX.md](docs/requirements/PP1_ACCEPTANCE_MATRIX.md) | PP1 completion criteria, reproducible tests, MUST→test traceability |
| [docs/requirements/ASSUMPTIONS_AND_OPEN_QUESTIONS.md](docs/requirements/ASSUMPTIONS_AND_OPEN_QUESTIONS.md) | Assumptions, open questions, provisional defaults |
| [docs/build/WINDOWS_BUILD.md](docs/build/WINDOWS_BUILD.md) | Windows build: prerequisites, commands, verification status, troubleshooting |
| [docs/architecture/CODE_MAP.md](docs/architecture/CODE_MAP.md) | Architecture concepts to code locations and their status |
| [docs/environment/TOOLCHAIN_AUDIT.md](docs/environment/TOOLCHAIN_AUDIT.md) | What is installed, what is missing, setup commands |
| [docs/architecture/SYSTEM_ARCHITECTURE.md](docs/architecture/SYSTEM_ARCHITECTURE.md) | **Current architecture**: structure, audio policies, measurement definitions, dependencies, risks |
| [docs/architecture/COMPONENT_DIAGRAM.md](docs/architecture/COMPONENT_DIAGRAM.md) | Mermaid component, data-path and deployment diagrams |
| [docs/architecture/THREADING_AND_AUDIO_CALLBACKS.md](docs/architecture/THREADING_AND_AUDIO_CALLBACKS.md) | Threads, bounded queues, callback rules, shutdown order |
| [docs/architecture/SESSION_STATE_MACHINE.md](docs/architecture/SESSION_STATE_MACHINE.md) | Link and session/take state machines with transition tables |
| [docs/architecture/PROTOCOL_OVERVIEW.md](docs/architecture/PROTOCOL_OVERVIEW.md) | Media header, jitter policy, probes, control messages, codes, timeouts |
| [docs/architecture/adr/](docs/architecture/adr/README.md) | ADR-001…015 |
| [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) | Stage 0 draft (superseded, kept) |
| [docs/architecture/DEPENDENCIES.md](docs/architecture/DEPENDENCIES.md) | Proposed dependencies with pinned versions and licences |
| [docs/decisions/DECISION_LOG.md](docs/decisions/DECISION_LOG.md) | Decisions, continuing proposal Appendix B |
| [docs/STAGE_PLAN.md](docs/STAGE_PLAN.md) | Stages and acceptance criteria |

## Related material (outside this repository, preserved)

- Rust reference prototype: `D:\DAW RESEARCH\PP1\duplexrec-rs\`
- Earlier C++ prototype: `C:\Users\ASUS\Downloads\duplexrec-pp1.zip`
- Decision record: `D:\DAW RESEARCH\PP1\DAW_Component04_Chat_Record.md`

## Security note

The planned PP1 build is **LAN-only and unencrypted**. Use it only on a trusted
private network. See ADR-012.
