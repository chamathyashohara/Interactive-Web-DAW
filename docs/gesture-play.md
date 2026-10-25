# Hand play: scale-locked gesture playing with fading help

Play notes with your hand in front of the webcam. The project's key helps you stay in the scale, and that help is reduced by itself as you improve. It is a feature of the DAW's piano roll (the **Hand** button), not a plugin: it needs the project's key, the transport position, the clip and the study data, which only the app has.

## What the user does

1. Open the piano roll of a synth or plugin track, click **Hand**, then **Start camera**.
2. Hold a hand up. Its height picks the pitch (two octaves, C4–C6 by default; the arrows move the range by an octave). The panel shows the camera picture with the hand skeleton, and a ruler with the scale's notes in green.
3. **Pinch** (thumb and index together) to play the note at the height of the palm; open the hand to stop it. The sound is the track's own instrument.
4. Turn **Record** on and the notes are also placed into the clip while the song plays, on the grid (the piano roll's grid size).

The camera picture is processed in the app's window and is never saved or sent anywhere. The camera is released when you press Stop or close the panel.

## The help, and how it fades

| Level | What happens |
|---|---|
| Full help | Only scale notes can be played: the hand snaps to the nearest one |
| Soft help | Scale notes pull the hand in (within 0.35 of a semitone); a note between two scale notes can still be reached |
| Guide only | Nothing is changed; the ruler marks out-of-scale notes in red |
| No help | Nothing is changed, nothing is shown |

**Automatic** mode starts at full help and moves one level down when the learner's last 12 notes were on a scale note at least 85% of the time **without any help**, and one level back up when 50% or fewer were. After each change it waits for 12 new notes. A **fixed** level never changes (for a study condition). Without a project key there is nothing to follow, so no help is given and nothing is measured.

The learner is judged by where their hand *was* (the note it would have played with no help), not by the note that was played. Otherwise full help, which makes every played note correct, would hide how they are really doing. The panel states this ("without any help, your hand was on a scale note 9 of the last 12 times").

## What is recorded for the study

Everything goes through the existing evaluation recording (nothing is written until the participant has consented). Events are named `ui.gesture.*`:

- `ui.gesture.note`, one per note: `level`, `raw` (the note under the hand), `played`, `rawInKey`, `playedInKey`, `snapped`, `heldMs`, `recorded`, `glide`, `bendMax`, `inferMs` (the tracking time per frame at that moment).
- `ui.gesture.level`: each automatic change: `from`, `to`, `rate`, `notes`.
- `ui.gesture.mode`: automatic or the fixed level chosen (`assist`). The field is not called `mode` because the recorder already uses that name for something else.
- `ui.gesture.session`: start and stop, with `assist` and note counts.

From these: the in-key rate of the hand over time (the learning curve), how many notes until the help is no longer needed, mistakes after help is removed, and which conditions were used. A study could compare automatic fading, fixed full help and the mouse piano roll on the same melody task, with a short usability and confidence questionnaire. The fading rule's numbers (window 12, fade at 85%, restore at 50%) are design choices to tune in a pilot, not tested values.

## Gliding between notes (pitch bend)

The **Glide** button (next to Record) makes a held note follow your hand smoothly instead of staying on the pitch where you pinched. Move your hand while pinching and the sound slides with it.

- **What you hear**: the built-in synth bends the held note live (the engine follows each new bend value within about 6 ms; the delay from your hand to that value, which includes the camera and tracking, is not measured).
- **What is recorded**: with Record on, the glide is stored with the note as a short pitch curve (`note.bend`: up to 48 points of "ticks after the note starts" and "semitones above the note's pitch"; at most two octaves either way). Playback and the WAV export follow the curve, and the piano roll draws it as a white line over the note at the pitches the note passes through.
- **Scale help shapes the glide**: with full help the pitch rests on scale notes and slides quickly between them (it never settles on notes outside the scale); soft help holds the notes only slightly; guide and no help follow the hand exactly. With no key set the glide follows the hand exactly.
- **Measured from the start note**: the bend is relative to where the note began, so moving the recorded note, transposing it or quantizing it keeps the glide. Paste and duplicate copy it; chopping or slicing a note gives each piece its own part of the curve.
- **Limits**: the built-in synth only. A plugin's pitch-bend range is its own, so Glide is switched off (with the reason) on plugin tracks; drums and samples have no Hand button. The curve cannot be edited by hand in the piano roll yet (delete the note and play it again, or turn Glide off for a plain note). It is not in the MIDI import.
- **Study data**: each `ui.gesture.note` event also has `glide` and `bendMax` (the largest bend in semitones); `ui.gesture.glide` records the button.

How it was checked: the engine self-test measures the real frequency of a sine note against its curve (an octave glide matches within 2%), that a plain note stays put, that a live bend does not move notes from the song, and that a new note starts at its own pitch. `gesture-bend.mjs` records a hand rising from C4 to G4 and measures the exported audio: the rise in the WAV was 6.86 semitones against 6.87 in the recorded curve.

**Engine rebuild**: bending needs the engine built from this source (`daw_engine.exe` and the project's note format changed). An older engine still plays the notes, just without the glide. While the app is running it keeps `engine/build/.../daw_engine.exe` locked, so rebuild after closing it (`cmake --build engine/build --config Release`); `engine/build-gesture` was used here to build and test without closing it.

## How it works

- **Tracking**: Google's MediaPipe hand landmarker (Apache-2.0), run in the window. Its WebAssembly files and model (about 8 MB, from Google's public model storage) are fetched once by `npm run gesture:assets` into `apps/desktop/resources/mediapipe` (not committed; the model's SHA-256 is pinned in the script) and served to the window through a small `dawasset://` protocol that serves only those files. At run time nothing is fetched from the internet. The page's content-security-policy now allows `'wasm-unsafe-eval'` (WebAssembly only, not `eval`) and the `dawasset:` scheme.
- **Logic** (`packages/shared/src/gesture.ts`, pure and unit-tested): hand height to pitch, the four levels, pinch detection, the note state machine, the fading rule, placing notes on the grid, wrapping the playhead estimate at the loop.
- **Pitch**: from the middle of the palm, which hardly moves when the fingers pinch, smoothed with a 70 ms time constant. The note is taken from a few frames before the pinch for the same reason.
- **UI**: `renderer/src/gesture/GesturePanel.tsx`. Notes play through the engine's existing preview and are recorded with the ordinary `addNote` op (so undo, saving and sessions work as for any note; each note is one undo step).

## Measured on the development laptop

Real camera path (Chromium's fake camera playing a video of a hand, `e2e/gesture-camera.mjs`), repeated several times, while the DAW and three plugin hosts were also running:

- Over 10 runs of the same 16 s clip the model processed 182–186 frames and found a hand in 116–118 of them (about 64%; the clip has moments where the hand is turned or partly out of view). A pinch was read in every run.
- Tracking took about **30 ms a frame while following a hand**, about **60 ms a frame while looking for one**, 41–46 ms overall. That keeps up with roughly 20–30 frames a second while a hand is being followed, but not with a full 30 fps when it has to be found.
- The camera size made no real difference (320×240 against 640×480).
- While the camera is on, the app tells Chromium not to throttle the window (`app:keepRunning`). Without this, tracking stalled in about a third of runs whenever another window covered the app: Chromium pauses the animation frames the tracking loop runs on.
- The graphics-card path (integrated Intel UHD) was about four times slower (about 195 ms a frame, with stalls of seconds), so the processor is used.

**Not measured**: the delay from moving the hand to hearing the note. That includes the camera's own delay, the tracking, the 70 ms smoothing and the engine, and needs an external rig (a camera filming the hand and the sound) to measure honestly.

## Tests

- `packages/shared/test/gesture.test.ts` (26): height to pitch, every level (including a minor key and no key), pinching, the note machine, jitter, hand loss, the fading rule (including that full help cannot make a struggling learner look good), grid placement, playhead wrapping.
- `apps/desktop/e2e/gesture.mjs` (25): the panel and the whole flow with a test feed of hand landmarks in place of the camera: full, soft, guide and automatic levels, recording into the clip, losing the hand, no key, recording off, range, closing, and that every gesture event reaches the study export.
- `apps/desktop/e2e/gesture-camera.mjs <video.y4m|mjpeg>`: the real camera, permission, model and tracking, with a recorded video of a hand. Skips if no video is given; no hand video is in the repository. Make one with `ffmpeg -i clip.mp4 -t 16 -vf fps=15 -pix_fmt yuv420p hand.y4m` (keep the hand inside a 4:3 frame: Chromium crops a portrait video).

## Limits and open decisions

- A hand in the air is poor at precise timing and pitch; notes are quantized to the grid, and the scale lock is there because of it. Arms tire: sessions should be short.
- Only the first hand is used; only one note at a time; velocity is fixed; no vibrato or other expression yet.
- One camera, front-facing; lighting and background affect tracking. Not tested with different people, skin tones, lighting or cameras: a real study must check that, because hand-tracking models can perform differently across them.
- The Hand button is on melodic (synth and plugin) tracks; drums and sample tracks have none. It is not locked behind a lesson yet: which lesson unlocks it is still to be decided.
- After `npm install` on a fresh checkout, run `npm run gesture:assets` once. The `npm run dist` script runs it first (written, but the installer build has not been tried).
