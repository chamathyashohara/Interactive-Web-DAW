# Toolchain Audit: Development PC

**Host:** Windows 11 Pro 10.0.26300, x64

This file has two parts. §1 is the **current** state of the development PC.
§2 is the original Stage 0 audit, kept unchanged as the record of what was
missing when the project started. Nothing from it was deleted.

---

## 1. Current state (20 October 2026)

**Both Stage 0 blockers are resolved.** The product build works: see
`docs/build/WINDOWS_BUILD.md` §0 for the build and test results, and
`docs/STAGE_PLAN.md` for the per-stage status.

| Tool | Found | Version / location | Usable for the C++17 target? |
|---|---|---|---|
| MSVC v143 (VS 2022 Build Tools) | **Yes** | 14.44.35207, `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207` | **Yes.** `MSVC_VERSION` 1944 is inside the pinned 1930–1949 range (ADR-002), so `RrToolchainChecks.cmake` accepts it without `RR_ALLOW_UNPINNED_MSVC`. |
| Windows SDK | Yes | 10.0.26100 | Yes |
| Qt 6 | **Yes** | **6.11.3 `msvc2022_64`, installed at `D:\Qt\6.11.3\msvc2022_64`** | **Yes.** Exactly the version pinned by ADR-004, so `RrQt.cmake` issues no version warning. |
| CMake | Yes | 4.4.2 (WinLibs MinGW package) | Yes (≥ 3.21 required). The CMake shipped with the VS Build Tools also works. |
| Ninja | Yes | from WinLibs | Yes (used by the `core-check-gcc` preset) |
| MinGW-w64 g++ | Yes | 16.2.0 (WinLibs UCRT, POSIX threads) | Not the target compiler. Used only for the Qt-free portability check. |
| Git | Yes | Git for Windows | Yes |
| Python | Yes | 3.13 | Analysis scripts in `tools/audit/` |
| Visual Studio Community 2026 | Yes | 18.4.11626.88 | Not used. The v145 toolset it provides is **not** the pinned toolchain; the VS 2022 Build Tools sit beside it and the presets pin `v143`. |
| Rust | Yes | `stable-x86_64-pc-windows-gnu` | Only for the preserved reference prototype |
| vcpkg | No | — | Not required (see DEPENDENCIES.md) |

### Qt install deviation (D-87)

The Qt Online Installer was **not** used. `aqtinstall` 3.3.0 cannot read the
per-kit repository layout Qt uses for 6.11.x, so the two archives needed
(`qtbase`, `qtsvg` of package `qt.qt6.6113.win64_msvc2022_64`) were downloaded
from the Qt SDK repository, checked against the published `.sha1` files (both
OK), and extracted to `D:\Qt\6.11.3\msvc2022_64`. `RR_QT_DIR` points there in
the user environment. `qttranslations` is **not** installed, so `windeployqt`
warns that Qt translations are unavailable; the UI is English only.

**Note the drive.** The install path is `D:\Qt`, not the `C:\Qt` used as the
example throughout `docs/build/WINDOWS_BUILD.md`. On this PC:

```powershell
$env:RR_QT_DIR = "D:\Qt\6.11.3\msvc2022_64"
```

### Dependencies fetched at configure time

`libopus` 1.6.1 (SHA-256 pinned in `cmake/RrOpus.cmake`) and Catch2 v3.16.0 are
downloaded by `FetchContent` on the first configure of a build tree, so the
**first configure needs internet access**. `FETCHCONTENT_FULLY_DISCONNECTED` is
OFF and no source directories are pinned. For an offline configure, unpack the
archives and pass `-DFETCHCONTENT_SOURCE_DIR_OPUS=<path>` and
`-DFETCHCONTENT_SOURCE_DIR_CATCH2=<path>`. On the last configure libopus
selected `OPUS_USE_ALLOCA=ON`, which is what the live decode path requires
(ADR-011); the configure stops if it would fall back to the pseudostack.

### Build trees are not portable between folders

A configured build tree records absolute paths. If the repository is copied or
moved to another folder or drive, **delete `build/` and configure again** —
the generated project files, the cache and `_deps` all point at the old
location.

### Still not available

- **A second physical PC.** Every stage so far was verified with both
  applications on this one PC. All 17 MUST tests in
  `docs/requirements/PP1_ACCEPTANCE_MATRIX.md` require two PCs and are
  **NOT RUN** (assumption A-01).
- **A real wireless link.** The Stage 12 constants (ADR-022) were exercised
  with synthetic timestamps only.
(`tools/fault/send_bad_packets.py`, required by T-05(e) and T-12, now exists.)

### How to check the setup on a fresh PC

Run in a developer prompt with the VS 2022 Build Tools environment:

```bat
cl
cmake --version
where ninja
dir %RR_QT_DIR%\bin\Qt6Widgets.dll
```

Expected: `cl` prints `Microsoft (R) C/C++ Optimizing Compiler Version 19.44`
for x64.

---

## 2. Original Stage 0 audit (11 October 2026) — historical record

This is the audit as written at Stage 0, when neither MSVC nor Qt was
installed. It is kept for the record; §1 above supersedes it.

### What was installed at Stage 0

| Tool | Found | Version / location | Usable for the C++17 target? |
|---|---|---|---|
| Visual Studio | Yes | **Visual Studio Community 2026**, 18.4.11626.88, `C:\Program Files\Microsoft Visual Studio\18\Community` | **No.** The C++ workload was not installed: `VC\Tools\MSVC` did not exist, and `cl.exe` was not on PATH. |
| MSVC 2022 (v143) | **No** | — | **Blocker** for the required toolchain. |
| CMake | Yes | 4.4.2 (from the WinLibs MinGW package) | Yes |
| Ninja | Yes | from WinLibs | Yes |
| MinGW-w64 g++ | Yes | 16.2.0 (WinLibs UCRT, POSIX threads) | Not the target compiler. Fine for a portability compile check only. |
| Git | Yes | Git for Windows (`/mingw64/bin/git`) | Yes |
| Qt 6 | **No** | No `C:\Qt`, and no `qmake` on PATH | **Blocker** for the GUI. |
| vcpkg | No | — | Not required (see DEPENDENCIES.md) |
| Rust | Yes | `stable-x86_64-pc-windows-gnu` | Only for the preserved reference prototype |
| Python | Yes | 3.13 | Analysis scripts (`plot_take.py`) |

### Verified in Stage 0

- `cargo test --release` in `D:\DAW RESEARCH\PP1\duplexrec-rs` → **14 passed, 0 failed**. The reference prototype still builds.
- `vswhere -all -products *` lists only *Visual Studio Community 2026* and *SQL Server Management Studio 22*.

### Not verified at Stage 0 (could not be)

- No C++ source was compiled with MSVC, because there was no MSVC toolset.
- No Qt build, because Qt was not installed.
- Only one PC was available, so no two-PC test was possible.

### Setup that was required (both options recorded; Option A was taken)

**Option A (recommended, matches "MSVC 2022" exactly): VS 2022 Build Tools side by side**

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

`VCTools` with `--includeRecommended` installs the MSVC v143 compiler, the
Windows 11 SDK and the CMake/Ninja integration. Expect several GB. VS
Community 2026 can stay installed alongside it.

**Option B: add the C++ workload to the existing VS Community 2026**

Visual Studio Installer → Modify → **Desktop development with C++**. This gives
the default **v145 / MSVC 14.50** toolset. Microsoft says older **MSVC
14.30–14.43** (v143-range) toolsets can be added from *Individual components*
in the VS 2026 installer
([MSVC blog, 4 Feb 2026](https://devblogs.microsoft.com/cppblog/msvc-build-tools-versions-14-30-14-43-now-available-in-visual-studio-2026/)).
v145 accepts C++17 code, but it is **not** "MSVC 2022".

**Outcome:** Option A was taken (D-86). MSVC 14.44 / v143 is in use; the v145
toolset is not used.
