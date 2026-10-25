# Mixer assistant ("Mix check")

The mixer's counterpart to the piano roll's out-of-key help: it measures the real audio, flags likely mixing problems, explains them in plain language, and offers a one-click fader change that can be previewed and taken back. It is plain arithmetic on measured levels; there is no machine learning.

## What it measures, and how

All numbers come from the audio engine's mixing loop (`engine/src/AudioEngine.h`), once per audio block, with no allocation and no locking. They are copied into the 33 ms status message the UI already receives, and read outside the audio thread.

| Measurement | Where it is taken | Notes |
|---|---|---|
| Channel peak | what the channel puts on the master bus: after its fader and pan, before the master | highest sample, in dBFS |
| Channel RMS | the same signal, over the time the channel was audible | silent stretches (muted, faded out, between notes; below -80 dBFS) are not counted, so a part that plays rarely is not averaged away |
| Master peak | **before the soft clip** | the soft clip keeps the output under 1.0, so the output meter alone can never show clipping |
| Master clipping | samples at or over full scale before the clip; samples above the soft-clip knee (-1.9 dBFS) | counted, reported as milliseconds |
| True peak (estimated) | only in "Analyse song": 4x oversampling (12-tap windowed sinc) of the pre-clip master | an estimate, not a certified ITU-R BS.1770 meter; the live meters are **sample peaks** and are labelled so |

Playback measurements restart when playback starts. A channel's numbers (and the master's, which is their sum) also restart when something that changes what it puts out changes: a fader, pan, mute or solo. The panel then says "the mix changed: measure again" instead of showing an old number as if it were current.

**Analyse song** renders the whole song (plus a 1 s tail) offline, faster than real time and beside live playback, with the same meters and the same mixing code as an export. Because it does not depend on playing the song through, it gives the same numbers every time and covers the whole song. If a fader moves while it renders, the result is discarded.

## What it flags

Three kinds of finding are kept apart on purpose:

- **Problem**: a measured technical fact. A channel reaching full scale on its own; the master clipping or the soft clip shaping the sound above the warning level.
- **Over target**: a level above a reference the user set. The text says plainly that this is the user's reference, not a rule.
- **Note**: something worth a listen that numbers cannot decide (a very quiet channel).

Reference levels (`project.mixReference`, saved with the project and shared in a session; `setMixReference` op, undoable): master peak target (default -6 dBFS), channel peak target (default -8 dBFS), a master warning level (default -1.9 dBFS, about where this DAW's soft clip starts), and optional per-channel targets. The defaults are starting points. Nothing says a mix has to meet them.

A master reading is never "fixed" automatically. The master finding names the loudest channels (those within 6 dB of the loudest) and explains the options.

## How a correction is calculated

The fader has whole-number steps 0-100 and gain `(v / 100)^2`, so a fader value `v` is `40 * log10(v / 100)` dB.

1. Wanted change = target - measured peak (both dBFS), limited to 12 dB per suggestion.
2. New fader = `round(v * 10^(change / 40))`, at least one step in the wanted direction, never above 100 (0 dB) or below 1.
3. The change that step actually makes is recomputed and shown, so the text never promises more than the fader can do (about 0.1 dB at normal fader positions, coarser near the bottom of the fader, where one step is a bigger fraction of the value).

Example: a channel peaks at -4 dBFS against a -8 dBFS target: about -4 dB is proposed, and the explanation says it should land near -8 dBFS.

Master suggestions:

- **Lower the master by X dB**: exact. The master is a plain gain after the sum, so its pre-clip peak falls by exactly the change (checked in the tests). It keeps the balance but does not say which channel is too hot.
- **Lower the N loudest channels by about X dB each** (2 to 4 contributors): only those faders change. The effect on the master is *roughly* X, because their peaks may not coincide; the text says so, and tells the user to play again and recheck.

Each explanation has: what was measured, which channel, what would change, why it may help, what to listen for, and what it does not solve. Pan, mute/solo, effects, automation and every other fader are never touched.

## Preview, apply, undo

- **Preview** plays a changed copy of the mix on this computer only. The project, its undo history and any collaborators never see it. The meters then describe the previewed mix, so the result can be judged before choosing. **Keep this** applies the same change for real (one undo step); **Stop preview** returns to the real mix. Any real change to the project, and any export, ends a preview (an export is always the real project).
- **Apply** is one batch of ops: **Ctrl+Z undoes it in one step**, like any other edit, and in a session it goes through the normal shared edit path.
- **Restore** puts the touched faders back to exactly the values they had. If a fader was moved since, the button says so; if the faders are already back (for example after Ctrl+Z) the entry disappears.
- Nothing is applied silently.

## Collaboration

Targets and fixes are ordinary ops (`setMixReference`, `updateTrack`, `setMasterVolume`), so they are sequenced by the session server like every other edit. Each person's own engine measures the shared project; the tests check that two machines measure the same master peak (within 0.5 dB) and converge on the same faders and targets after editing at the same moment. Measurement and preview are local to each computer.

## Files

- Engine: `engine/src/AudioEngine.h` (meters), `Export.cpp` / `Export.h` (`TruePeakMeter`, `analyzeMixOffline`), `Main.cpp` (status fields, `analyzeMix` command), `SelfTest.cpp` (block 11).
- Shared: `packages/shared/src/mixAssist.ts` (maths, analyzer, findings, wording), `model.ts` / `ops.ts` / `apply.ts` (`mixReference`, `setMixReference`), `packages/collab/src/shared/{seed,describe}.ts`.
- App: `apps/desktop/src/main/index.ts` (analyzer feed, whole-song analysis, preview), `preload/index.ts`, `renderer/src/components/MixAssist.tsx`, `Mixer.tsx`, `store.ts`.
- Tests: `packages/shared/test/mixAssist.test.ts` (27), engine `--selftest`, `apps/desktop/e2e/mixassist.mjs` (63 checks on real audio, two app instances for the collaboration case).

## Limits

- Peaks are **sample peaks** while playing; the true peak is only estimated by Analyse song, and only for the master.
- Levels describe what the engine rendered. A plugin track's level includes the plugin's own output; an offline analysis restarts plugin hosts like an export does.
- A suggestion cannot know your intent: a quiet pad, a loud drum bus and a target that suits a ballad but not a dance track all look the same to a meter. The wording avoids "correct" and "professional".
- The master suggestion that lowers channels is an estimate, not a guarantee.
- Peak and RMS do not measure loudness (LUFS) or balance between frequency ranges; they say nothing about EQ clashes.
- Analysis covers faders only (gain). It does not suggest EQ, compression or panning changes.

## Demonstrating it in the research evaluation

1. Open a project with a drum, a bass and a lead track and put the Mixer on screen. Show the panel's "play the song, or analyse it" state: no numbers appear before something is measured.
2. Press play for a few seconds. Show a channel's strip, the master readout (**sample peak**, headroom, your target) and the sentence under it.
3. Open **Targets** and set a channel target a few dB below that channel's measured peak. A marker appears on the strip; click it and read the explanation aloud (what was measured, what changes, why, what to listen for).
4. Press **Preview**, play, and compare; show that the Fader value in the project did not change. Then **Keep this**, show the Restore entry, press **Restore**, and press Ctrl+Z after applying again.
5. Raise three faders and the master to 100 to make the master clip. Show the clipping warning, that the master fader was not touched, the list of contributing channels, and the two options (lower the loudest channels, or the master). Apply one, press **Analyse song** and read the measured result.
6. For the data: `node apps/desktop/e2e/mixassist.mjs` prints each check with the measured numbers (for example the fader change and the WAV peak change agreeing to within 0.15 dB), which can go straight into the write-up.
