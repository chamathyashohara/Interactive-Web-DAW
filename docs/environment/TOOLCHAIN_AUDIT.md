# Toolchain Audit: Development PC

**Date:** 11 October 2026 (Stage 0) · **Host:** Windows 11 Pro 10.0.26300, x64

## What is installed

| Tool | Found | Version / location | Usable for the C++17 target? |
|---|---|---|---|
| Visual Studio | Yes | **Visual Studio Community 2026**, 18.4.11626.88, `C:\Program Files\Microsoft Visual Studio\18\Community` | **No.** The C++ workload is not installed: `VC\Tools\MSVC` does not exist, and `cl.exe` is not on PATH. |
| MSVC 2022 (v143) | **No** | — | **Blocker** for the required toolchain. |
| CMake | Yes | 4.4.2 (from the WinLibs MinGW package) | Yes. CMake from the VS workload can be used instead once that is installed. |
| Ninja | Yes | from WinLibs | Yes |
| MinGW-w64 g++ | Yes | 16.2.0 (WinLibs UCRT, POSIX threads) | Not the target compiler. Fine for a portability compile check only. |
| Git | Yes | Git for Windows (`/mingw64/bin/git`) | Yes |
| Qt 6 | **No** | No `C:\Qt`, and no `qmake` on PATH | **Blocker** for the GUI. |
| vcpkg | No | — | Not required (see DEPENDENCIES.md) |
| Rust | Yes | `stable-x86_64-pc-windows-gnu` | Only for the preserved reference prototype |
| Python | Yes | 3.13 | Analysis scripts (`plot_take.py`) |

## Verified in Stage 0

- `cargo test --release` in `D:\DAW RESEARCH\PP1\duplexrec-rs` → **14 passed, 0 failed**. The reference prototype still builds.
- `vswhere -all -products *` lists only *Visual Studio Community 2026* and *SQL Server Management Studio 22*.

## Not verified (could not be)

- No C++ source was compiled with MSVC, because there is no MSVC toolset.
- No Qt build, because Qt is not installed.
- Only one PC was available, so no two-PC test was possible.

## Required setup (needs the researcher's action: large downloads and admin rights)

### Option A (recommended, matches "MSVC 2022" exactly): VS 2022 Build Tools side by side

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

`VCTools` with `--includeRecommended` installs the MSVC v143 compiler, the
Windows 11 SDK and the CMake/Ninja integration. Expect several GB. VS
Community 2026 can stay installed alongside it.

### Option B: add the C++ workload to the existing VS Community 2026

Open the Visual Studio Installer → Modify → **Desktop development with C++**.
This gives the default **v145 / MSVC 14.50** toolset. Microsoft says older
**MSVC 14.30–14.43** (v143-range) toolsets can be added from *Individual
components* in the VS 2026 installer
([MSVC blog, 4 Feb 2026](https://devblogs.microsoft.com/cppblog/msvc-build-tools-versions-14-30-14-43-now-available-in-visual-studio-2026/)).
v145 accepts C++17 code, but it is **not** "MSVC 2022". If the researcher picks
v145, record that in the decision log.

### Qt 6 (only once the Qt decision in DECISION_LOG.md is approved)

The official Qt Online Installer (needs a free Qt account) → Qt **6.11.3** →
component **MSVC 2022 64-bit** (`msvc2022_64`). Install only **Qt Base**, which
holds Core, Gui, Widgets and Network. Skip the other add-ons.
Install path, for example: `C:\Qt\6.11.3\msvc2022_64`.

## How to check the setup worked (run in a fresh "x64 Native Tools Command Prompt for VS 2022")

```bat
cl
cmake --version
where ninja
dir C:\Qt\6.11.3\msvc2022_64\bin\Qt6Widgets.dll
```

Expected: `cl` prints `Microsoft (R) C/C++ Optimizing Compiler Version 19.4x` for
x64. Send the actual output so it can be recorded in this file.
