# Component 04: Interactive Remote Recording & Communication (C++17)

J26-IM-303 · IT4010 Research Project, SLIIT · Chandrasena P K H P (IT23251182)

Two Windows desktop applications from one C++17 codebase:

- **ProducerStudio.exe** creates and controls the recording session (the authority).
- **PerformerClient.exe** joins the session, follows the producer's schedule, and records locally.

Each PC records its own microphone to a local WAV file at full quality, and the
two people talk over a separate live audio stream (the dual-path design, proposal
v2 §4.1).

## Status

**Stage 6 (producer/performer session control over a controlled LAN) is implemented.** Version 0.1.0.
Stages 4–5 (local recording, monitoring, diagnostics) remain as before.

- **Implemented:**
  - the producer creates a session on an explicitly selected network interface, with a session ID and a single-use 6-digit pairing code (10-minute TTL, locked after 5 wrong attempts);
  - the performer joins with the host address and code;
  - versioned control protocol 1.0: HELLO/JOIN, heartbeats, readiness and consent, ARM → SCHEDULE_START two-step start, STOP_SCHEDULE, acknowledgements, final reports, SESSION_CLOSED;
  - link-loss detection and automatic reconnect;
  - session state machine with invalid-transition refusal;
  - duplicate/stale message protection;
  - scheduled sample-accurate start/stop in each local recorder;
  - Session panel in both apps;
  - `rr_session_probe` CLI.
- **Verified on the development PC** (GCC build, two processes on ONE PC, loopback and Wi-Fi-bound address):
  - all unit tests pass, stable over 10 repeats, 0 warnings;
  - full takes;
  - wrong code;
  - version mismatch;
  - link drop and reconnect during recording;
  - Stop pressed while the link was down;
  - producer closing mid-take;
  - real-audio takes on both "sides" (microphone muted, so silent).
  - These runs found three defects, all fixed. See `docs/testing/evidence/2026-10-11_devpc_stage6_session_runs.txt`.
- **Not verified:**
  - **two separate PCs** (not run yet);
  - the MSVC build and the Qt GUI, including the new Session panel (toolchain not installed; the panel was only syntax-checked against stub headers);
  - audible content.
- **Not implemented:** live talkback audio between the PCs (next stage), take transfer, encryption.

See [docs/testing/SESSION_TEST_PROTOCOL.md](docs/testing/SESSION_TEST_PROTOCOL.md), [PROTOCOL_OVERVIEW §11](docs/architecture/PROTOCOL_OVERVIEW.md), [ADR-016](docs/architecture/adr/ADR-016-control-transport-qt-free-sockets.md).

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
| `libs/session` | Qt-free: link/session state definitions, transition tables |
| `libs/ui_common` | Qt Widgets code shared by both apps: start-up/shutdown, main window, diagnostics, audio panel, session panel |
| `libs/audio` | Qt-free: capture engine, ring, recorder worker, WAV writer/inspector, take naming/metadata |
| `libs/network` | Qt-free: control protocol codec, sockets, control link (pairing, heartbeats, reconnect), clock offset |
| `libs/control` | Qt-free: session controller (state machine + link + local recorder), recorder ports |
| `tools/rr_audio_probe` | CLI device and recording check (no Qt) |
| `tools/rr_session_probe` | CLI producer/performer session runs (no Qt) |
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
| [docs/architecture/adr/](docs/architecture/adr/README.md) | ADR-001…016 |
| [docs/testing/SESSION_TEST_PROTOCOL.md](docs/testing/SESSION_TEST_PROTOCOL.md) | Two-instance and two-PC session tests, Windows Firewall guidance |
| [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) | Stage 0 draft (superseded, kept) |
| [docs/architecture/DEPENDENCIES.md](docs/architecture/DEPENDENCIES.md) | Proposed dependencies with pinned versions and licences |
| [docs/decisions/DECISION_LOG.md](docs/decisions/DECISION_LOG.md) | Decisions, continuing proposal Appendix B |
| [docs/STAGE_PLAN.md](docs/STAGE_PLAN.md) | Stages and acceptance criteria |

## Related material (outside this repository, preserved)

- Rust reference prototype: `D:\DAW RESEARCH\PP1\duplexrec-rs\`
- Earlier C++ prototype: `C:\Users\ASUS\Downloads\duplexrec-pp1.zip`
- Decision record: `D:\DAW RESEARCH\PP1\DAW_Component04_Chat_Record.md`

## Security note

This build is **LAN-only and unencrypted**: the control connection has no TLS and
is protected only by a short-lived pairing code, which is not a security control.
Use it only on a trusted private network. It is not designed or tested for use
across the internet. The apps never change Windows Firewall settings
(see SESSION_TEST_PROTOCOL §3). See ADR-012 and ADR-016.
