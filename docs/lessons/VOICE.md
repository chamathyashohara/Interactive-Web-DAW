# Voice guidance: natural-voice recordings

Voice guidance used to read lessons with the Windows speech voices (David, Mark, Zira), which sound robotic. Windows'
natural voices (Aria, Jenny, ...) are only offered to Narrator and Edge, not to apps. So every line voice guidance can
read is now **recorded ahead of time** with a natural neural voice and shipped with the app.

- **Voice:** Piper (https://github.com/rhasspy/piper, MIT) with the `en_US-ljspeech-high` model. The LJ Speech dataset
  is public domain, so the recordings can ship with the app.
- **Files:** `apps/desktop/src/renderer/src/features/lessons/voice/<key>.ogg`, Ogg Opus at 24 kbps (766 lines, about
  100 minutes, 18 MB). `<key>` is `voiceKey(text)` (`voiceKey.ts`): a hash of the line, so a changed line gets a new
  file.
- **Playback:** `speech.ts` plays the line's recording. A line without one (or one that cannot play) is read by the
  system voice, so nothing breaks while recordings are missing. Offline: nothing is sent anywhere.
- **Which lines:** `voiceLines()` in `voiceLines.ts` lists everything the lessons can say (the four first lessons,
  the Piano sub-lessons, the workspace lessons). The test `voiceLines.test.ts` fails when a line has no recording or a
  recording is no longer used.

## Re-recording after lesson text changes

Needs Piper for Windows (`piper_windows_amd64.zip` from the Piper releases) and the voice files
`en_US-ljspeech-high.onnx` + `.onnx.json` (https://huggingface.co/rhasspy/piper-voices, `en/en_US/ljspeech/high`),
kept outside the repo. From the repo root:

```bash
cd apps/desktop
VOICE_LINES_OUT=/tmp/voice-lines.json npx vitest run voiceLines
cd ../..
node docs/lessons/voice-tools/prep.mjs /tmp/voice-lines.json /tmp/voice-wav /tmp/voice-input.jsonl --missing apps/desktop/src/renderer/src/features/lessons/voice
node docs/lessons/voice-tools/record.mjs <path>/piper.exe <path>/en_US-ljspeech-high.onnx /tmp/voice-input.jsonl
npm run build -w apps/desktop
node docs/lessons/voice-tools/encode.mjs /tmp/voice-wav
```

Then delete the recordings the test reports as no longer used, and run the tests again. `prep.mjs` spells out what
the voice would misread (I – V – vi – IV as "one, five, six, four", F# as "F sharp", 1-16 as "1 to 16", dB, BPM...); the
text on screen does not change.
