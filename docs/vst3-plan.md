# VST3 instrument hosting — design and staged plan

Step 5: let a track play a real third-party instrument plugin (Sylenth1, Nexus, Serum…) instead of the built-in synth.
This note is the plan; only stage 1 (discovery) is built so far, because the audio stages need the plugins installed on the
machine and must not risk the working engine build. Each stage below is a separate, reviewable commit.

## Why it is staged, and why it is not finished in one go

* **It cannot be verified without the plugins.** Sylenth1 and Nexus are paid; CI and this environment do not have them, so the
  audio path can only be checked by hand on a machine where they are installed. Shipping untested audio code would break the
  honesty rule the project holds (claims must be measured).
* **It must not break the engine.** The engine currently links JUCE **without** `juce_audio_processors`. Adding the VST3 host is a
  real build change (new JUCE module, the bundled VST3 SDK, `JUCE_PLUGINHOST_VST3=1`). It goes behind a CMake option that is **off by
  default**, so the normal build, the self-test, the benchmark and the app are unaffected until someone deliberately turns it on.
* **A plugin can crash or hang.** A bad plugin must not take the audio engine down. The design hosts plugins so a failure degrades to
  silence on that track, not a dead app.

## Architecture

```
Renderer  ──pick folder / choose plugin──▶  Main process            Engine (JUCE)
  track.instrument = "plugin"               scanPlugins()  ✅ built    loadPlugin(slot, path)
  track.plugin = { id, name, state? }       ──loadProject──▶          AudioPluginInstance per slot
                                            plugin:scan IPC            processBlock -> the slot's bus
```

* **Model:** a new instrument kind `"plugin"` with `track.plugin = { id (the .vst3 path), name, state? (base64 of the plugin's own
  saved settings) }`. The audio is never in the project; only the path and the plugin's state blob, exactly like sample ids.
* **Engine:** one `juce::AudioPluginInstance` per slot. The sequencer already emits note on/off per slot; for a plugin slot those
  become a `juce::MidiBuffer` and the plugin renders into the slot's stereo bus, then the existing gain/pan/automation apply as now.
* **Offline export** uses the same per-slot render, so a rendered WAV includes the plugins (at a fixed block size).

## Stages

1. **Discovery (built).** `apps/desktop/src/main/plugins/pluginScan.ts` finds `.vst3` files and bundles under the standard Windows
   folders (and the user can add a folder). Pure filesystem, unit-tested. No audio.
2. **Model + protocol.** Add the `"plugin"` instrument and `track.plugin` to `@daw/shared` (with `migrateProject` leaving old projects
   unchanged), an `addPluginTrack`/`setPlugin` op, and engine-protocol messages (`scanPlugins`, `loadPlugin`, `pluginState`,
   `showPluginEditor`). Snapshot maps `track.plugin` to the slot. All TypeScript, fully testable without a plugin.
3. **Engine host (needs the plugins).** Behind `-DDAW_ENABLE_VST3=ON`: add `juce_audio_processors`, scan/instantiate a plugin by path,
   drive it with a `MidiBuffer`, render into the slot bus. Fall back to silence (and report a problem) when a plugin is missing or fails
   to load, so a project opened without its plugins still plays everything else. Verified by hand with Sylenth1/Nexus.
4. **Plugin editor window.** Show the plugin's own UI (`createEditorIfNeeded`) in a child window for sound design; save its state on
   close. Persist `track.plugin.state` and restore it on load.
5. **UI.** "+ Add track ▸ Plugin" lists the scanned plugins; a track header shows the plugin name and an "Edit" button; a lock gates it
   behind a lesson (a later module) in beginner mode, like the other advanced features.
6. **Robustness.** Instantiate plugins on a worker thread (never the audio thread), guard the audio thread against a plugin that throws
   or blocks, and consider out-of-process hosting if a common plugin proves unstable (the protocol already allows it — the engine would
   talk to a small host process instead of loading in-process).

## What exists now

* Stage 1: `pluginScan.ts` + `pluginScan.test.ts` (4 tests). Nothing else is wired, so the DAW behaves exactly as before.

## Open questions for when the plugins are on the machine

* Scan cost: a first scan of many plugins is slow; cache the results (name, path, mtime) and rescan in the background.
* Latency reporting (`getLatencySamples`) so plugin latency can be compensated in render.
* Whether any target plugin needs out-of-process hosting (stage 6) for stability.
