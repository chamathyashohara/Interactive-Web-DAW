# Sound clip editing and automation

Both are unlocked by lesson **M13.3 "Buildup tension tools"** in beginner mode (features `clips.audio` and `automation.lanes`).

## Trim, fades and gain (clips on sample tracks)

Select a sound clip in the arrangement. The strip above it shows **Gain** (dB, -60 to +12) and **Fade in / out** (beats). On the clip:

* **Trim the start:** drag the clip's left edge. The sound stays lined up with the song: the part before the edge is hidden, and
  dragging back left reveals it again (never earlier than the sound's beginning). Stored as `clip.audio.startSec` (seconds into the
  sound itself, so it survives tempo changes and Fit).
* **Trim the end:** drag the right edge (as before). A shortened sound clip now **cuts its sound** at the clip end (`audio.cut`),
  and its note keeps the length of the clip, so lengthening it again brings the sound back.
* **Fades:** drag the small handles in the top corners (they snap to the grid), or type beats. A fade out always cuts the sound at the clip end.
* **Gain:** type dB. The waveform in the clip is drawn at that level.
* **Split / duplicate** keep everything consistent: the right half of a split continues the sound where the left stopped (its start
  point advances), the left half keeps the fade in, the right half the fade out; a duplicate keeps all settings.
* Everything is one undo step per edit; edits in a row on the same clip merge.

Data: `Clip.audio?: { gainDb?, fadeInTicks?, fadeOutTicks?, startSec?, cut? }` (only on sample tracks, validated in `applyOp`;
settings that say nothing are dropped). Engine: per note `gain`, `offsetSec` (already divided by the tempo-fit stretch), `fadeInSec`,
`fadeOutSec`, `cut`. Fades are linear over the clip, applied per voice on the audio thread.

## Automation lanes (any track)

Press the **∿** button on a track to open a lane under it. Choose **Volume** or **Filter (low-pass)**.

* **Click** empty space to add a point, **drag** a point to move it, **double-click** (or right-click) a point to remove it.
  Points snap to the toolbar grid while Snap is on. Up to 64 points per curve. **Clear** removes the curve.
* **Volume:** top = the track's fader level, bottom = silence. The curve acts like the fader, so the gain follows the value squared
  (halfway up is a quarter of the level, 25%).
* **Filter:** a 12 dB/octave low-pass; value 0 to 1 is 20 Hz to 20 kHz on a log scale, top = open (no filter).
* Before the first point and after the last, the curve holds that point's value; between points it is a straight line.
* Each curve is one `setAutomation` op (the whole list of points), so a drag is one undo step. `Track.automation?: { volume?, filter? }`.
* Engine: evaluated per audio segment at the segment's middle, ramped by the existing 10 ms gain smoothing; the filter state is reset
  when the curve is open or the track is idle. Live playback and WAV export use the same code, and a swell never blips at the first note.

## Tests

* Engine self-test sections 7 and 8: gain, start point, fade in, fade out, cut; curve maths, volume swell (value squared), ramp down,
  low cutoff removes an 8 kHz tone, low notes pass, filter sweep, export follows the curve.
* `packages/shared/test/clipAudio.test.ts`, `automation.test.ts`; `snapshot.audio.test.ts`, `snapshot.automation.test.ts`.
* `apps/desktop/e2e/samples.mjs` checks A1-A19 and AU1-AU15 drive the real window with the mouse and judge the **rendered WAV**
  (a trimmed bar 2 matches the original to a correlation of 1.000, -6 dB gives exactly half the level, fades ramp as drawn, a
  closed filter removes more than 90% of the highs, a sweep opens over a bar, no audio overruns while playing with curves).

## Not done

Automation of other parameters (pan, synth settings, tempo), curve shapes other than straight lines, fades with other curves,
recording automation from the controls, and per-clip automation (curves belong to the track).
