# ADR-002: Toolchain is MSVC 2022 (v143), C++17, CMake, x64

- **Status:** Proposed. **Depends on OQ-04.** · **Traces:** BRIEF, APP-01, E-BUILD

## Decision
- **Compiler:** MSVC v143 (Visual Studio 2022 Build Tools, installed next to the existing VS 2026), with `/std:c++17 /W4 /permissive- /utf-8`. Target is Windows x64 only.
- **Build:** CMake with the Ninja generator, using `CMakePresets.json` (`win-x64-debug`, `win-x64-release`).
  - `cmake_minimum_required(VERSION 3.21)`.
  - Qt's getting-started examples use 3.16, and the page points to a separate "supported CMake versions" page. Confirm against that page when installing Qt (I-1).
- **Windows SDK:** whichever comes with the VCTools workload.
- **Deployment:** `windeployqt` for each exe, plus the **official `vc_redist.x64.exe`** installed once on each demo PC. Qt's Windows deployment page says MSVC runtime DLLs taken from a development machine are "not intended or licensed for redistribution".

## Consequences and risks
- Nothing can be built until the Build Tools are installed (TOOLCHAIN_AUDIT).
- Qt's `msvc2022_64` binaries match v143. Qt's supported-platforms page lists MSVC 2022 for Windows 10 1809+ and Windows 11 x64.
- MinGW is **not** used for products. Stage 0 showed a dynamic MinGW build failing to start because of DLL conflicts on PATH (REPOSITORY_AUDIT C1).

## Alternatives
- **v145 (VS 2026 default):** would also compile C++17, but it is not "MSVC 2022". It is the fallback if OQ-04 is answered that way.
