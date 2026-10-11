# Threading and Audio Callbacks

**Stage 2 · 11 October 2026 · draft for review.** Traces: REC-06, REC-05, REC-07, COM-02, ERR-06, TEL-01, T-16.
Decisions: ADR-003, 005, 007, 010, 011.

## 1. Threads (identical in both apps)

| # | Thread | Created by | Real-time? | Owns | Must never |
|---|---|---|---|---|---|
| T1 | **Capture callback** (miniaudio/WASAPI thread) | miniaudio | **Yes** | its capture frame counter | allocate, lock, do file/socket/log/Qt calls, wait |
| T2 | **Playback callback** (miniaudio/WASAPI thread) | miniaudio | **Yes** | the **jitter buffer**, the decoder, the concealment state | same as T1 |
| T3 | Recorder | Engine | No (above normal) | the open master and monitor files, the take plan | touch sockets or the UI |
| T4 | Media send | Engine | No (above normal) | encoder, UDP send side, probe requests | block on disk |
| T5 | Media receive | Engine | No (above normal) | UDP receive side, packet checks, probe replies, arrival-jitter estimator | block on disk |
| T6 | Telemetry | Engine | No | 1 Hz CSV writer, device watchdog | touch audio buffers |
| T7 | Control | `rr_app` (QThread with its own event loop) | No | `SessionController`, `SessionModel`, TCP socket, timers | block on file or engine I/O |
| T8 | UI (main) | Qt | No | widgets only | block on anything; read engine state other than through snapshots |
| T9 | Transfer worker (COULD) | `rr_app` | No | transfer socket, hashing | read or write an open master |

"Above normal" means `THREAD_PRIORITY_ABOVE_NORMAL`. The MMCSS registration
of T1/T2 by miniaudio is **not verified** (ADR-003) and will be checked in I-1.

## 2. Queues: every cross-thread path is bounded

| Queue | Writer → reader | Type | Capacity (prov.) | When full |
|---|---|---|---|---|
| REC ring | T1 → T3 | SPSC float ring (`ma_pcm_rb` or own; both lock-free SPSC) | **10 s** at native rate × channels | callback drops the block, `rec_overrun_frames += n`, records the position → take `has_gaps` (REC-05) |
| Capture stamps | T1 → T3 | SPSC ring of `{t_ns, frames_end}` | 256 entries | overwrite-oldest is **not** allowed. Drop and count. |
| SEND ring | T1 → T4 | SPSC float ring (mono downmix done in T4) | 200 ms | drop, `send_overrun++` (monitor path only) |
| Packet queue | T5 → T2 | SPSC ring of fixed-size packet slots (≤ 1446 B payload each) | 64 | drop, `net_queue_full++` |
| MON ring | T2 → T3 | SPSC float ring | 10 s | drop, `mon_overrun++` (monitor file only) |
| Conceal events | T2 → T3 | SPSC ring of playback sample indices | 4096 | drop, `event_overrun++` |
| Engine commands | T7 → T3/T4/T5 | small mutex-protected queue (no real-time thread involved) | 32 | reject the command with `E_BUSY` |
| Engine events | T3/T5/T6 → T7 | mutex queue, plus `QMetaObject::invokeMethod` (queued) | 256 | drop the oldest *informational* events, never a take-status event (those are reserved slots) |
| Snapshots | T7 → T8 | Qt queued signal carrying a `SessionSnapshot` value | n/a | — |
| Counters | T1/T2/T5 → T6/T7/T8 | `std::atomic<uint64_t>` (relaxed), written by one thread each | — | — |

Ownership rule: the `Engine` object owns every ring, thread and device. Each
ring's type name or a comment states its single writer and single reader.
Threads get references only. `Engine::stop()` is the only place that joins
threads.

## 3. Capture callback (T1): the whole job

```cpp
void onCapture(ma_device*, void*, const void* in, ma_uint32 n) {
    const int64_t t = monotonic_ns();          // QueryPerformanceCounter; no syscall that blocks
    // keep the master as captured: no gain, no conversion
    if (!recRing.tryWrite(in, n)) { recOverrun.add(n, capturedFrames); }
    stamps.tryPush({t, capturedFrames + n});   // for the T->sample mapping (ADR-010)
    if (!sendRing.tryWrite(in, n)) sendOverrun++;
    peakIn.updateMax(peak(in, n));             // atomic, relaxed
    capturedFrames += n;                       // atomic store, relaxed; watchdog reads it
    sendWake.signal();                         // SetEvent (non-blocking); see §5
    cbDuration.updateMax(monotonic_ns() - t);
}
```

**The capture callback knows nothing about takes.** It always feeds the REC
ring. **T3 decides which samples go into a file**, by mapping the scheduled
start and stop times to sample indices. That keeps all the take logic off
the real-time thread, and it means nothing on the network side can reach the
master path.

## 4. Playback callback (T2)

```cpp
void onPlayback(ma_device*, void* out, const void*, ma_uint32 n) {
    const int64_t t = monotonic_ns();
    while (packetQueue.tryPop(slot)) jb.insert(slot);   // bounded: ≤ 64 per call
    jb.render(out, n);       // decode or conceal per frame (ADR-011), bounded work
    monRing.tryWrite(out, n);                            // what the person heard
    jb.drainEventsTo(concealEvents);
    if (talkbackSelfMon) mixSelf(out, n);                // COULD; off by default
    peakOut.updateMax(peak(out, n));
    playedFrames += n;
    cbDuration.updateMax(monotonic_ns() - t);
}
```

Before the peer connects, or with nothing to play, the output is silence and
there is no allocation.

## 5. Why these few calls are allowed in a callback
- `QueryPerformanceCounter` is documented as non-blocking.
- `SetEvent` (from `sendWake.signal()`) is a non-blocking kernel call. The C++ prototype used the same pattern (`ma_event_signal`).
  - Alternative if review rejects it: T4 polls every 2 ms. That costs CPU and up to 2 ms of extra live delay.
- `opus_decode_float` in T2 uses only preallocated state. Its cost is **measured** (`cbDuration`, shown in the telemetry panel), not assumed (ADR-011).
- Not allowed:
  - `printf`, logging, `new`/`malloc`, `std::vector` growth, `std::mutex`, Qt signals, `WriteFile`, `sendto`;
  - `ma_device_start`/`stop`/`uninit` (miniaudio docs: deadlock).

## 6. Start-up and shutdown order
**Start-up:**
1. Create rings (allocate everything).
2. Start T3–T6.
3. Open the capture and playback devices by explicit ID.
4. Start the devices.
5. Start T7 (control) and connect it.

**Shutdown** (also for `UserCloseConfirmed`, after the take is finalised):
1. T7 sends BYE and stops its timers. T4 sends END_OF_STREAM.
2. `ma_device_stop` capture and playback, from T7 (never from a callback). No more callbacks after this returns.
3. Set `running = false`. Wake T3, T4, T5 and T6 (closing the socket unblocks `recvfrom`).
4. Join T4, T5, T6. **Join T3 last**, after it has drained the REC/MON rings and finalised any open file.
5. `ma_device_uninit`, close sockets, `WSACleanup`. Stop T7's event loop. T8 exits.

A forced kill leaves a `.partial`, which is detected at the next start (ERR-05b).

## 7. Recorder thread (T3) loop
- Every 10 ms (prov.):
  - drain the REC ring into `pending`, tracking the absolute capture index;
  - drain the stamps;
  - if a take is Scheduled or Recording, write the frames that fall in [S, E) to the `.partial`;
  - write MON into `monitor.partial`;
  - write conceal events to CSV.
- **T → S mapping:**
  - fit a least-squares line through the last 64 stamps (t_ns against frames_end);
  - S = round(index at T);
  - record the fit residual (RMS ns) as `stamp_residual_ns` (ADR-010).
- Header refresh every 5 s. On stop: patch, `FlushFileBuffers`, rename, write the JSON, emit `LocalFinalised(status)`.
- **Errors:**
  - `WriteFile` fails or the disk is full → `incomplete_disk`;
  - device lost (from T6 or a notification) → write what was captured, then `incomplete_device`.

## 8. Device failure detection
- The miniaudio `stopped` notification (on its own thread) sets an atomic flag and posts `DeviceLost` to T7. It does no other work there.
- **Watchdog (T6):** if the device state is started and `capturedFrames` hasn't changed for 500 ms (prov.) → `DeviceLost(stall)`. The same check runs for playback, but a playback stall only produces a warning and never stops a take.

## 9. Telemetry sampling
- T6, once a second: copy the counters (relaxed loads), compute per-second differences, append a CSV row (TEL-02). Also check the watchdog.
- T7 forwards a snapshot at about 10 Hz (prov.) to the UI. The UI never reads engine memory directly.

## 9b. Stage 5 addendum: local monitoring
The playback callback (T2) currently renders the local monitor bus and the test tone instead of a
jitter buffer. The capture callback (T1) also writes to the monitor ring when monitoring is on.
Both use only preallocated memory and atomics. See `MONITOR_PATH.md` §4–§6. The jitter buffer
replaces or joins this path in the live-talkback stage.

## 9c. Stage 7 addendum: one-way live audio as built (ADR-017)
- **T1 (capture, producer):** also calls `LiveTap::push_capture`, which averages the block to mono and copies it all-or-nothing into an SPSC ring of 32 768 frames. If the ring is full, the whole block is dropped and counted. No kernel call: §5's `SetEvent` is **not** used.
- **T4 (media send, producer):** `LiveSender`'s thread polls the tap with `select(1 ms)` under `timeBeginPeriod(1)`. It encodes with Opus, sends, receives the performer's reports, and trims a backlog above 6 frames.
- **T5 (media receive, performer):** `LiveReceiver`'s thread validates and counts every datagram and pushes it into the 64-slot packet queue. It sends a report every 500 ms.
- **T2 (playback, performer):** renders the monitor bus first. Then, through `AudioEngine`'s *playback contributor* hook, `LiveReceiver::render_add` moves the queue into the jitter buffer, decodes or conceals, applies the gain and **adds** to the output.
  - `detach_playback_contributor()` waits (control thread only) until T2 has left the receiver.
  - The worst `render_add` time is measured (`max_render_ns`).
- **Not built yet:** the MON ring and conceal-event ring (§2), and the probe requests and replies.
- Deviations and measurements: ADR-017.

## 10. Review checklist (T-16; a copy is in PP1_ACCEPTANCE_MATRIX §4.2)
Every function reachable from T1 and T2 is listed with file and line, and
checked against §5.

## 9d. Stage 8 addendum: two-way live audio (ADR-018)
- **T4 and T5 are one thread per side:** `LiveEndpoint`'s media thread. It receives and checks datagrams (incoming stream and reports), encodes and sends the outgoing stream, and sends reports.
  - It waits with `select(1 ms)` under `timeBeginPeriod(1)`.
  - It never touches the record ring or a file.
- **T1 (capture):** unchanged. It feeds the record ring and the live tap. **Send mute** zeroes frames in T4/T5 *after* the tap, so the record path cannot be affected.
- **T2 (playback):** `IncomingStream::render_add` via the playback-contributor hook, as in Stage 7. **Receive mute** makes it drain the queue and add nothing.
- **Bounded queues and their counters** (Stage 8 task 7):
  - tap ring 32 768 frames (`overflow_events/frames`);
  - sender backlog ≤ 6 frames (`backlog_trim_frames`);
  - packet queue 64 (`queue_full_drops`);
  - jitter buffer 64 slots: catch-up above target + max(8, target) (`catchup_frames`), refill after 20 underruns (`rebuffers`), resync after 3 late (`resyncs`);
  - underruns, late, lost and concealed per stream.
