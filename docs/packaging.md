# Packaging the DAW as an installer / portable exe

`npm run dist` builds **one self-contained app** for Windows 10/11 64-bit. Output is in `release/` (git-ignored):

| File | What it is |
|---|---|
| `Collab-DAW-setup-<version>.exe` | Installer (choose the folder, Start-menu entry, uninstaller) |
| `Collab-DAW-portable-<version>.exe` | Single file, runs without installing |
| `win-unpacked/` | The same app as a plain folder (used for testing) |

## What is inside

- the DAW itself (Electron + React): lessons, collaboration (host / join, pointers, Network panel), Live recording tab
- the JUCE audio engine (`resources/engine/daw_engine.exe`)
- Component 4's two programs with their Qt files (`resources/remote-recording/ProducerStudio.exe`, `PerformerClient.exe`)
- the Visual C++ runtime DLLs next to the engine and the Qt programs, so a PC without the "Visual C++ Redistributable" still starts them
- Electron's own runtime. Nothing else has to be installed. The starter sound packs are generated on the first run (a few seconds).

## Building it

One time per PC: build the audio engine and Component 4 (they are not built by npm).

```powershell
npm install
npm run engine:configure ; npm run engine:build                 # the audio engine (needs CMake + Visual Studio 2022 C++)
cd components\remote-recording                                  # the two Qt programs (needs Qt 6.11.3, RR_QT_DIR set)
cmake --preset msvc-x64 ; cmake --build --preset msvc-x64-release
cd ..\..
npm run dist
```

`npm run dist` first runs `scripts/stage-runtime.mjs`, which checks the three programs exist (and says what to build if one does not) and gathers the
Visual C++ runtime DLLs; then it builds the app and runs electron-builder (`build` section of `apps/desktop/package.json`).

## What to expect on another PC

- The app is **not code-signed** (no certificate), so Windows SmartScreen may say "Windows protected your PC": choose **More info -> Run anyway**.
- Windows Firewall will ask once when a collaboration session is hosted or a recording session starts: allow it on the private network.
- A sound output device is needed for the engine to start; the Singer needs a microphone.
- Not yet tried on a second PC (the tests below were run on the development PC against a copy of the packaged folder).

## Two details worth knowing

- `ws` (the WebSocket library) must stay a normal external dependency. Bundling it into the app made live collaboration hang; the
  config says so in `apps/desktop/electron.vite.config.ts`.
- The installed app finds its engine at `resources/engine/daw_engine.exe` (`resolveEnginePath` in `apps/desktop/src/main/index.ts`) and the
  Qt programs under `resources/remote-recording`; in development it still uses the build folders.

## Tests

`DAW_E2E_EXE` makes the end-to-end tests run a packaged build instead of Electron + the source folder:

```powershell
$env:DAW_E2E_EXE = "<path>\Collab DAW.exe"
node apps/desktop/e2e/run.mjs ; node apps/desktop/e2e/collab.mjs ; node apps/desktop/e2e/collab-online.mjs
node apps/desktop/e2e/recording.mjs ; node apps/desktop/e2e/recording-room.mjs
```

Run on a copy of `win-unpacked` outside the repository: 16, 21, 15, 15 and 12 checks passed, and the app found and started its bundled
Producer Studio and Performer Client.
