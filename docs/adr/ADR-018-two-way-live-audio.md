# ADR-018: Two-way live audio: one media endpoint per side, both streams on one UDP flow

- **Status:** Implemented in Stage 8 (11 Oct 2026). Awaiting the researcher's review. Extends [ADR-017](ADR-017-one-way-live-audio-opus-udp.md).
- **Control protocol:** unchanged (PROTOCOL_OVERVIEW §11).
- **Media:** header v1 unchanged in layout. Additions are in PROTOCOL_OVERVIEW §13.
- **Traces:** COM-01, COM-02, COM-03, COM-04, COM-05, COM-06, DEV-07, ERR-07, LATER-03, D-58…D-66

## Context
Stage 8 asks for full duplex with:
- distinct streams and counters per direction;
- separate send mute, receive mute and gain;
- five status rows shown separately;
- tolerance of one direction failing;
- tests for duplicate audio, feedback, excessive buffering and device changes;
- one-page diagnostics;
- the master recordings untouched by received audio.

## Decision
- **One `LiveEndpoint` per side** (`libs/media`): one UDP socket and one media thread with at most one outgoing and one incoming stream.

  | | Producer | Performer |
  |---|---|---|
  | Socket | bound to its selected interface : media port (control port + 1) | **connected** to producer : media port |
  | Sends | stream 1 (producer microphone) | stream 2 (performer microphone) |
  | Receives | stream 2 | stream 1 |
  | Reports | about stream 2, to the performer | about stream 1, to the producer |

  - Both directions share **one UDP flow**, so the performer PC still needs no inbound firewall rule. The producer's single documented rule, UDP on the media port, covers both directions.
- **Parts:** `OutgoingStream` (tap → Opus → datagrams) and `IncomingStream` (validated datagrams → arrival statistics → 64-slot queue → jitter buffer → decode/PLC → gain, added in the playback callback). These are the Stage 7 code, moved, not rewritten.
  - The Stage 7 classes `LiveSender` and `LiveReceiver` are kept as thin wrappers, so the Stage 7 tests run unchanged against the new code (regression).
- **Direction checks:** AUDIO and END_OF_STREAM must carry the incoming stream id, and reports must carry the outgoing stream id. Anything else is dropped and counted as `wrong_stream` (for example this side's own stream coming back).
- **Mute is not stopping:**
  - **Send off:** END_OF_STREAM; nothing sent.
  - **Send mute (talkback mute, COM-04):** the stream continues, carrying encoded silence with header flag bit 2 = muted. The other side shows "remote MUTED", not a network failure. The capture tap keeps being drained, so the timing stays continuous.
  - **Receive mute ("hear" off):** nothing is played, but the stream is still received, counted and reported. The sender sees "remote has hearing switched off" from the report flag.
  - **None of these reach the recorder.** The master is written from the record ring (ADR-007). The live tap is a separate ring, and received audio only goes to the output.
- **Talkback mode:** continuous two-way talkback with per-side mute. There is **no push-to-talk**, because no requirement asks for one (COM-01, COM-04).
- **Reachability (asymmetric failure):** a side sends while the peer is *reachable*. That means a valid datagram from it arrived within 3 s, **or** the session's control link is Connected.
  - So a direction that fails completely does not stop the other, as long as the control channel is up.
  - A closing report stops sending at once.
  - Without the control link and without datagrams, a side stops: no blind sending.
- **The sequence number continues for the endpoint's lifetime.** After a pause, the resumed packets continue the old numbering.
  - **Restart rule:** a step back of ≥ 64 packets (the jitter-buffer window) is treated as a restarted stream, not as duplicates.
  - Found by run D4b, where a restarted stream was dropped as "duplicates" for about 9 s.
- **Jitter buffer additions (ADR-011):**
  - **Catch-up:** more than target + max(8, target) frames held → drop down to the target at once (`catchup_frames`). This bounds the delay after a playback stall; otherwise it would take about 30 s to remove 300 ms.
  - **Resync:** 3 consecutive late arrivals → refill from the arriving packet (`resyncs`). The sender paused; found by run D5, where a 60 ms input re-open cost 20 underruns and 18 late packets, now 4 and 3.
- **Echo cancellation: NOT implemented** (LATER-03).
  - Headphones are required and stated in the UI.
  - Feedback and duplicate audio are **detectable**: own-stream packets are counted as `wrong_stream`, and `tools/audit/analyse_live_duplex.py` finds a side's own tone in what it hears. Neither of these prevents feedback.
- **Diagnostics:** `live_report_text()` writes one page with conditions, the five status rows, OUTGOING (measured here plus the remote's report) and INCOMING (measured here). The apps (Live audio panel → Export) and the probe (`--report`) use the same function.

## Measured on one PC (two processes, test clocks; see the Stage 8 evidence)
- **Round trip through both directions:** a side's own test burst came back via the other side's echo source.
  - 55 ms with a 3-frame jitter buffer on both sides, 165 ms with 8 frames (final runs; an earlier run of this stage gave 155 ms with 8 frames).
  - The added delay (110 ms) is close to the expected 2 directions × 5 extra frames × 10 ms = 100 ms; the remainder was not analysed further.
  - This is the **software** path: encode, loopback network, both jitter buffers, both 10 ms test clocks. It is not acoustic latency, because no devices or converters are involved.
- **Both directions together:** 0 lost and 0 underruns over about 14 s, and each side heard only the other's tone (share 0.000 of its own).

## Consequences and limits
- **Two PCs:** not tested. "Both users can hear each other" (the acceptance criterion) needs the two-PC run, LIVE_AUDIO_TEST_PROTOCOL §5.
- **Clock offset:** still from TCP heartbeats; the UDP probes (ADR-010) are not built.
- **Real clock drift** between two PCs was not observable on one PC.
- **Security:** LAN-only, unencrypted, unauthenticated (ADR-012).
