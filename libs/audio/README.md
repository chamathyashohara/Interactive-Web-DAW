# libs/audio: module boundary (no code yet)

This folder is deliberately empty at Stage 3 and has **no CMake target**. The
stage brief says not to start later features just because the folder exists.

**Will contain (increment I-1/I-2, ADR-003, ADR-007):**
- device enumeration and opening via miniaudio 0.11.25 (vendored then, with its SHA-256);
- separate capture and playback devices by explicit ID, plus the device watchdog;
- SPSC rings, the capture and playback callbacks, the recorder thread and the safe WAV writer.

**Rules:** Qt-free (ADR-001). Callbacks follow THREADING_AND_AUDIO_CALLBACKS §3–§5.
