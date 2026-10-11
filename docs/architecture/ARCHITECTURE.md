# Architecture: Producer Studio and Performer Client (C++17)

> **SUPERSEDED (Stage 2, 11 Oct 2026)** by [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) and the ADRs in [adr/](adr/README.md).
> It is kept unchanged below as the Stage 0 record. Where the two differ, the Stage 2 documents apply. Main changes:
> - separate capture and playback devices (ADR-003);
> - TCP control on Qt Network (ADR-005);
> - CRC now covers the header (ADR-008);
> - two state machines instead of one (SESSION_STATE_MACHINE).

**Status:** Stage 0 proposal for review, 11 October 2026. Nothing here is implemented yet.
**Builds on:** proposal v2 §4 (dual-path capture), the Rust prototype `duplexrec-rs`,
and the 9 Oct C++ prototype (see `docs/research/RESEARCH_PRESERVATION_INDEX.md`).

---

## 1. The one rule

> **The audio that is kept and the audio that is heard are different audio.**

Each PC writes its own microphone to a local WAV file at full quality. That is the
**master path**. A separate, lossy, packetised copy goes over the network so the
two people can hear each other. That is the **monitor path**. Nothing that happens
on the monitor path can change a master file. If the performer's master is ever
copied to the producer (Stage 6), it travels on its own reliable, verified path
after the take, never through the live stream.

## 2. Repository layout (target)

```
PP1-TEST/
  CMakeLists.txt, CMakePresets.json
  core/                 dawrr_core: static library, NO Qt, NO UI
    audio/              device enumeration, duplex engine (miniaudio), level meters
    rt/                 SPSC ring buffer, atomics-only snapshots
    record/             WAV writer thread, take finalisation
    net/                Winsock wrapper, UDP media, TCP control framing
    proto/              wire formats (media header, control messages), versioned
    sync/               clock-offset exchange, schedule conversion
    session/            producer and performer state machines (pure logic, testable)
    metrics/            counters, per-second CSV, take JSON
  apps/producer/        ProducerStudio.exe   (Qt Widgets shell over core)
  apps/performer/       PerformerClient.exe  (Qt Widgets shell over core)
  tests/                Catch2 unit tests for core (no audio hardware required)
  tools/                analysis scripts (Python), test helpers
  third_party/          vendored, pinned sources (miniaudio)
  docs/                 this documentation
```

`dawrr_core` has no Qt dependency. That keeps the real-time and network code
testable without a GUI and keeps Qt's LGPL boundary clean. The two executables
share the core. They differ only in role logic and UI.

## 3. Threads and data flow (per PC)

```
                    ┌──────────────── audio device callback (miniaudio duplex, WASAPI) ────────────────┐
 mic ──► capture ──►│ copy block → [REC ring]   copy block → [SEND ring]   peak/RMS → atomics          │
                    │ jitter buffer pop ◄── [RECV ring]  → mix into output → headphones                │
                    └────────────────────────────────────────────────────────────────────────────────────┘
 [REC ring]  ──► Recorder thread ──► takeNN_<role>.wav.partial ──► finalise → takeNN_<role>.wav
 [SEND ring] ──► Media-send thread ──► segment, encode (PCM16 → Opus later) ──► UDP
 UDP ──► Media-recv thread ──► validate, decode ──► [RECV ring]
 TCP ◄─► Control thread ──► session state machine (producer = authority)
 counters/atomics ──► Metrics thread (1 Hz CSV)   ──► UI thread (Qt timer, about 30 Hz, reads snapshots only)
```

**What the audio callback may do:** copy samples into preallocated
single-producer/single-consumer (SPSC) rings, update atomic counters and meters,
and run the jitter buffer's bounded logic on preallocated slots.

**What it must never do:** allocate, lock a mutex, call any file, socket or
logging API, touch Qt, or wait on anything.

If a ring is full, the callback drops the block **and increments a counter**. It
never blocks.

| Queue | Producer → consumer | Capacity (initial) | On overflow |
|---|---|---|---|
| REC ring | callback → recorder | 10 s of float32 audio (about 1.9 MB mono, 48 kHz) | Counted as a `record_overrun` with the sample position. The take is marked **"has gaps"** in its JSON and in the UI. Never silent. |
| SEND ring | callback → media-send | 200 ms | Counted, block dropped (monitor path only) |
| RECV ring | media-recv → callback | 64 packet slots | Counted as `net_queue_full`, packet dropped |

Ownership and lifetimes: the `Engine` object owns all rings, threads and the
miniaudio device. The shutdown order is fixed: stop the device first (no more
callbacks), then signal the worker threads, join them, finalise any open take,
and close the sockets. Each ring has exactly one writer thread and one reader
thread, and this is stated in its type name or comment.

## 4. Audio format decisions (to confirm in Stage 1–2)

- **Device rate: 48 000 Hz** on both PCs. The prototypes showed that WASAPI shared
  mode will not resample for us reliably. Option for review: let miniaudio
  resample a 44.1 kHz device to 48 kHz on the monitor path only, while the
  **master records at the device's native rate**, with the rate stored in the
  take metadata. Default proposal: require 48 kHz and show a clear error if the
  device runs at another rate.
- **Master file:** WAV, **32-bit IEEE float, mono**, at the device rate. This is
  the same as the Rust prototype, so there is no quantisation of the master.
  Files are written as `*.wav.partial` and renamed to `*.wav` only after the
  header has been patched and the file flushed. A crash therefore leaves a
  visibly incomplete file. That file is still recoverable, because the data
  chunk is valid up to the last flush.
  The 4 GiB limit of WAV is about 6.2 hours of float mono at 48 kHz. That is
  documented as a limit. RF64 is out of scope.
- **Monitor stream:** mono. Stages 4–5 use PCM16 with 10 ms segments, which is
  986 bytes per packet and fits one Ethernet frame (proven in the prototype).
  Stage 5 adds Opus at 48 kHz with **10 ms or 20 ms frames** (legal Opus
  durations: 2.5, 5, 10, 20, 40, 60 ms).
- Any alignment, resampling or export creates a **new derived file**. Master files
  are never modified after finalisation.

## 5. Wire protocols (draft)

### 5.1 Media (UDP, both directions)

This keeps the prototype's **26-byte** header (proposal Table 2, corrected count).
All fields are big-endian:

| Off | Size | Field | Notes |
|---|---|---|---|
| 0 | 4 | sequence | Per-stream, wraps around |
| 4 | 8 | capture sample index | Sample index of the first sample, on the **sender's device clock** |
| 12 | 4 | session id | Random, from the producer's session |
| 16 | 2 | stream/layer id | |
| 18 | 2 | payload length | |
| 20 | 1 | type | audio / ping / pong |
| 21 | 1 | flags | Codec bits (PCM16 = 0, Opus = 1), end-of-stream (uses the "reserved" byte in the Rust code and the "flags" field of Table 2) |
| 22 | 4 | CRC-32 of payload | Catches corruption only. Not authentication (see §9). |

The receiver uses a bounded jitter buffer (depth in segments, configurable). It
counts loss only once later packets have arrived, so a peer that has stopped
sending is not counted as loss. It counts late packets, re-orders, and conceals a
missing segment with PLC. PCM16 PLC means repeating the last segment at
attenuated level. Opus has its own PLC. **Concealment affects only what is heard.
It is logged with sample positions, and never touches a master file.**

### 5.2 Control (TCP, producer listens, performer connects)

Length-prefixed binary frames: `u32 length | u16 msg_type | u16 version | body`.
Each message carries a `msg_id`, and the replies that matter echo it.

| Message | Direction | Purpose |
|---|---|---|
| HELLO / HELLO_ACK | P→S, S→P | Protocol version, role, pairing code, app version |
| DEVICE_STATUS | both | Selected devices, sample rate, input OK, free disk space |
| READY / NOT_READY(reason) | both | Readiness gate before recording is allowed |
| TIME_REQ / TIME_RESP | S→P, P→S | Four-timestamp exchange (§6) |
| ARM_TAKE(take_id, start_at_producer_ts, lead_ms) | S→P | Scheduled future start |
| ARM_ACK(take_id, planned_start_local_ts, est_offset, uncertainty) / ARM_NACK(reason) | P→S | Recording begins only after ACK. NACK aborts the take on both sides. |
| TAKE_STARTED(take_id, first_sample_index, local_ts) | both | What actually happened, not what was planned |
| STOP_TAKE(take_id, stop_at_producer_ts) / STOP_ACK | S→P, P→S | |
| TAKE_FINALISED(take_id, frames, bytes, status, overruns) | P→S | Shows the performer's file is complete or incomplete |
| HEARTBEAT | both | Detects a disconnect (for example after 3 s of silence) |

## 6. Time, scheduling and what is (and isn't) measured

**Clock domains.** (a) Each PC's monotonic clock, `QueryPerformanceCounter` via
`std::chrono::steady_clock`. (b) Each audio device's **sample counter**. These are
different clocks, and the device clock drifts from (a) by some ppm. The Rust
prototype used *wall clock* for its offset estimate. The C++ version uses the
monotonic clock instead, because wall-clock steps (NTP corrections) corrupt
offset estimates.

**Offset estimation.** An NTP-style exchange over the control channel computes
offset θ = ((t2 − t1) + (t3 − t4)) / 2 and round-trip δ = (t4 − t1) − (t3 − t2).
The exchange repeats. The estimate is taken from the samples with the smallest δ,
and its uncertainty is reported as ±δ_min/2, which is the standard bound for a
symmetric-path assumption.

**Scheduled start.** The producer chooses `T = now + lead`, with lead defaulting
to 1 000 ms and always more than several RTTs. The performer converts T into its
own clock using θ. The **recorder thread** (not the callback) maps T to a
sample index using the time-stamped sample position of each capture block, and
starts writing from that sample. Both sides report the actual first sample and
the timestamp of that block.

**Honesty rules for labels.** Every measurement is stored and shown under its own
name:

| Name | What it is | Where it comes from |
|---|---|---|
| Control RTT | Round-trip time of control messages | TIME_REQ/RESP δ |
| Estimated clock offset | θ between the two monotonic clocks | Four-timestamp exchange |
| Offset uncertainty | ±δ_min/2 | Same |
| Media one-way delay | **Not directly measurable** without synchronised clocks. Only an *estimate* (θ-corrected arrival time). | Labelled "estimate" |
| Packet loss | Missing sequence numbers, confirmed by later arrivals | Jitter buffer |
| Arrival jitter | RFC 3550 §6.4.1 interarrival jitter | Media-recv thread |
| Jitter-buffer depth | Configured and current fill, in ms | Jitter buffer |
| Device latency | What miniaudio/WASAPI report for the buffer sizes | Labelled "reported", not "measured" |
| Recording-start offset | Difference between the two takes' first samples, mapped through θ | Take JSON. It is an *estimate* that carries θ's uncertainty. |
| Sample-clock drift | Device sample count vs monotonic time, in ppm | Later stage (7) |
| Alignment residual | The true misalignment of the two master files after alignment, measured by cross-correlating a shared reference signal | Later stage (7), proposal Test 1 |

A START command, even an acknowledged and scheduled one, **does not prove
sample-accurate alignment**. Only the Stage 7 measurement can say how well the
takes line up.

## 7. Session state machines

**Producer (authority):**
`Idle → Listening → Paired → Ready ⇄ NotReady → Arming → Recording → Stopping → Finalising → Ready`.
Any state can go to `Error(reason)`.
- `Arming` waits for ARM_ACK until its timeout. A NACK or timeout cancels the take on both sides.
- `Finalising` waits for the performer's TAKE_FINALISED until its timeout. If it times out, the producer shows "performer take status unknown". It never shows "saved".

**Performer (follower):**
`Idle → Connecting → Connected → Ready ⇄ NotReady → Armed → Recording → Finalising → Ready`.
- The performer **cannot start a take itself**. It only follows an acknowledged producer schedule.
- **If the control link drops while recording, the performer keeps recording locally** and shows a warning. It stops on a STOP after reconnection, on a local "Stop & save" button, or at a safety time limit (configurable). *(Needs review: this is a policy choice.)*
- A dropped live stream (UDP) never stops recording on either side.

**UI states the user must always be able to see:** connection status, the
readiness of both sides, REC with take number and elapsed time, "saving…",
"take complete (N s, file name)", "take INCOMPLETE (reason)", and counters for
device errors, overruns, dropped packets and disk errors.

## 8. Failure handling (minimum set)

| Failure | Detection | Response |
|---|---|---|
| Device lost or unplugged | miniaudio stop/notification callback | Stop the take, finalise what was captured, mark it INCOMPLETE, show an error |
| REC ring overrun (disk too slow) | Counter in the callback | Continue. Record the gap positions in the JSON. UI warning. |
| Disk full or write error | Recorder thread I/O error | Stop writing, keep the `.partial` file, mark the take INCOMPLETE, tell the producer |
| Control disconnect | Heartbeat timeout or socket error | See §7 policy. Try to reconnect automatically. |
| Media loss or late packets | Jitter buffer | Conceal, count, log positions. The master is not affected. |
| Finalisation error (header patch or rename) | Return codes | Leave the `.partial` file and report its path |

## 9. Security assumptions (PP1 prototype)

- **LAN-only, not encrypted, not authenticated.** A random pairing code stops
  *accidental* connections to the wrong session. It does **not** protect against
  an attacker on the same network, who could listen to or inject audio and
  control messages. CRC-32 detects corruption, not tampering.
- Use only on a trusted private network: own router, Ethernet cable, or a Windows
  network profile set to *Private*. **Do not use on public or untrusted networks.**
- Received data is validated: lengths, types and bounds are checked before use.
  File names for the transferred take (Stage 6) are generated locally, never taken
  from the peer.
- Proposal NFR7 (encryption in transit, single-use session codes) is **not met**
  by the PP1 build. It is planned as a separate stage using Qt's TLS backend
  (Schannel) for control. No custom cryptography.
- NAT traversal, relays and internet use are out of scope until separately designed.

## 10. Requirements traceability (proposal v2 → stage)

| Requirement | Stage |
|---|---|
| FR2 local full-quality capture | 2 |
| FR1 create/join a session with a code (LAN, manual IP for now) | 3 |
| FR6 shared record/stop (record and stop only, not play/locate/markers) | 3 |
| FR3 monitor stream | 4 (PCM16), 5 (Opus) |
| FR7 live input levels | 2 (own), 4 (peer) |
| FR10 measurements logged | 2–4 (counters/CSV), 7 (alignment) |
| FR4 runtime segment and jitter-depth settings | 4 |
| FR5 clock sync and drift tracking | 3 (offset), 7 (drift) |
| FR8 take exchange and reassembly | 6 (transfer), 7 (alignment) |
| FR9 export to the Web DAW interchange format | Later |
| NFR7 security, NFR8 four participants, NFR10 macOS | Later, separately documented |
