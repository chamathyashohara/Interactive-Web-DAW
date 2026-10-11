# Component 04: Interactive Remote Recording & Communication (C++17)

J26-IM-303 · IT4010 Research Project, SLIIT · Chandrasena P K H P (IT23251182)

Two Windows desktop applications from one C++17 codebase:

- **ProducerStudio.exe** creates and controls the recording session (the authority).
- **PerformerClient.exe** joins the session, follows the producer's schedule, and records locally.

Each PC records its own microphone to a local WAV file at full quality, and the
two people talk over a separate live audio stream (the dual-path design, proposal
v2 §4.1).

## Status

**Stage 0 (inventory and architecture) is complete. No application code exists yet.**
See [docs/STAGE_PLAN.md](docs/STAGE_PLAN.md).

## Documents

| Document | Contents |
|---|---|
| [docs/research/RESEARCH_PRESERVATION_INDEX.md](docs/research/RESEARCH_PRESERVATION_INDEX.md) | Every existing paper, proposal, prototype and data file, with hashes, scope extraction and missing items. Nothing was moved or deleted. |
| [docs/project/REPOSITORY_AUDIT.md](docs/project/REPOSITORY_AUDIT.md) | Repository map, actual build and run results of both prototypes, C++ vs Rust comparison, path to the PP1 demo |
| [docs/environment/TOOLCHAIN_AUDIT.md](docs/environment/TOOLCHAIN_AUDIT.md) | What is installed, what is missing, setup commands |
| [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) | Threads, queues, protocols, timing terms, state machines, security assumptions |
| [docs/architecture/DEPENDENCIES.md](docs/architecture/DEPENDENCIES.md) | Proposed dependencies with pinned versions and licences |
| [docs/decisions/DECISION_LOG.md](docs/decisions/DECISION_LOG.md) | Decisions, continuing proposal Appendix B |
| [docs/STAGE_PLAN.md](docs/STAGE_PLAN.md) | Stages and acceptance criteria |

## Related material (outside this repository, preserved)

- Rust reference prototype: `D:\DAW RESEARCH\PP1\duplexrec-rs\`
- Earlier C++ prototype: `C:\Users\ASUS\Downloads\duplexrec-pp1.zip`
- Decision record: `D:\DAW RESEARCH\PP1\DAW_Component04_Chat_Record.md`

## Security note

The planned PP1 build is **LAN-only and unencrypted**. Use it only on a trusted
private network. See ARCHITECTURE.md §9.
