# ADR-003: Audio I/O with miniaudio, separate capture and playback devices, explicit IDs, native rate

- **Status:** Proposed · **Traces:** DEV-01…05, REC-01/06/07, ERR-06, D-05

## Context (documentation checked on 11 Oct 2026)
These facts come from the miniaudio online manual and from the v0.11.22
header vendored in the C++ prototype:
- Sample rate: "Set to 0 to use the device's native sample rate". Native settings avoid "the overhead of miniaudio's automatic data conversion".
- Ring buffers are "lock free (single producer, single consumer)".
- Never call `ma_device_start/stop/init/uninit` from inside the callback, or it will deadlock.
- Notification types: `started`, `stopped`, `rerouted`, `interruption_began/ended`.
  - "The stopped notification will *not* get fired when a device is rerouted."
  - "some backends will perform automatic stream routing without any kind of notification".
  - "Some backends do not have a good way to detect device stoppages due to unplugging".
- WASAPI options: `noAutoConvertSRC` ("disables the use of AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM"), `noDefaultQualitySRC`, `noAutoStreamRouting`, `noHardwareOffloading`.

## Decision
- Pin **miniaudio 0.11.25**, vendored as a single header plus one implementation `.c` file, with its SHA-256 recorded. Re-check the facts above against the 0.11.25 header when vendoring.
- Open **two separate `ma_device`s**: one capture and one playback, each with its own callback. Not one duplex device.
- Always open the device the user selected **by explicit device ID**, never "default". Set `wasapi.noAutoStreamRouting = true`.
  - Then an unplug ends the stream, which is detected, instead of silently moving the master to another microphone.
- Capture opens with `sampleRate = 0` (native) and `wasapi.noAutoConvertSRC = true`. Readiness requires the native rate to be **48 000 Hz** (DEV-05, OQ-11).
- Shared mode, `performanceProfile = low_latency`, period of 10 ms requested (prov., configurable).
  - The resulting internal period and period count are logged as **"reported device buffering"**, not as latency.
- **Device-loss detection uses two independent signals:**
  1. the `stopped` notification;
  2. a **watchdog** (telemetry thread) that reports a stall when a started device's frame counter has not advanced for 500 ms (prov.).

  The watchdog covers the cases where notifications are not guaranteed.

## Consequences and risks
- A playback fault, such as headphones unplugged, cannot stop capture. The master path does not depend on playback.
- Separate devices run on independent clocks. That is acceptable: the network already separates the clock domains, and the jitter buffer's drift rule (ADR-011) absorbs it.
- **Not verified:** the thread priority (MMCSS class) of miniaudio's WASAPI threads. Check it in I-1.
- **Open:** native channel count on laptop mic arrays. See the proposed REC-02 amendment in ADR-007.

## Alternatives
- **Duplex device** (C++ prototype): couples capture to playback.
- **Qt Multimedia:** less buffer and period control, and a larger LGPL surface.
- **PortAudio / RtAudio:** possible, but no advantage over the miniaudio already used in the prototype.
