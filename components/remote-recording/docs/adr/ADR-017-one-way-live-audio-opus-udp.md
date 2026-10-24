# ADR-017: One-way live audio (producer → performer) over UDP with Opus 1.6.1, as built in Stage 7

- **Status:** Implemented in Stage 7 (11 Oct 2026). Awaiting the researcher's review.
  - Implements ADR-006 (Opus only, no PCM16 yet), ADR-008 (header v1, with the changes below) and ADR-011 (jitter buffer in the playback callback).
  - Records where the built system differs from those drafts.
- **Control protocol:** unchanged (PROTOCOL_OVERVIEW §11 stays authoritative). Live media needs no new control message; how it is derived from the existing session is in "Decision" below.
- **Traces:** COM-02, COM-03, COM-07, ERR-04, ERR-07, TEL-01, SEC-01…03, D-48…D-56

## Context
Stage 7 asks for a single-direction live path that proves the media architecture:
- Opus with legal, documented settings;
- bounded and validated UDP packets;
- a bounded jitter buffer;
- receive and playback counters, packet-loss concealment on the monitor only, and visible on/off and gain;
- network and codec work kept out of the capture callback.

## Direction: producer → performer first
The brief says to start this way. Nothing in the architecture argues for the other direction:
- The producer is the one listening on an explicitly chosen interface (ADR-016). It already needs a documented inbound rule, now TCP *and* UDP on the Private profile.
- The performer only makes outbound connections. With the address learning below, the performer PC needs **no inbound firewall rule at all**, because replies to its own outbound UDP pass a stateful firewall.
- The performer hears the producer's cues and count-ins. That is the primary monitoring need in a remote take.

## Decision
- **New Qt-free library `libs/media` (`rr_media`).** Links libopus 1.6.1, fetched at configure time from downloads.xiph.org and pinned by the published SHA-256 (`cmake/RrOpus.cmake`).
  - Statically linked; BSD-3-Clause.
  - DRED/OSCE, programs and tests are off.
  - Configuration fails if libopus would use its non-thread-safe "pseudostack", because decoding runs in a callback.
- **Threads and buffers** (no network or codec work on the capture callback):

  | Where | Work | Bound |
  |---|---|---|
  | Capture callback | `LiveTap::push_capture`: average channels to mono, all-or-nothing copy into an SPSC ring | ring 32 768 frames (≈ 680 ms). On overflow the whole block is dropped and counted (`overflow_events/frames`); the sender advances its sample counter by the dropped amount, so the gap is visible |
  | Media-send thread (producer) | read 1 frame → Opus encode → header + CRC → `sendto`; receive reports | backlog above 6 frames is trimmed to 1 frame (counted) so live delay stays bounded |
  | Media-receive thread (performer) | `recv` → validate → arrival statistics → SPSC packet queue; a report every 500 ms | queue 64 packets; full = dropped and counted (`queue_full_drops`) |
  | Playback callback (performer) | queue → jitter buffer → Opus decode or PLC → gain → **added** to the output after the local monitor | ⌈callback frames / frame⌉ + 1 decodes; worst callback time measured (`max_render_ns`) |

  - The playback hook is `AudioEngine::attach/detach_playback_contributor`. A seq-cst flag handshake means `detach` returns only when the callback can no longer be inside the receiver. Only the control thread waits, never the callback.
- **Header v1 as built (26 bytes, PROTOCOL_OVERVIEW §12).** ADR-008's layout, with these clarifications:
  - Offset 4 is `media_index`: the **48 kHz live-stream sample counter**, not the capture-device frame index. It is the encoder's sample position, including samples dropped by a tap overflow or backlog trim.
  - Only stream 1 (producer microphone) exists. Codec flag 1 = Opus. PCM16 (flag 0) is refused.
  - New packet type **4 = RECEIVER_REPORT** (performer → producer, 64-byte payload). The PROBE types 1 and 2 are still designed but not implemented, so they are rejected as `bad_type`.
- **Validation order:** PROTOCOL_OVERVIEW §2.1, every step counted per reason. For audio, the Opus packet must also describe exactly one allowed frame (2.5, 5, 10 or 20 ms), checked with `opus_packet_get_nb_samples` **before** it reaches the callback.
- **Addressing without changing control:**
  - **Media session id** = the 8-hex-digit session id as a u32.
  - **Media port** = control port + 1 on the producer (52001 by default, matching `NetworkConfig::media_udp_port`).
  - The producer binds UDP on **its selected interface** (`0.0.0.0` refused, `SO_EXCLUSIVEADDRUSE`).
  - The performer uses a **connected** UDP socket to `producer_host:media_port`, so the kernel only delivers that endpoint's datagrams.
  - The producer sends audio only to an endpoint it **learned from a valid receiver report whose source IP is the performer's control-connection address**. It stops when a report says "closing" or no report has arrived for 3 s.
- **Codec settings:** bounded, validated in `live_settings`, and checked against the libopus 1.6.1 API documentation in `opus.h` / `opus_defines.h`.

  | Setting | Default (prov.) | Allowed | Source of legality |
  |---|---|---|---|
  | Sample rate, channels | 48 000 Hz, mono | fixed | Opus Fs ∈ {8, 12, 16, 24, 48} kHz |
  | Frame | 10 ms (480) | 2.5, 5, 10, 20 ms | `opus_encode`: exactly one frame of 2.5/5/10/20/40/60 ms; 40/60 ms excluded for delay |
  | Application | RESTRICTED_LOWDELAY | or AUDIO | "disables the speech-optimized mode in exchange for slightly reduced delay" |
  | Bitrate | 64 kbit/s, **hard CBR** | 16–128 kbit/s | `OPUS_SET_BITRATE`: 500–512 000 meaningful |
  | Complexity | 5 | 0–10 | `OPUS_SET_COMPLEXITY` 0–10 |
  | In-band FEC | off | — | "only applicable to the LPC layer"; RESTRICTED_LOWDELAY has no LPC layer |
  | Packet buffer | 1276 bytes | — | one frame ≤ 1275 bytes + TOC (RFC 6716 §3.2.1). 4000 is libopus's general recommendation for multi-frame packets. |

  The codec delay is **read back** with `OPUS_GET_LOOKAHEAD` and shown, not assumed. On this PC it was 120 samples (2.5 ms) for RESTRICTED_LOWDELAY and 312 samples (6.5 ms) for AUDIO.
- **Playout:** ADR-011 as specified (fixed depth, Lost/Underrun/Late/Duplicate/TooEarly, stall limit 20, drift skip at more than target+2 for about 1 s).
  - The target is configurable from 1 to 16 frames and applies at the next refill. The performer's UI shows it in ms.
  - **Concealment:** Opus PLC (`opus_decode_float(NULL, 0, frame)`) with the duration of the last good frame. It is used **only** for the live monitor. Nothing in `rr_media` reads or writes a take file, and the master recordings are independent (ADR-007).
- **UI:**
  - Off by default on both sides.
  - Producer: "Send my microphone live", frame, bitrate, mode, its own counters and the performer's reported counters.
  - Performer: "Hear the producer", gain −60…0 dB (default −12, no boost), jitter depth, a headphones notice and its counters.

## Responsiveness versus stability (measured on one PC, test clocks)
The jitter target trades delay against dropouts:
- **Buffer delay:** about target × frame. That is 30 ms at the default 3 × 10 ms.
- **Other delay** (not measured): the codec lookahead (2.5 ms), the frame itself, the device buffers and the network.

On loopback with 10 ms frames, 1, 2 and 3 frames all played with 0 underruns.

With **2.5 ms frames and a 4-frame (10 ms) buffer**, 635 underruns occurred in 10 s. The cause is that audio enters and leaves in about 10 ms device blocks, so packets arrive four at a time and the player pulls four per callback. The same frames with 8 frames (20 ms) had 0 underruns. **So a smaller frame does not by itself lower the usable delay below the device block period.** This is relevant to RQ1 and recorded as an observation, not a tuned optimum.

## Consequences and limits
- **Security:** LAN-only, unencrypted, unauthenticated (ADR-012). The CRC detects corruption, not tampering. The source-address and session checks prevent mix-ups, not attacks. DTLS or SRTP with an established library is a later security stage. Never custom cryptography.
- **One direction only.** The producer cannot hear the performer through the app. Two-way talkback reuses the same parts with stream 2.
- **Clock offset:** still from TCP heartbeats (D-42). The UDP probes of ADR-010 are not built.
- **Drift:** the drift skip is implemented and unit-tested. Real clock drift between two PCs was not observable on one PC.
- **Sender timing:** THREADING §5 allowed a `SetEvent` wake from the capture callback, with "T4 polls every 2 ms" as the documented alternative. Stage 7 takes the **alternative**, so the capture callback makes no kernel call at all.
  - The sender polls the tap with `select(1 ms)` under `timeBeginPeriod(1)`.
  - Measured on this PC: 1.6 ms median wake, p95 2.1 ms. Without `timeBeginPeriod` it was 15.6 ms.
  - That adds up to about 2 ms of send delay. The cost is a wake-up about every 1.6 ms while live audio runs.
- **Deviations from THREADING §2:**
  - The mono downmix runs in the capture callback (a few additions per frame), not in T4.
  - The send ring is about 680 ms, not 200 ms. Live delay is bounded instead by the sender's 6-frame backlog trim.
  - The MON ring and conceal-event ring (a monitor file of what the performer heard) are **not built**.
- **Sample rate:** live audio needs the input at 48 kHz (the tap counts `wrong_rate_blocks` otherwise) and the output at 48 kHz (`wrong_rate_callbacks`). No resampler (ADR-013).
