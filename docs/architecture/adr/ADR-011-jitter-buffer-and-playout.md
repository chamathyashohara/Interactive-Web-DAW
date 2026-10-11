# ADR-011: A fixed-depth jitter buffer owned by the playback callback, with decode in the callback

- **Status:** Proposed · **Traces:** COM-02, ERR-04, TEL-01. RQ2/H2 (adaptive depth) is LATER.
- **Stage 7 note:** implemented as decided, with decode in the playback callback, the target at 1-16 frames (default 3), stall limit 20, drift skip and a 64-packet queue. The MON ring and conceal-event ring are not built. Measured: see [ADR-017](ADR-017-one-way-live-audio-opus-udp.md).

## Decision
- **Ownership:** the media-receive thread checks packets and pushes them into a **bounded SPSC packet queue** (64 slots, prov.). The **playback callback owns the jitter buffer outright**, so no jitter-buffer state is shared between threads. This is the Rust prototype's pattern; the C++ prototype shared atomic slots instead.
- **Policy:** fixed target depth D frames (default 3 × 10 ms, configurable 1–16). Fill to D, then play (PROTOCOL_OVERVIEW §3.3).
  - **Lost:** missing, but later frames are present. Concealed and counted.
  - **Underrun:** missing, with nothing later present. Concealed and counted.
  - **Rebuffer:** after 20 (prov.) consecutive misses, the peer has stopped, so return to filling. Not counted as loss.
  - **Late:** a packet arriving after its turn. Dropped and counted. Duplicates are dropped and counted too.
  - **Drift skip:** if the buffer stays more than D+2 frames full for more than 1 s, skip one frame and count it. This absorbs the clock difference between the sender's capture device and the receiver's playback device.
- **Concealment:** Opus PLC (decode NULL), or for PCM16 a repeat of the last frame at 0.5^k gain (the prototypes' heuristic). It affects **only** playback and the monitor file.
- **Decoding inside the callback:**
  - The decoder and buffers are preallocated.
  - Work per callback is bounded at ⌈callback frames / frame⌉ + 1 decodes.
  - The worst callback duration is measured and shown (T-16).
  - **Fallback** if it proves too expensive: a decode thread filling a short PCM ring ahead of playback, at the cost of one frame of extra delay.
