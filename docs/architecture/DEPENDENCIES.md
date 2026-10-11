# Dependency Review (Stage 0 proposal: nothing added yet)

Rule: use the smallest set that meets the requirements. Every dependency here is
**proposed**. None of them is in the repository yet. Each one is pinned and
vendored or fetched by hash in the stage that first needs it.

Versions and licences were checked on **11 October 2026** against the sources
linked below.

## Proposed for adoption

| Dependency | Pinned version | Licence | Needed from | Why | How obtained |
|---|---|---|---|---|---|
| **miniaudio** | **0.11.25** (latest release, changelog 2026-03-04) | Public domain (Unlicense) **or** MIT-0, at the user's choice | Stage 1 | WASAPI capture and playback with a duplex callback. It is one header. It was already used by the 9 Oct C++ prototype (which had v0.11.22). | Vendored single header in `third_party/miniaudio/`, with its SHA-256 recorded |
| **Qt 6 Base** (Core, Gui, Widgets) | **6.11.3** (latest 6.11 patch; standard support until 2027-03-17, which covers the expected Feb 2027 viva) | LGPL-3.0 (open source), or commercial | Stage 1 (window shells) | Native Windows UI. It is used **only** in the two app layers, never in the core audio and network library. | Official installer, `msvc2022_64` binaries, dynamic linking, `windeployqt` for deployment |
| **libopus** | **1.6.1** (2026-01-14) | BSD-3-Clause. Royalty-free patent grants from Xiph, Broadcom and Microsoft, with defensive-termination clauses. | Stage 5 (Opus monitoring) | Low-delay codec for the monitor stream. Legal frame sizes are 2.5, 5, 10, 20, 40 and 60 ms. | CMake `FetchContent` from the release tarball, pinned by SHA-256 |
| **Catch2** | v3.x, exact tag pinned in Stage 1 | BSL-1.0 | Stage 1 | Unit tests. The proposal (§4.6) already names it. | `FetchContent` by tag and hash |

## Not adopted now (with the reason)

| Candidate | Decision | Reason |
|---|---|---|
| Standalone Asio 1.36.0 (BSL-1.0) | **Not adopted** | Two peers on a LAN need one UDP socket and one TCP connection. A thin Winsock2 wrapper (`ws2_32`, part of Windows) covers that with no extra dependency, as the 9 Oct C++ prototype showed. Revisit if the event handling becomes complex. |
| JUCE 7 (named in proposal §4.6) | **Not adopted** | Qt 6 Widgets plus miniaudio covers UI and device I/O. JUCE's licence (GPL or commercial) is a heavier commitment. The change goes into the decision log. |
| TLS library (OpenSSL / Qt's Schannel backend) | **Deferred** | The PP1 prototype is LAN-only and unencrypted, and this is documented (ARCHITECTURE.md §9). When the security stage comes, prefer Qt Network's TLS backend (Schannel on Windows, already part of Qt) over adding OpenSSL. No custom cryptography, ever. |
| SHA-256 for take transfer | **Use Windows CNG (`BCrypt*`)** in Stage 6 | It ships with the OS, so no new dependency and no custom crypto. |
| SQLite | **Deferred** | No persistent session database is needed yet. Measurements go to CSV and JSON files, as in the proposal. |
| libsamplerate | **Deferred** | No conversion need has been shown yet. Both devices are required to run at 48 kHz (see ARCHITECTURE.md §4). Revisit for drift-corrected exports (Stage 7). |
| JSON library | **Not adopted** | The apps only *write* small JSON metadata files, and a 100-line escaping writer is enough. Revisit if a parser is needed (Stage 6, reading the performer's take manifest). |
| WebRTC, WebSockets, Node.js, React, Web Audio, Tone.js, MongoDB | **Excluded by scope** | Earlier browser direction. Kept only as history (see RESEARCH_PRESERVATION_INDEX.md §4.4). |

## Qt LGPL obligations to meet at deployment

Link Qt dynamically. Ship the Qt DLLs unmodified, plus the LGPL-3.0 licence text
and a notice stating the Qt version and where to get its source. Do not stop
users replacing the Qt DLLs. This fits a university prototype. The proposal's
commercialisation section (§6) would need these obligations, or a commercial
licence, to be reviewed again before any product release.

## Sources checked

- miniaudio releases: <https://github.com/mackron/miniaudio/releases>; licence: <https://raw.githubusercontent.com/mackron/miniaudio/master/LICENSE>
- Opus downloads: <https://opus-codec.org/downloads/>; licence and patents: <https://opus-codec.org/license/>
- Qt release table: <https://doc.qt.io/qt-6/qt-releases.html> (Qt 6.12.0 is newest and Qt 6.11.3 is the latest 6.11 patch. Qt 6.8 LTS patch releases are **commercial-only**, so open-source users should take the latest 6.11.)
- Asio: <https://www.think-async.com/Asio/LatestStableRelease.html> (1.36.0)
- MSVC in VS 2026: <https://devblogs.microsoft.com/cppblog/msvc-build-tools-versions-14-30-14-43-now-available-in-visual-studio-2026/>

Note: the web search results gave conflicting Qt patch numbers because of
cached pages. The values above come from fetching the official page directly on
11 Oct 2026. Check them again when installing.
