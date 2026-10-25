# Third-party plugin tracks

A plugin track plays a VST3 instrument the user has installed (Diva, Nexus, Sylenth1 and so on). The plugin binary and its sound never go into the project file: the project stores only the plugin's path and name (`track.plugin`, set by the `setPlugin` op).

## How it works

- Each plugin runs in its own process, `daw_pluginhost.exe`, started by the engine. If a plugin crashes, only that host dies; the DAW and the other tracks keep playing. The engine restarts a crashed host up to twice.
- The engine and the host talk through shared memory (a ring of audio/MIDI slots, `engine/src/PluginIpc.h`). The audio thread never blocks while playing live (the plugin adds one block of latency); export waits for each block so the file is exact.
- Plugin tracks are mixed like any other track and are included in the WAV export.

## In the UI

- **+ Add track ▸ Plugin** lists the plugins found in the standard folders (`Common Files\VST3`, the per-user VST3 folder, the usual VST2 folders).
- **Browse for a plugin file…** adds one plugin from anywhere on the computer. **Scan another folder…** adds a folder to search. Both are remembered in `plugin-folders.json` in the app's user-data folder.
- The track header shows `PLG`, the plugin's name and a status: *starting*, *ready*, *restarting* (it crashed, the host is being restarted) or *failed* (hover for the reason).
- Adding a plugin track is one undo step (the track and its plugin are added together).

## Formats

- **VST3**: supported.
- **VST2**: the host can load `.dll` VST2 plugins only when it is built with the user's own VST2 SDK (`-DDAW_VST2_SDK_DIR=…`; Steinberg no longer distributes it). Without it, VST2 plugins are listed greyed out with a note. Not tested here.

## Checking it works

- Unit tests: `pluginScan.test.ts`, `pluginCatalog.test.ts`.
- `node apps/desktop/e2e/plugins.mjs`: picks Diva from the menu, waits for *ready*, kills `daw_pluginhost.exe`, checks the window stays responsive and the plugin comes back, then undoes the add. It skips itself if Diva is not installed.
- Engine side: `daw_pluginhost --test <plugin>` plays one note and reports whether audio came out; `daw_pluginhost --caps` prints which formats this build can load.

## Changing a plugin's sound

- **Edit** on a plugin track's header opens the plugin's own window (it belongs to the plugin host program, so it is a separate window from the DAW, kept on top). It is only offered once the plugin is *ready*.
- When the plugin says its settings changed (a knob moved, a preset loaded), the host waits for a short pause (0.4 s, so a knob drag is one save) and writes the plugin's complete settings to a file. The engine reads that file and tells the app, which stores it in the project (`track.plugin.state`, base64, up to 8 MB). The same settings are used by the WAV export and when the project is opened again.
- Saving the plugin's sound is **not an undo step** (undo could not change what the running plugin sounds like): the app applies it with `ProjectService.dispatchSilent`. In a collaboration session it goes through the session like any other op.
- If the plugin crashes, the restarted host is given the newest settings, not the ones the project had when the plugin was added (by design; the crash-and-restart is tested, but not that the restarted plugin's sound matches).
- The signal is the plugin's own change notification, not a comparison of saved states: Diva's saved state differs on every read (measured: a different state every 1.5 s with nothing touched), so comparing would re-save the project forever.
- A plugin that changes its sound without telling the host (rare) is not noticed until it does; changes made with no window open (the plugin's own modulation) are ignored on purpose.

Tools: `daw_pluginhost --params <plugin>` lists a plugin's parameters. The test `plugins.mjs` stands in for a person turning a knob with `DAW_PLUGINHOST_TWEAK=<part of a parameter name>` (the host moves that parameter when the window opens); it then checks the settings reach the project and that the exported audio changes (by far more than the run-to-run difference).

## Not done yet

- A real mouse-and-keyboard test inside the plugin window (the knob turn is simulated; opening the window, the change notification, saving, export and restart are real).
- Which lesson unlocks plugin tracks in beginner mode (currently always available).
- Only the first loaded plugin's reported latency is used; there is no plugin delay compensation across tracks.
- The plugin window is a window of another program: it does not follow the DAW window around. The host exits when the engine is gone, which also removes the window (by design, not separately tested).
