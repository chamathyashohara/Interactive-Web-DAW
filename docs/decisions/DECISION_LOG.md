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
