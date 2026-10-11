# Architecture Decision Records

All are **Proposed** until the Stage 2 architecture review accepts them.

| ADR | Decision |
|---|---|
| [001](ADR-001-two-executables-shared-core.md) | Two executables over a Qt-free core `rr_core`, a shared Qt layer `rr_app`, and the tool `rr_verify` |
| [002](ADR-002-toolchain-msvc2022-cmake.md) | MSVC 2022 v143, C++17, CMake + Ninja, x64. Official VC++ redistributable. |
| [003](ADR-003-audio-io-miniaudio-separate-devices.md) | miniaudio 0.11.25. Separate capture and playback devices. Explicit device IDs, no auto-routing, native 48 kHz. Device watchdog. |
| [004](ADR-004-ui-qt6-widgets.md) | Qt 6.11.3 Core/Gui/Widgets/Network, dynamic LGPL-3.0, obligations checklist |
| [005](ADR-005-network-split.md) | UDP media and probes on Winsock threads. TCP control on Qt Network in its own thread. *(control row superseded by ADR-016)* |
| [006](ADR-006-live-codec.md) | Codec interface. PCM16 first, Opus 1.6.1 next. 10 ms default, configurable. |
| [007](ADR-007-master-recording-format.md) | WAV float32 native rate. `.partial`, periodic header refresh, rename without overwrite. Proposed REC-02 amendment. |
| [008](ADR-008-media-packet-header-v1.md) | 26-byte header v1: version nibble, CRC over header and payload |
| [009](ADR-009-control-protocol.md) | Length-prefixed TLV control frames, major/minor versioning |
| [010](ADR-010-time-model-and-scheduling.md) | Monotonic clock, UDP probe offset ±δmin/2, scheduled start, honesty limits |
| [011](ADR-011-jitter-buffer-and-playout.md) | Fixed-depth jitter buffer owned by the playback callback. Loss/late/underrun/rebuffer/drift rules. |
| [012](ADR-012-security-scope.md) | LAN-only unencrypted PP1. Established TLS/DTLS later. No custom crypto. |
| [013](ADR-013-no-database-no-resampler.md) | No SQLite, no libsamplerate |
| [014](ADR-014-take-transfer-and-hashing.md) | Transfer on its own TCP connection. SHA-256 via Windows CNG. Original never touched. |
| [015](ADR-015-testing.md) | Catch2 v3.16.0, test-only. Unit, loopback and acceptance tests. |
| [016](ADR-016-control-transport-qt-free-sockets.md) | TCP control on Qt-free sockets in the core (one link thread), explicit interface, TLS deferred. **Implemented in Stage 6.** |
| [017](ADR-017-one-way-live-audio-opus-udp.md) | One-way live audio producer → performer: Opus 1.6.1 over UDP, header v1 with sample counter and receiver reports, address learned from reports, jitter buffer in the playback callback. **Implemented in Stage 7.** |
| [018](ADR-018-two-way-live-audio.md) | Two-way live audio: one endpoint per side, both streams on one UDP flow, send/receive mute, reachability via datagrams or the control link, catch-up and resync. **Implemented in Stage 8.** |
| [019](ADR-019-coordinated-recording.md) | Coordinated recording: itemised readiness on both PCs, session id on commands (control 1.1), start-lead minimum, stop-before-start, per-take timing record. **Implemented in Stage 9.** |
| [020](ADR-020-verified-take-transfer.md) | Verified take transfer: RRXF chunks with per-chunk and whole-file SHA-256, resume journal, producer-named copies without overwrite, VERIFIED only after hash + WAV checks (control 1.2). **Implemented in Stage 11.** |
