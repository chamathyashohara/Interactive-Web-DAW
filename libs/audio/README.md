# libs/audio (`rr_audio`, Qt-free)

Stage 4: real capture and local recording (ADR-003, ADR-007). It must never include Qt
headers; the `core_has_no_qt_includes` test checks this.

| File | Role | Runs on |
|---|---|---|
| `audio_engine.*` | miniaudio context, device enumeration, capture device by explicit ID, notifications | control thread + miniaudio threads |
| `capture_ingest.*` | the callback-side copy into a preallocated ring, meters, counters, gap events | **real-time callback** |
| `SpscRing.h` | lock-free bounded single-producer/single-consumer ring | callback / recorder |
| `take_recorder.*` | recorder worker: drains the ring, writes takes, fills gaps, watchdog, finalisation | recorder thread |
| `wav_format.*`, `wav_writer.*` | float32 WAV header, `.partial` lifecycle, header refresh, no-overwrite rename | recorder thread |
| `wav_inspect.*` | structure check, crash recovery to `.recovered.wav`, `.partial` scan | any non-real-time thread |
| `take_naming.*`, `take_metadata.*` | session/take names, JSON metadata | any non-real-time thread |
| `file_io.*` | exclusive create, flush-to-disk, rename-without-replace, free space | non-real-time threads |
| `src/MiniaudioImpl.c` | compiles the vendored `third_party/miniaudio/miniaudio.h` (0.11.25, unmodified) | — |

Real-time rule (THREADING_AND_AUDIO_CALLBACKS §5): only `CaptureIngest::on_block` runs on the
audio thread. It never allocates, locks, waits, logs or does I/O.
