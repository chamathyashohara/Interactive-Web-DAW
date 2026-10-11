# third_party: policy

**Committed here:** only small source dependencies that must be vendored for a
reproducible build, each pinned with its version, origin URL, SHA-256 and licence
file. Vendored so far: miniaudio (Stage 4).

**Never committed:** downloaded binaries (Qt, MSVC runtime, installers), build
outputs, credentials or keys.

| Dependency | How it is obtained | Pinned by | Licence | Since |
|---|---|---|---|---|
| Catch2 v3.16.0 (tests only) | CMake `FetchContent` at configure time from `https://github.com/catchorg/Catch2/archive/refs/tags/v3.16.0.tar.gz` | SHA-256 `0957cae5821b17ce07f0833aaa52b5137643a8382203221f363a8303c109af34` in `tests/CMakeLists.txt` | BSL-1.0 (not shipped) | Stage 3 |
| Qt 6.11.3 `msvc2022_64` | Installed by the developer (Qt Online Installer). Located through `RR_QT_DIR`. | Version check in `cmake/RrQt.cmake` (warns on a different version) | LGPL-3.0, dynamic (ADR-004) | Stage 3 |
| miniaudio 0.11.25 | **Vendored** in `third_party/miniaudio/` (unmodified `miniaudio.h` + `LICENSE`) | SHA-256 in `third_party/miniaudio/README.md` | Public domain / MIT-0 | Stage 4 |
| libopus 1.6.1 | FetchContent with URL hash, or a vendored tarball (ADR-006) | — | BSD-3-Clause | Opus increment |
