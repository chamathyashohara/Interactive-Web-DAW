# Protocol Overview (v1.0, draft for review)

**Stage 2 · 11 October 2026.** Decisions: ADR-005, 006, 008, 009, 010, 011, 012, 014.
Values marked **(prov.)** are configurable starting settings, not tuned or
proven-optimal values. Each value in use is written into the session metadata.

All multi-byte integers are **big-endian**, except PCM16 audio samples, which
are little-endian.

---

## 1. Endpoints

| Channel | Transport | Listener | Default port (prov.) | Peer filtering |
|---|---|---|---|---|
| Control | TCP | Producer | 52000 | One performer per session. Its address becomes "the peer". |
| Media and clock probes | UDP | Both | 52001 | Datagrams from any address other than the paired peer's are dropped and counted (`src_rejected`) |
| Take transfer (COULD) | TCP | Producer | 52002 | Only from the paired performer's address |

All ports are configurable (APP-03). The defaults avoid 50000 and 50001,
because AnyDesk was observed holding UDP 50001 on the development PC
(duplexrec README).

## 2. Media packet header v1 (26 bytes, ADR-008)

> **Stage 7:** the live media path as built is in **§12** (ADR-017). Where §2–§3 differ (the meaning of offset 4, packet type 4, Opus only, address learning), **§12 is authoritative**. §2–§3 are kept as the Stage 2 draft.

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 0 | 4 | `seq` | Per-stream sequence number. Starts at 0 when the stream starts and wraps at 2³². Compared with `int32(a − b)`. |
| 4 | 8 | `capture_index` | Sender's capture-device frame index of the first sample in this packet. Counts device frames since the capture device started. **It is a sample counter, not a clock time.** |
| 12 | 4 | `session_id` | Random, set by the producer, shared in HELLO_ACK |
| 16 | 2 | `stream_id` | 1 = producer microphone, 2 = performer microphone. Matches Table 2's "layer". |
| 18 | 2 | `payload_len` | Number of payload bytes. Must equal datagram length − 26. |
| 20 | 1 | `ver_type` | High nibble: header version = **1**. Low nibble: type (§3.1). |
| 21 | 1 | `flags` | Bits 0–1: codec (0 = PCM16LE, 1 = Opus). Bit 2: talkback muted (payload is codec silence). Bits 3–7: reserved, must be 0. |
| 22 | 4 | `crc32` | CRC-32/IEEE over bytes 0–21 **and** the payload. Detects corruption only, not tampering. |

**Maximum datagram:** 26 + payload ≤ **1472 bytes** (1500 MTU − 20 IPv4 − 8 UDP),
so the payload is at most 1446 bytes. That gives one IP packet with no
fragmentation, and a PCM16 frame size of at most 15 ms.

### 2.1 Receive validation order (every step counted on failure, ERR-07)
1. Source address is the paired peer, else `src_rejected`.
2. Length is at least 26, else `bad_len`.
3. Version is 1, else `bad_version`.
4. Type is known, else `bad_type`.
5. `payload_len` equals datagram length − 26, else `bad_len`.
6. CRC matches, else `bad_crc`.
7. `session_id` matches, else `bad_session`.
8. Type-specific payload checks: codec equals the negotiated one, payload size fits the frame, reserved bits are 0. Else `bad_payload`.

A packet goes on to the jitter buffer only after all eight checks pass.

## 3. Media stream

### 3.1 Packet types
| Type | Name | Payload |
|---|---|---|
| 0 | AUDIO | One encoded frame. PCM16: `frame_samples × 2` bytes. Opus: one Opus packet, at most 1446 bytes. |
| 1 | PROBE_REQ | `u32 probe_id, i64 t1_ns` |
| 2 | PROBE_RESP | `u32 probe_id, i64 t1_ns, i64 t2_ns, i64 t3_ns` |
| 3 | END_OF_STREAM | Empty. The sender is stopping on purpose (BYE or shutdown), so the receiver returns to filling without counting loss. |

### 3.2 Frame duration and audio format on the live path
- **Live format:** mono, 48 kHz. Multi-channel capture is downmixed to mono on the live path only (ADR-007).
- **Frame duration:** default **10 ms = 480 samples** (prov.). Allowed: 2.5, 5, 10, 20 ms; with Opus also 40 and 60 ms. PCM16 is refused above 15 ms (§2).
  - Reasoning: 10 ms is the value both prototypes ran with on loopback (REPOSITORY_AUDIT §3). It is a common VoIP and NMP granularity, and with PCM16 it fits the MTU. **It is not claimed to be optimal.** Segment size is the RQ1 research variable.
- The frame duration is fixed for a session and announced in HELLO_ACK.

### 3.3 Jitter buffer policy (receiver, owned by the playback callback, ADR-011)

| Parameter | Default (prov.) | Range |
|---|---|---|
| Target depth D | 3 frames (30 ms at 10 ms frames) | 1–16 frames |
| Packet queue (receive thread → callback) | 64 packets | fixed at build time |
| Stall limit (go back to filling) | 20 consecutive missing frames | 5–200 |
| Drift-skip threshold | fill > D+2 frames for more than 1 s | — |

**States:**
- `FILLING`: wait until D consecutive-or-later frames are queued, then set `next_seq` to the lowest one.
- `PLAYING`, for each frame due:
  - slot `next_seq` present → decode and play;
  - else, if a higher seq is present → **lost**: conceal, `lost++`;
  - else → **underrun**: conceal, `underrun++`;
  - after the stall limit is reached → back to `FILLING` (`rebuffer++`).

**Arrival rules:**
- `seq < next_seq` → `late++`, drop.
- Already held → `duplicate++`, drop.
- `seq ≥ next_seq + 64` → `too_early++`, reset to `FILLING`.

All counters are cumulative per session and per take.

### 3.4 Clock probes (ADR-010)
- Each side sends PROBE_REQ at 4 Hz (prov.).
  - `t1` = local monotonic time just before `sendto`.
  - The responder sets `t2` right after `recvfrom` and `t3` right before `sendto`.
  - The requester sets `t4` right after `recvfrom`.
- Then **δ = (t4 − t1) − (t3 − t2)** and **θ = ((t2 − t1) + (t3 − t4)) / 2**, which estimates *responder clock − requester clock*.
- **Reported:**
  - θ̂ = θ of the probe with the smallest δ among the last 16;
  - **uncertainty u = δmin / 2**. The true offset lies within θ̂ ± u if the timestamps are exact; an asymmetric path cannot push it outside that bound.
  - **probe RTT** = δ of the latest probe.
- Probes with δ > **1 s** or a missing response within 1 s are discarded and counted. The ceiling
  was 100 ms until Stage 12 (ADR-022): it is a sanity limit, not a quality filter, and at 100 ms it
  discarded every probe on an ordinary Wi-Fi link, so the offset was never measured at all. A slow
  probe cannot pull θ̂, which is always the probe with the smallest δ; it only widens u until a
  better probe arrives.

## 4. Control framing (TCP, ADR-009)

> **Stage 6:** the control protocol as built is in **§11**. Where §4–§5 and §7–§8 differ from §11 (message names, the HELLO/JOIN split, the 16 KiB frame limit, the ARM → SCHEDULE_START two-step), **§11 is authoritative**. §4–§5 are kept unchanged as the Stage 2 draft.

```
u32 length        bytes that follow this field, 12 … 65 536
u16 type          message type (§5)
u16 reserved      0
u32 msg_id        sender's increasing counter, starts at 1
u32 ref_id        msg_id being answered (ACK/NACK/RESP), else 0
…   TLV fields    repeated: u16 tag | u16 len | len bytes
```

- **Rejected:** `length` > 65 536, a TLV running past the frame, or a duplicate tag. These close the connection with `E_PROTOCOL_MALFORMED`.
- **Unknown tags are ignored** (forward compatibility).
- **Field types:** integers are big-endian at their stated width. Strings are UTF-8, at most 256 bytes. Times are `i64` nanoseconds of the **sender's** monotonic clock unless the name says otherwise.

## 5. Control messages

S = producer (Studio), R = performer. "Req." lists the required fields.

| Code | Message | Dir | Req. fields | Reply / timeout (prov.) |
|---|---|---|---|---|
| 0x0001 | HELLO | R→S | `proto_major, proto_minor, role=performer, app_version, pairing_code, codecs_supported (bitmask), media_port, display_name` | HELLO_ACK or HELLO_REJECT within 3 s, else R shows "No response" |
| 0x0002 | HELLO_ACK | S→R | `proto_major, proto_minor, session_id, codec, frame_samples, sample_rate, media_port, display_name, max_take_s` | — |
| 0x0003 | HELLO_REJECT | S→R | `error_code, proto_major, proto_minor` | S closes after sending |
| 0x0010 | HEARTBEAT | both | `sent_ns` | HEARTBEAT_ACK. Sent every 1 s. Link counted **lost after 3 s** without any frame. |
| 0x0011 | HEARTBEAT_ACK | both | `echo_sent_ns` | Gives **control RTT** |
| 0x0020 | STATUS | both | `state, device_ok, sample_rate, channels, disk_free_bytes, consent, media_path_ok, error_code` | Sent on every change and at least every 2 s |
| 0x0021 | CONSENT | both | `given (u8), at_utc (string), notice_version` | — |
| 0x0030 | ARM | S→R | `take_id, start_at_ns (producer clock), max_take_s` | ARM_ACK / ARM_NACK, required **before start_at − 100 ms**, else S sends CANCEL |
| 0x0031 | ARM_ACK | R→S | `take_id, planned_start_local_ns, theta_ns, uncertainty_ns` | — |
| 0x0032 | ARM_NACK | R→S | `take_id, error_code` | S cancels the take |
| 0x0033 | CANCEL | S→R | `take_id, error_code` | No files are kept as Saved. A `.partial` that was already opened is finalised as `cancelled`. |
| 0x0034 | TAKE_STARTED | both | `take_id, first_capture_index, first_sample_est_ns, stamp_residual_ns` | Information only. Feeds the start-offset estimate. |
| 0x0040 | STOP | S→R | `take_id, stop_at_ns (producer clock, lead 300 ms prov.)` | STOP_ACK within 2 s |
| 0x0041 | STOP_ACK | R→S | `take_id` | — |
| 0x0042 | LOCAL_STOP | R→S | `take_id, reason (error_code)` | Performer pressed Stop & save, or hit the safety limit or a device/disk error |
| 0x0043 | TAKE_FINALISED | both | `take_id, status (§6.2), has_gaps, frames, bytes, sha256 (optional), file_name` | The producer waits up to **10 s** after STOP_ACK, then shows the performer take as **UNKNOWN** |
| 0x0050 | BYE | both | `reason` | The sender closes. The peer sends END_OF_STREAM on media. |

## 6. Codes

### 6.1 Error codes (u16)
| Code | Name | Typical use |
|---|---|---|
| 0 | OK | — |
| 1 | E_PROTOCOL_MALFORMED | Bad frame or TLV, or missing required field |
| 2 | E_VERSION_UNSUPPORTED | Major version differs. APP-02, T-05e. |
| 3 | E_BAD_PAIRING_CODE | SES-03, T-05b |
| 4 | E_SESSION_FULL | Second performer |
| 5 | E_WRONG_ROLE | A producer tried to join a producer |
| 6 | E_NOT_READY | ARM while not READY |
| 7 | E_NO_CONSENT | ARM before consent |
| 8 | E_ARM_TOO_LATE | Converted start time is already past or less than 100 ms away |
| 9 | E_TAKE_ID_CONFLICT | Take ID already used in this session |
| 10 | E_BUSY | ARM while already recording or finalising |
| 11 | E_DEVICE | Device missing, failed to open, stalled or lost |
| 12 | E_DISK_SPACE | Below what REC-09 requires |
| 13 | E_DISK_WRITE | Write or flush failed (includes disk full) |
| 14 | E_TIMEOUT | Expected reply not received |
| 15 | E_CANCELLED | Take cancelled |
| 16 | E_UNKNOWN_TAKE | STOP or report for a take that isn't known |
| 17 | E_USER_STOP | Performer pressed Stop & save |
| 18 | E_SAFETY_LIMIT | `max_take_s` reached |
| 19 | E_SHUTDOWN | App closing |
| 20 | E_TRANSFER_HASH_MISMATCH | XFER |
| 21 | E_TRANSFER_REFUSED | XFER (no consent, name rejected) |
| 22 | E_INTERNAL | Bug or invariant violation (always logged) |
| 23 | E_TRANSFER_INVALID_FILE | XFER (Stage 11): the received copy is not a complete WAV matching the offer and the TAKE_FINALISED report |

### 6.2 Take status (metadata, TAKE_FINALISED, verification report)
| Status | Meaning |
|---|---|
| `complete` | Finalised normally, header correct, renamed to `.wav` |
| `complete_shutdown` | Finalised normally because the app was closing (ERR-05a) |
| `incomplete_disk` | Disk full or write error. `.partial` kept (ERR-02). |
| `incomplete_device` | Device lost or stalled. The audio up to that point is finalised (ERR-06). |
| `incomplete_crash` | A `.partial` found on startup (ERR-05b) |
| `cancelled` | ARM cancelled before or right at the start |

`has_gaps` is a separate flag: true if any record-buffer overrun happened
(REC-05), with the positions listed in the metadata.

## 7. Version negotiation
- The protocol is **1.0** (major 1, minor 0). The major changes when a message, field meaning or header layout changes incompatibly. The minor changes for added optional TLVs or messages.
- HELLO carries the performer's version. If the majors differ → HELLO_REJECT `E_VERSION_UNSUPPORTED` with the producer's version, and both apps show both versions (APP-02).
- If the minors differ → accept, and use only features known to both. The codec is chosen from the intersection of `codecs_supported`: the producer's preference if both have it, otherwise PCM16.
- The media header has its own version nibble (§2). Header v1 belongs to protocol 1.x.

## 8. Timeouts and limits (all prov., configurable, logged)
| Item | Value | Why this value |
|---|---|---|
| TCP connect | 5 s | Long enough for a LAN with a slow firewall prompt. Short enough for useful feedback. |
| HELLO reply | 3 s | — |
| Heartbeat interval / link-lost threshold | 1 s / 3 s | Three missed beats. A short outage is visible within seconds (SES-10). |
| Start lead | 1000 ms | Far above LAN RTT (about 1 ms in the 9 Oct prototype data, unverified), leaving room for UI and thread scheduling |
| ARM_ACK deadline | start_at − 100 ms | The performer needs ≥ 100 ms of margin to set up its start mapping |
| Stop lead / STOP_ACK | 300 ms / 2 s | — |
| Finalisation report wait | 10 s | Header patch plus flush plus rename are fast, and this allows for a slow disk |
| Safety limit `max_take_s` | 1800 s | Matches the REC-09 disk check (OQ-13) |
| Failed pairing attempts | 5, then a new code is needed | Prevents casual guessing on the LAN. **Not a security control.** |

## 9. Take transfer protocol (COULD, ADR-014)
This runs on its own TCP connection, using the same framing as §4 with codes
0x0100 and up:
`XFER_OFFER(take_id, size, sha256, suggested_name)` → `XFER_ACCEPT(take_id)` / `XFER_REJECT(error)` →
raw stream of `size` bytes → producer recomputes SHA-256 →
`XFER_RESULT(take_id, VERIFIED | E_TRANSFER_HASH_MISMATCH)`.

- The producer **ignores `suggested_name` for the path**. It builds the name as `takeNN_performer_<session8>.wav` and never overwrites an existing file.
- The performer opens its original read-only.

## 10. Security limits (ADR-012)
- No confidentiality, integrity protection or authentication against an attacker. CRC and the pairing code protect against **accidents**, not adversaries.
- Use only on a trusted private LAN, and never expose the ports to the internet.
- Encryption and authentication come in a separate stage, using established libraries (Qt TLS, DTLS or an established AEAD). Never custom cryptography.

## 11. Control protocol 1.0 as implemented (Stage 6, authoritative)

Code: `libs/network` (`control_protocol.*`, `control_link.*`, `clock_offset.*`) and
`libs/control` (`session_controller.*`). Transport decision: ADR-016.
**LAN-only, unencrypted.** No TLS, and the pairing code is not a security control (ADR-012).

### 11.1 Framing
```
u32 length     bytes after this field, 12 … 16 384 (kMaxFrameBytes)
u16 type       §11.2
u16 reserved   0
u32 msg_id     strictly increasing per connection, starts at 1
u32 ref_id     msg_id being answered (ACK / ERROR), else 0
…   TLV        u16 tag | u16 len | bytes   (big-endian integers, UTF-8 strings ≤ 256 bytes)
```
- Every frame carries `SentNs` (tag 1, the sender's monotonic ns).
- **Errors that close the connection:** an unknown type, a duplicate tag, a missing required tag, a fixed-width tag of the wrong size, a TLV running past the frame, or `length` outside 12…16 384. The decoder stays failed afterwards. Unknown **tags** are ignored, so a minor version can add fields.
- **Stale frames:** a `msg_id` that is not greater than the last one received is dropped and counted (`stale_frames_dropped`), and never acted upon.

### 11.2 Messages (S = producer, R = performer)
| Code | Name | Dir | Required tags (besides SentNs) | Purpose / rule |
|---|---|---|---|---|
| 0x0001 | HELLO | R→S | ProtoMajor, ProtoMinor, Role, AppVersion | Version offer. Another major → ERROR `E_VERSION_UNSUPPORTED` + close. |
| 0x0002 | HELLO_ACK | S→R | ProtoMajor, ProtoMinor, AppVersion | |
| 0x0003 | JOIN | R→S | ClientId, DisplayName (+ PairingCode **or** ResumeToken) | First join with the 6-digit code; reconnect with the 32-hex token |
| 0x0004 | JOIN_ACK | S→R | SessionId, ResumeToken, DisplayName, MaxTakeSeconds | The code is used up |
| 0x000F | ERROR | both | ErrorCode (+ ErrorText, ref_id) | Refusals and protocol errors |
| 0x0010 | HEARTBEAT | both | — | Every 1 s. Clock-offset sample t1. |
| 0x0011 | HEARTBEAT_ACK | both | EchoSentNs, RecvNs | t2/t3 → θ, δ (four-timestamp method) |
| 0x0020 | READY_STATUS | both | Ready, Consent, State (+ Reasons) | On change and at least every 2 s |
| 0x0030 | ARM | S→R | TakeId, MaxTakeSeconds | Step 1: "prepare take N". No start time yet. |
| 0x0031 | ARM_ACK | R→S | TakeId, Accepted (+ ErrorCode/Text) | Refused if not ready, no consent, busy, or take id not new |
| 0x0032 | SCHEDULE_START | S→R | TakeId, StartAtNs (producer clock) | Step 2: sent only after ARM_ACK. The start is 1000 ms ahead. |
| 0x0033 | START_ACK | R→S | TakeId, Accepted (+ PlannedLocalNs) | The producer schedules its own recorder **only after** this |
| 0x0034 | TAKE_STARTED | R→S | TakeId, FirstFrame, FirstSampleNs (+ LateFrames) | Sent when the performer's file really started |
| 0x0035 | CANCEL | S→R | TakeId, ErrorCode | Before the start (timeouts, local failure). An empty `.partial` is removed. |
| 0x0040 | STOP_SCHEDULE | S→R | TakeId, StopAtNs (producer clock) | Stop lead 300 ms. Re-sent after a reconnect if it could not be sent. |
| 0x0041 | STOP_ACK | R→S | TakeId, Accepted | |
| 0x0042 | LOCAL_STOP | R→S | TakeId, StopReason | Performer Stop & save, a device fault or the safety limit |
| 0x0043 | TAKE_FINALISED | R→S | TakeId, Status, Frames | Final status. The producer waits 10 s, then shows **UNKNOWN**. |
| 0x0050 | SESSION_CLOSED | both | ErrorCode | Deliberate end. No reconnect follows. Sent, then half-close and drain (≤ 500 ms). |

Renamed from the §5 draft: HELLO_REJECT → ERROR; STOP → STOP_SCHEDULE; BYE → SESSION_CLOSED; STATUS → READY_STATUS.
CONSENT is a field of READY_STATUS. The draft's single ARM(start_at) is split into **ARM → ARM_ACK → SCHEDULE_START → START_ACK**, so the start time is only chosen once the performer has said it can record.

### 11.3 Rules that make duplicates and delays harmless
- **Take ids only increase** within a session. The performer refuses an ARM whose id is ≤ the last accepted one (`E_TAKE_ID_CONFLICT`). A duplicate SCHEDULE_START or STOP_SCHEDULE for the current take is answered idempotently (same ACK) and changes nothing. A STOP for an unknown take is refused (`E_UNKNOWN_TAKE`).
- Every state change goes through the transition tables (`libs/session/session_machine.*`). An event that is invalid in the current state changes nothing, is counted and logged, and the message that caused it is refused.
- The producer shows a performer step (ARM_ACK, START_ACK, TAKE_STARTED, STOP_ACK, TAKE_FINALISED) **only after the performer's own message**, never because a command was sent.
- A start time must lie within −1 s … +30 s of "now" on the receiving recorder. Otherwise it is refused.
- Pairing codes and resume tokens are never logged: the JSONL logs carry `<redacted>`.

### 11.4 Link behaviour
| Item | Value (prov.) |
|---|---|
| Heartbeat / link lost | 1 s / no frame for 3 s |
| Connect / handshake timeout | 5 s / 3 s |
| Reconnect interval / give up | 2 s / 120 s (the performer reconnects automatically with its resume token) |
| Pairing code | 6 digits, single use, 10 min TTL, locked after 5 wrong attempts (`E_BAD_PAIRING_CODE`). Generated with `std::random_device`. |
| Second performer | ERROR `E_SESSION_FULL`, then half-close, drain ≤ 1 s |
| Listening address | one explicitly selected IPv4 interface. `0.0.0.0` is refused. `SO_EXCLUSIVEADDRUSE`, `TCP_NODELAY`. |

What a lost link does:
- **Before the start (Armed/Scheduled):** the take is cancelled on both sides. No recording starts without a live link at T.
- **While recording:** both recordings **continue** (ERR-03). STOP_SCHEDULE is delivered after the reconnect. If Stop was pressed during the outage, the stop is re-sent with a new stop time, and the performer's take is then longer; its report shows this.
- **Session ended for good** (SESSION_CLOSED received, or reconnecting gave up) while the performer is recording: the performer stops and saves its own take.

### 11.5 Measurement terms (kept distinct)
- **Control RTT:** the latest HEARTBEAT round trip over TCP, including thread scheduling. It is not audio latency.
- **Clock offset θ ± u:** θ from the minimum-δ sample of the last 16 heartbeats, u = δmin/2. It describes the two PCs' monotonic clocks only.
- **Estimated start difference:** (performer first-sample time − θ) − producer first-sample time, ± u. It does **not** include device input latency or the converter, so it is **not** an acoustic alignment measurement.
- **UI/poll delay:** about 60–80 ms per command/answer through both apps' 20 ms select and 50 ms (GUI) / 10 ms (probe) poll loops. It is absorbed by the 1000 ms start lead. This value was observed on one PC and not measured systematically.

## 12. Live media 1.0 as implemented (Stage 7, one way: producer → performer, authoritative)

Code: `libs/media` (`media_packet.*`, `opus_codec.*`, `jitter_buffer.*`, `arrival_stats.*`,
`live_sender.*`, `live_receiver.*`), `libs/audio/live_tap.*`, and `UdpSocket` in `libs/network/socket.*`.
Decision: ADR-017. **LAN-only, unencrypted, unauthenticated** (ADR-012). The CRC detects corruption only.

### 12.1 Header (26 bytes, big-endian)
| Offset | Size | Field | As built |
|---|---|---|---|
| 0 | 4 | `seq` | Per stream. Starts at 0 when the stream starts (each time the producer starts sending). Serial arithmetic. |
| 4 | 8 | `media_index` | 48 kHz **live-stream sample counter** of the packet's first sample. It advances by dropped samples too (tap overflow, backlog trim), so sender-side gaps are visible. |
| 12 | 4 | `session_id` | The 8-hex-digit session id as a u32 (e.g. `1a2b3c4d` → 0x1A2B3C4D) |
| 16 | 2 | `stream_id` | 1 = producer microphone (the only stream) |
| 18 | 2 | `payload_len` | = datagram length − 26 |
| 20 | 1 | `ver_type` | Version 1 (high nibble), type (low nibble) |
| 21 | 1 | `flags` | AUDIO: 1 (Opus); bits 2–7 zero. Other types: 0. |
| 22 | 4 | `crc32` | CRC-32/IEEE over bytes 0–21 and the payload |

Maximum datagram 1472 bytes (no IP fragmentation on a 1500-byte MTU).

| Type | Name | Direction | Payload |
|---|---|---|---|
| 0 | AUDIO | producer → performer | One Opus packet (1…1276 bytes) holding exactly one 2.5/5/10/20 ms frame |
| 1, 2 | PROBE_REQ / PROBE_RESP | — | Designed (§3.4), **not implemented**: rejected as `bad_type` |
| 3 | END_OF_STREAM | producer → performer | Empty. Sent twice when the producer stops sending. The receiver refills without counting loss. |
| 4 | RECEIVER_REPORT | performer → producer | 64 bytes: received u64, lost_estimate u64, late, duplicates, reordered, jitter_us, jb_fill, jb_target, underruns, concealed, decode_errors, invalid_packets, flags (bit 0 playing, bit 1 closing), reserved (all u32). Every 500 ms. |

### 12.2 Validation (receiver and producer; every failure counted by reason)
1. Source endpoint:
   - **Performer:** the socket is connected to `producer:media_port`, so the kernel filters, and the endpoint is checked again (`src_rejected`).
   - **Producer:** the report's source IP must equal the performer's control-connection IP (`src_rejected`).
2. A datagram larger than the 2048-byte buffer is `oversized` (Windows `WSAEMSGSIZE`).
3. Then §2.1 steps 2–8: `bad_length` (< 26, > 1472, or `payload_len` mismatch), `bad_version`, `bad_type`, `bad_crc`, `bad_session`, `bad_payload` (stream ≠ 1, codec ≠ Opus, reserved bits, sizes).
4. AUDIO: `opus_packet_get_nb_samples` must give 120, 240, 480 or 960 samples, else `bad_payload`.
5. Duplicates within the last 1024 sequence numbers are dropped (`duplicates`). A sequence step back by ≥ 1024 counts as a new stream (`stream_restarts`).

### 12.3 Addressing and start/stop (no change to the control protocol)
- **Media port:** control port + 1 on the producer. The producer binds UDP on its **selected interface** (never `0.0.0.0`).
- **Performer:** once the control link is Connected, it opens a UDP socket **connected** to `producer_host:media_port` and sends a RECEIVER_REPORT every 500 ms.
- **Producer:** sends AUDIO only to the endpoint learned from a valid report (step 1). It stops (END_OF_STREAM) when:
  - its "send live" switch is off;
  - a report has the closing flag;
  - no report has arrived for **3 s**.
- **Lifetime:** live media runs while the session exists, including through a control-link outage. It stops when the session ends.

### 12.4 Codec (libopus 1.6.1; legality per `opus.h` / `opus_defines.h`)
48 kHz mono; frame 10 ms (2.5/5/10/20 allowed); `OPUS_APPLICATION_RESTRICTED_LOWDELAY` (or `AUDIO`); 64 kbit/s hard CBR (16–128 allowed); complexity 5; in-band FEC off. The lookahead is read back and shown (120 samples = 2.5 ms for RESTRICTED_LOWDELAY on this PC).

### 12.5 Playout (receiver, playback callback)
§3.3 (ADR-011) with the target in 1…16 frames (default 3), stall limit 20, drift skip at more than target+2 held for about 1 s, and the 64-packet queue.
- Lost and underrun frames are filled by **Opus PLC** with the last frame's duration. This is **for the live monitor only**: no recording is touched.
- Gain −60…0 dB (default −12). Off until the performer enables it.

### 12.6 Counters (shown in the apps and the probe)
| Side | Counters |
|---|---|
| Producer (sender) | packets and bytes sent, send errors, encode errors, frames encoded, tap overflow (capture gaps), backlog trims, END_OF_STREAM sent, reports received, peer timeouts, invalid incoming by reason, max encode time, lookahead, test-impairment drops/dups/reorders |
| Producer (from the performer's report) | received, lost estimate, late, duplicates, reordered, jitter, buffer fill/target, underruns, concealed, decode errors, invalid |
| Performer (receiver) | received, expected, lost estimate, duplicates, reordered, late, inter-arrival jitter (RFC 3550 estimator over arrival time vs `media_index`), largest arrival gap, buffer fill/target/max, played, lost (concealed), underruns, refills, drift skips, too-early resets, decode errors, queue-full drops, invalid by reason, max decode+mix time per callback, wrong-rate callbacks, output peak |

**Measurement terms (kept distinct):** inter-arrival jitter describes packet timing at the receiver. It is not latency. The loss estimate comes from sequence numbers, and loss after the last received packet cannot be seen. None of these counters measure acoustic (mouth-to-ear) latency, which needs a loopback measurement with real devices (MONITOR_LOOPBACK_TEST_PROTOCOL, not yet run for the live path).

## 13. Live media 1.1 additions: two-way (Stage 8, authoritative where it differs from §12)

Decision: ADR-018. Header layout unchanged (version 1).

| Item | Rule |
|---|---|
| Streams | **1** = producer microphone (producer → performer), **2** = performer microphone (performer → producer). Any other id: `bad_payload`. |
| One UDP flow | Both streams and all reports travel between the producer's bound media socket and the performer's connected socket (one 5-tuple). No new port and no performer firewall rule. |
| AUDIO flags | bits 0–1 codec (1 = Opus); **bit 2 = sender muted**: the payload is encoded silence and the stream keeps running; bits 3–7 = 0 |
| Direction check | AUDIO / END_OF_STREAM must carry the receiver's *incoming* stream id, and RECEIVER_REPORT the receiver's *outgoing* stream id. Otherwise `wrong_stream`: dropped and counted (e.g. a side's own stream coming back). |
| Reports | Whoever receives a stream reports on it every 500 ms (header `stream_id` = that stream). The producer now also reports (on stream 2). Flag bit 0 = "playing" (the receiver's *hear* switch), bit 1 = closing. |
| Peer learning | Producer: the performer endpoint is learned from **any** valid datagram from the performer's control IP. Performer: fixed peer (connected socket). |
| Reachability | Send while a valid datagram arrived within 3 s **or** the control link is Connected, unless the peer sent a closing report. One failed direction does not stop the other while control is up. |
| Sequence numbers | Start at 0 when the endpoint starts and **continue across pauses** (send off/on, peer unreachable). A step back of ≥ 64 counts as a stream restart (`stream_restarts`), not as duplicates. |
| Jitter buffer | Adds **catch-up** (more than target + max(8, target) held → drop to the target, `catchup_frames`) and **resync** (3 consecutive late arrivals → refill, `resyncs`) |

## 14. Control protocol 1.1 additions (Stage 9, authoritative where it differs from §11)

Decision: ADR-019. **1.1 = 1.0 plus optional fields.** A 1.0 peer ignores them (unknown tags are ignored), and differing minors are accepted (§7).

| Addition | Rule |
|---|---|
| Tag 33 `ReadyChecks` (str) in READY_STATUS | The readiness checklist as `id=0\|1` pairs, e.g. `input=1,engine=1,folder=1,disk=1,idle=1,consent=1,link=1,clock=1`. Unknown ids are skipped. |
| Tag 8 `SessionId` on ARM, ARM_ACK, SCHEDULE_START, START_ACK, TAKE_STARTED, CANCEL, STOP_SCHEDULE, STOP_ACK, LOCAL_STOP, TAKE_FINALISED | If present it must equal the session's id, otherwise refused with ERROR `UnknownTake` ("session id mismatch") and counted. If absent (a 1.0 peer), the message is accepted as before. |
| Command id | The frame's `msg_id` (strictly increasing per connection). Acknowledgements and refusals echo it in `ref_id`. |
| Start lead | Producer setting 300–10 000 ms (default 1000). Record is refused below `ARM_ACK margin + 2·RTT + 2·u + 200 ms`. |
| Stop before the start | The producer sends CANCEL (`Cancelled`) in Armed/Scheduled. Within 150 ms of the start it stops right after the start instead. A CANCEL reaching a performer that is already recording = stop and save. |
| Stop while stopping/finalising | The producer refuses locally. A duplicate STOP_SCHEDULE is answered idempotently. |

Timing record: each PC logs one `take_timing` JSONL record per take (ADR-019). It uses that PC's monotonic clock and never mixes clocks, except in the producer's start-offset *estimate*, which is converted with θ.

## 15. Control protocol 1.2 and the take-transfer connection RRXF v1 (Stage 11, authoritative)

Decision: ADR-020. **1.2 = 1.1 plus two messages and three optional tags.** The producer sends TRANSFER_REQUEST only when the agreed minor version (min of both HELLOs) is 2 or more. A 1.1 performer would treat an unknown message type as an error (§5), so it is never sent one.

| Addition (control link) | Rule |
|---|---|
| `TRANSFER_REQUEST` 0x0060, S→R | Required: TakeId, `TransferPort` (tag 34, u16), `TransferToken` (tag 35, 32 hex, **never logged**), plus SessionId (1.1 rule). Sent only for a take whose TAKE_FINALISED arrived, never while a take is armed/scheduled/recording. |
| `TRANSFER_ACK` 0x0061, R→S | Required: TakeId, Accepted. Refusal codes: `TransferRefused` (no delivery consent), `Busy` (recording, or another transfer running), `UnknownTake` (no finalised file), `ProtocolMalformed`. |
| Tag 36 `DeliveryConsent` (u8) in READY_STATUS | The performer allows copies of its takes (XFER-05). Absent = not allowed. |
| Error code 23 `E_TRANSFER_INVALID_FILE` | The received copy's hash matched but it is not a complete WAV matching the offer and TAKE_FINALISED. |

**Transfer connection:** TCP from the performer to the producer's selected interface, port = control port + 2 (52002). One connection at a time, only from the joined performer's address. Frame: `u32 length (4 .. 65 580) | u16 type | u16 0 | payload`, big-endian, every payload checked to its exact length.

| Type | Dir | Payload | Notes |
|---|---|---|---|
| 1 HELLO | R→P | u32 magic "RRXF", u16 version 1, 8 B session id, 32 B token, u32 take | Wrong session, unknown take or wrong token: ABORT, nothing written |
| 2 OFFER | R→P | u32 take, u64 bytes, u32 chunk bytes (1024–65536), u32 chunks, 32 B SHA-256 (file), u32 rate, u16 channels, u16 bits, u16 WAV format tag, u64 frames, u8 take status, u16 n + name (≤ 128, display only) | Checked against TAKE_FINALISED frames; a later OFFER must equal the first |
| 3 RESUME | P→R | u32 take, u32 next chunk needed, u16 code (0 = go), u16 n + text | next > 0 = resume from the journal |
| 4 CHUNK | R→P | u32 index, u32 n (1–65536), 32 B SHA-256 (chunk), n bytes | Must arrive in order; length must match its position |
| 5 ACK | P→R | u32 next chunk expected | After flush + journal (every 16 chunks and at the end) |
| 6 NACK | P→R | u32 resend-from index, u16 reason | Chunk hash mismatch; the producer drops chunks (and a DONE) until the resent one arrives |
| 7 DONE | R→P | u32 take | All chunks sent |
| 8 RESULT | P→R | u32 take, u16 code (0 = VERIFIED, `TransferHashMismatch`, `TransferInvalidFile`, …), u8 already-verified, u16 n + text | VERIFIED only after the whole-file SHA-256 of the bytes on disk and the WAV checks pass |
| 9 ABORT | either | u16 code, u16 n + text | The sender closes the connection |

Timeouts (prov.): HELLO/OFFER 5 s; no data while receiving 10 s; performer reply 10 s; producer keeps a QUEUED or PAUSED transfer 60 s; performer retries every 1 s for up to 60 s. Retry after a whole-file mismatch: once, from chunk 0.
