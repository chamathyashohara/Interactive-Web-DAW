# Windows Build Guide

**Applies to:** Stage 3 foundation (version 0.1.0). Two Qt Widgets apps,
`ProducerStudio.exe` and `PerformerClient.exe`, plus Qt-free libraries and unit tests.
**Toolchain (ADR-002):** MSVC v143 (Visual Studio 2022), C++17, CMake ≥ 3.21, Qt 6.11.3
`msvc2022_64`, Windows 10 1809+ / 11 x64.

## 0. What has and has not been verified (11 October 2026)

| Check | Result | Where |
|---|---|---|
| Qt-free libraries + 26 tests, built with **GCC 16.2 (MinGW)** via preset `core-check-gcc` | **PASS**: 0 warnings, 26/26 tests | Stage 3 report |
| Configure fails with a clear message: no VS, non-MSVC compiler, non-MSVC with apps, Qt missing | **PASS** (messages captured) | Stage 3 report |
| Build with **MSVC v143** | **NOT TESTED**: the MSVC toolset is not installed on the development PC | — |
| Build of the two **Qt apps** and their smoke tests | **NOT TESTED**: Qt is not installed on the development PC | — |

The commands below are the intended reference procedure. Run them on a PC with
the prerequisites, and record the output in the next stage report.

## 1. Prerequisites (one time per PC)

1. **Visual Studio 2022 Build Tools** with the C++ workload. This brings MSVC v143, the Windows SDK and CMake. Admin rights needed, several GB:
   ```powershell
   winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```
   It can sit next to Visual Studio 2026. The presets pin toolset `v143`.
2. **Qt 6.11.3 for MSVC 2022 64-bit**, using the Qt Online Installer (free Qt account). Select only *Qt 6.11.3 → MSVC 2022 64-bit*. Then:
   ```powershell
   setx RR_QT_DIR C:\Qt\6.11.3\msvc2022_64
   ```
   Open a new terminal afterwards so the variable is visible.
3. **Git for Windows.**
4. **Internet access at the first configure,** to download Catch2. For offline use, see §5.

## 2. Build from a clean checkout (product build)

Run in PowerShell, in the repository root:

```powershell
cmake --preset msvc-x64                    # configure (Visual Studio 17 2022, x64, v143)
cmake --build --preset msvc-x64-debug      # or msvc-x64-release
ctest --preset msvc-x64-debug              # unit tests + both app smoke tests
```
or the same steps through the script:
```powershell
.\scripts\build-windows.ps1 -Config Debug
```

**Outputs:** `build\msvc-x64\bin\Debug\`:
- `ProducerStudio.exe`
- `PerformerClient.exe`
- `rr_unit_tests.exe`
- the Qt DLLs and `platforms\qwindows.dll`, copied by `windeployqt` after each app build

**Expected `ctest` result:**
- 26 unit/boundary tests;
- `producer_smoke` and `performer_smoke`: each app opens its window, checks that it shows its role name, "Not connected" and "Not ready", logs `smoke_test_passed` and exits 0.

**Start the apps:**
```powershell
.\build\msvc-x64\bin\Debug\ProducerStudio.exe
.\build\msvc-x64\bin\Debug\PerformerClient.exe
```
Each window shows:
- its own role name ("Producer Studio" or "Performer Client");
- "Connection: Not connected" and "Session: Not ready: …";
- a notice that audio, recording and networking are not implemented;
- the LAN-only security notice.

The **Diagnostics** tab shows the build, Qt, OS, configuration and recent log records.

**Logs:** one JSON Lines file per run, in
`%LOCALAPPDATA%\SLIIT-J26-IM-303\<ProducerStudio|PerformerClient>\logs\`
(override with `--log-dir <folder>`).

## 3. Qt-free libraries only

```powershell
cmake --preset msvc-x64-core
cmake --build --preset msvc-x64-core-debug
ctest --preset msvc-x64-core-debug
```

## 4. Portability check without MSVC (not a product build)

This is the check that **was** run on the development PC: GCC/MinGW + Ninja,
apps off, statically linked.
```bash
cmake --preset core-check-gcc
cmake --build --preset core-check-gcc
ctest --preset core-check-gcc
```

## 5. Dependencies and how they are acquired
See `third_party/README.md`.
- **Catch2:** fetched at configure time and **checked against a pinned SHA-256**. To build offline:
  1. download `https://github.com/catchorg/Catch2/archive/refs/tags/v3.16.0.tar.gz` on a connected PC;
  2. check its SHA-256 equals `0957cae5…af34`;
  3. unpack it and configure with `-DFETCHCONTENT_SOURCE_DIR_CATCH2=<unpacked folder>`.

  The source-dir override skips the hash check, so check the archive yourself in step 2.
- **Qt:** installed manually (§1). Never committed.

## 6. Options
| CMake option | Default | Meaning |
|---|---|---|
| `RR_BUILD_APPS` | ON | Build the two Qt apps |
| `RR_BUILD_TESTS` | ON | Build the tests (fetches Catch2) |
| `RR_RUN_WINDEPLOYQT` | ON | Copy the Qt runtime next to the apps after each build |
| `RR_WARNINGS_AS_ERRORS` | OFF | `/WX` or `-Werror`. OFF until a full MSVC build has been seen warning-free. |
| `RR_ALLOW_UNPINNED_MSVC` | OFF | Accept a toolset other than v143 (for example VS 2026 v145). The deviation goes into the build info. |
| `RR_ALLOW_NON_MSVC` | OFF | Allow GCC/Clang for the Qt-free check only |

## 7. Troubleshooting (messages seen on the development PC)
| Message | Cause | Fix |
|---|---|---|
| `Generator Visual Studio 17 2022 could not find any instance of Visual Studio.` | VS 2022 Build Tools not installed. VS 2026 alone doesn't count. | §1 step 1 |
| `MSVC_VERSION 19xx … is not the pinned toolchain` | Configured with a toolset other than v143 | Use the `msvc-x64` preset, or `-DRR_ALLOW_UNPINNED_MSVC=ON` (recorded as a deviation) |
| `Product builds require MSVC v143 …` | GCC/Clang selected | Use `msvc-x64`, or `core-check-gcc` for the Qt-free check |
| `Qt 6.11 or newer … was not found` | `RR_QT_DIR` / `CMAKE_PREFIX_PATH` not set or wrong | §1 step 2 |
| Catch2 download `status_code: 60 … SSL peer certificate … not OK`, `SSL Trust Anchors:` empty | The CMake on PATH has no CA certificates. Seen with the WinLibs MinGW CMake 4.4.2. | Use VS's CMake, or pass `-DCMAKE_TLS_CAINFO="C:/Program Files/Git/mingw64/etc/ssl/certs/ca-bundle.crt"`. **Do not set `CMAKE_TLS_VERIFY=0`.** |
| A MinGW-built exe exits immediately (code 127) | An older `libstdc++-6.dll` from Git is found first on PATH | The `core-check-gcc` preset links statically. Product builds use MSVC. |
| `The object file directory … has 196 characters. The maximum full path to an object file is 250` (in Catch2) | The checkout path is too deep. Seen when cloning into a deep temp folder. | Clone to a short path such as `C:\src\rr` |
| App starts with "could not find the Qt platform plugin windows" | `windeployqt` did not run | Rebuild with `RR_RUN_WINDEPLOYQT=ON`, or run `%RR_QT_DIR%\bin\windeployqt.exe <exe>` |

## 8. Running on another PC (packaging is not automated yet)
Copy `bin\Release\` (the exes plus the `windeployqt` output). On the target PC, run the
**official `vc_redist.x64.exe`** once (ADR-002). Add the `LICENSES\` folder and
`NOTICE.txt` required by ADR-004 before giving the build to anyone. That
packaging step is planned, not implemented.

## 9. CI recipe (not set up: the repository has no remote yet)
On a hosted `windows-2022` runner, which has VS 2022:
1. check out the repo;
2. install Qt 6.11.3 `msvc2022_64` with a pinned Qt installer step;
3. set `RR_QT_DIR`;
4. run §2's three commands with the release presets.

The smoke tests need an interactive desktop session, which hosted Windows runners
provide. Nothing in this recipe has been run.
