# Buffer-size test results (engine soak)

Date: 2026-10-17. Hardware: 11th Gen Intel Core i5-11400H, Focusrite USB output, Windows 11.
Method: `node apps/desktop/e2e/soak.mjs 2 <buffer>` — 2 minutes per run, 256-note looping pattern,
10 project reloads per second (simulated edits), engine playing through the default output device.

| Requested buffer | Buffer actually used | Sample rate | Device mode | Callbacks | Overruns | Peak load | Xruns |
|---|---|---|---|---|---|---|---|
| 128 | **480** | 48000 | Windows Audio (WASAPI shared) | 11,826 | 0 | 2.4% | 0 |
| 256 | **480** | 48000 | Windows Audio (WASAPI shared) | 11,849 | 0 | 2.8% | 0 |
| 512 | **480** | 48000 | Windows Audio (WASAPI shared) | 11,853 | 0 | 2.4% | 0 |
| 1024 | **480** | 48000 | Windows Audio (WASAPI shared) | 11,852 | 0 | 2.4% | 0 |

## What this does and does not show

* **The requested buffer sizes were not applied.** In WASAPI shared mode Windows fixes the buffer
  (480 samples = 10 ms at 48 kHz here), so all four runs exercised the same configuration.
  This is **not** a 128-1024 matrix; it is four repeats of buffer 480.
* At buffer 480 the engine used at most 2.4-2.8% of the available time per callback in these runs,
  with no overruns or xruns over about 47,000 callbacks.
* An earlier 10-minute run at the same buffer showed one peak of 45.6% (still no overrun), so
  single-callback peaks vary; report peak load together with overrun counts.

## Still to do to get a real matrix

1. Offline CPU-headroom test: run the same engine core at block sizes 64-1024 without a device and
   record time per block (tests our code's cost, not the driver).
2. Real-device test at smaller buffers needs a mode that honours buffer requests (ASIO, or WASAPI
   exclusive/low-latency). ASIO needs the Steinberg ASIO SDK licence; exclusive mode is possible without it.
3. Loopback recording to measure true round-trip latency.

## Addendum: offline CPU-cost benchmark (M2 engine, no audio device)

`daw_engine.exe --benchmark` renders 20 s of audio through the real mixer path at each block size and times every block.
Project: 8 tracks (6 synths, 2 drum kits), 16th-note density, 140 BPM, 48 kHz. Same CPU as above.
This measures the cost of *our code only*; it says nothing about driver behaviour or latency.

| Block size | Budget per block | Average load | p99 load | Max load | Blocks over budget |
|---|---|---|---|---|---|
| 64 | 1.333 ms | 1.98% | 2.39% | 4.30% | 0 / 15,000 |
| 128 | 2.667 ms | 1.94% | 2.27% | 4.07% | 0 / 7,500 |
| 256 | 5.333 ms | 1.90% | 2.17% | 2.38% | 0 / 3,750 |
| 512 | 10.667 ms | 1.86% | 2.14% | 2.67% | 0 / 1,875 |
| 1024 | 21.333 ms | 1.85% | 2.09% | 2.14% | 0 / 937 |

Reading: the engine has large headroom at every block size, including 64 samples. A dropout at small buffers on real
hardware would therefore come from the driver/OS scheduling (not our DSP cost). Single-block maxima (about 2x the
average at the smallest sizes) are consistent with OS scheduling noise. Real-device small-buffer behaviour (WASAPI
exclusive / ASIO) is still untested.
