# ADR-006: Live codec behind an interface. PCM16 first, Opus 1.6.1 next.

- **Status:** Proposed. **The PCM16-first order depends on OQ-03 / D-08.** · **Traces:** COM-02, COM-07, BRIEF
- **Stage 7 note:** Opus 1.6.1 implemented first (the brief asked for Opus). PCM16 is **not** implemented and is refused on the wire. The settings were checked against the 1.6.1 headers; the lookahead is read back and shown. See [ADR-017](ADR-017-one-way-live-audio-opus-udp.md).

## Facts checked (official Opus API docs, libopus 1.5 API pages; 1.6.1 is the current release)
**Encoder:**
- Each call encodes "exactly one frame (2.5, 5, 10, 20, 40 or 60 ms)". At 48 kHz that is 120, 240, 480, 960, 1920 or 2880 samples.
- Frames shorter than 10 ms rule out the LPC and hybrid modes.
- Input rates: 8, 12, 16, 24 or 48 kHz.
- Recommended maximum output buffer: 4000 bytes.
- `OPUS_APPLICATION_RESTRICTED_LOWDELAY` disables the speech-optimised mode "in exchange for slightly reduced delay". It can only be set on a new or reset encoder.

**Decoder:**
- Concealment = decode with a NULL pointer and length 0.
- For concealment and FEC, `frame_size` must equal the missing duration and be a multiple of 2.5 ms.
- A packet can last up to 120 ms.

**Build and licence:**
- BSD-3-Clause with royalty-free patent grants (opus-codec.org/license).
- The repo documents a CMake build (`-G "Visual Studio 17 2022" -A x64`) and an `OPUS_BUILD_SHARED_LIBRARY` option.

> The Stage 0 chat-record note "Opus has no 80 ms frame" holds for the
> **encoder's frame** sizes above. The decoder, however, accepts *packets*
> of up to 120 ms. The proposal should say "frame" precisely.

## Decision
- **Interface:** `LiveEncoder` / `LiveDecoder`. The codec is negotiated in HELLO and marked in the media header flags (ADR-008).
- **PCM16** (16-bit little-endian, mono downmix):
  - proven in both prototypes;
  - 10 ms = 960 bytes, which fits one Ethernet frame;
  - frame sizes above 15 ms are refused for PCM16 because they would exceed the MTU.
- **Opus 1.6.1**, statically linked:
  - application `RESTRICTED_LOWDELAY`, frame 10 ms, 64 kbit/s mono. These are **starting points (prov.); quality and delay are not measured**.
  - Read `OPUS_GET_LOOKAHEAD` at runtime and **log** it, rather than assuming a codec delay.
- **Live frame duration:** configurable to 2.5, 5, 10 or 20 ms (with Opus, 40 and 60 are possible too).
  - The 10 ms default is the prototypes' working value, **not a claimed optimum**. Segment size is the research variable for RQ1/H1.

## Risks
- Opus build integration (FetchContent with URL hash, or a vendored tarball) must be tried in I-5.
- Decoding happens in the playback callback (ADR-011). The callback-duration telemetry must show it stays within bounds.
