# ADR-019: Coordinated recording: readiness checklist, scheduled start/stop hardening, timing record

- **Status:** Implemented in Stage 9 (11 Oct 2026). Awaiting the researcher's review.
- **Builds on:** ADR-010 (time model), ADR-016 (control transport) and the Stage 6 two-step start (PROTOCOL_OVERVIEW §11).
- **Control protocol 1.1:** additive and optional; see PROTOCOL_OVERVIEW §14. A 1.0 peer still interoperates, because unknown tags are ignored and the minor version may differ (§7).
- **Traces:** SES-01…SES-12, REC-09, ERR-03, RES-01, BRIEF (sync honesty), D-67…D-76

## Context
Stage 9 asks for the central panel workflow. Most of it already existed after Stage 6:
- ARM → ARM_ACK → SCHEDULE_START → START_ACK;
- TAKE_STARTED only after the recorder really started;
- STOP_SCHEDULE / STOP_ACK / TAKE_FINALISED;
- the clock offset from 16 four-timestamp samples (minimum δ, u = δmin/2);
- start offset ± u.

The gap analysis found these missing:
1. a per-item readiness display on both PCs, including passing items;
2. explicit "folder writable" and "engine healthy" checks;
3. a session id on the commands;
4. a configurable start lead with a stated minimum;
5. stop-before-start;
6. stop during finalisation;
7. a complete per-take timing record;
8. the performer's countdown, scheduled time and "controlled by" display;
9. per-PC "scheduled / recording / saved" rows.

## Decision
- **Readiness checklist** (`rr/control/Readiness.h`), all items mandatory:

  | Item | Pass condition |
  |---|---|
  | Input device open | an input device is open |
  | Audio engine healthy | capture callback within the last 500 ms, no device fault, required rate |
  | Recording folder writable | a probe file is written and deleted |
  | Enough disk space | the longest allowed take (1800 s) at the device format + 1 MB (REC-09) |
  | No other recording active | the local recorder is idle |
  | Consent given | the performer's consent tick is its explicit **arm action** |
  | Connected | control link up |
  | Clock offset measured | performer only: ≥ 3 offset samples |

  - The performer's items travel to the producer in READY_STATUS (new tag `ReadyChecks`, "id=0|1" pairs). Both PCs show both lists.
  - The producer refuses Record while any mandatory item fails on either PC (as before; now itemised).
- **Command identity:** every command and acknowledgement carries the **session id** (tag `SessionId`, now also on ARM … TAKE_FINALISED). A mismatch is refused (`UnknownTake`, "session id mismatch") and counted.
  - The **command id** is the frame's `msg_id`. It strictly increases per connection, and acknowledgements echo it in `ref_id` (unchanged since §11).
- **Start lead:** configurable, 300–10 000 ms (default 1000 ms).
  - **Minimum** = ARM_ACK margin (100 ms) + 2 × control RTT + 2 × u + 200 ms. The 200 ms covers the UI and link polling on both PCs.
  - Record is refused below the minimum. The rule is provisional; it is stated here and shown in the UI.
  - **Superseded in part by ADR-022 (Stage 12):** the RTT term is the *smallest* round trip of the
    offset window, not the latest, so one slow heartbeat can no longer have a take refused; and the
    producer chooses the lead for the measured link by default (`auto_start_lead`), never below the
    value set by hand.
- **Stop before the start:** Stop in Armed/Scheduled sends **CANCEL** (`Cancelled`) and cancels the local schedule, so both PCs return to Ready and nothing is written.
  - Within 150 ms of the start, the producer instead stops right after the start, because its recorder may already be starting.
  - A CANCEL that reaches a performer already recording is treated as a stop: the take is saved, not thrown away.
- **Stop during stopping/finalisation:** refused with a message. A duplicate STOP_SCHEDULE at the performer is answered idempotently (as before).
- **Late and replayed commands** (as before, now with explicit tests): a converted start less than 100 ms ahead is refused (`ArmTooLate`); a take id not above the last one is refused (`TakeIdConflict`); a SCHEDULE_START or STOP for an unknown or finished take is refused.
- **Disconnect before the start:** a link loss in Armed/Scheduled cancels the take on both PCs (A-3), and each PC flags it cancelled and logs its `take_timing` record (D-76).
  - **Limit:** a *silent* link loss is only detected after 3 s without frames. If it happens less than 3 s before the start, the take may start, and the recordings then continue under ERR-03.
- **Timing record:** each PC keeps the following per take and logs it as one `take_timing` JSONL record:
  - command send, receipt and acknowledgement times;
  - the scheduled start in local time;
  - the first sample's estimated time and frame index, and late frames;
  - stop command time and stop time;
  - finalisation time and frames;
  - device period;
  - θ, u and the number of samples used.

  `tools/audit/analyse_take_timing.py` tabulates the producer's and the performer's records together.
- **Display:**
  - **Performer:** "Session controlled by …", a countdown and the scheduled time (local clock, wall-time estimate). "RECORDING on this PC" appears only after its recorder reported the start.
  - **Producer:** per-PC rows (scheduled / RECORDING / saved / UNKNOWN); the performer row moves on only on the performer's own messages. Plus both checklists and the start lead.

## Measured on one PC (two processes; real input device; see the Stage 9 evidence)
Both processes share one monotonic clock (QueryPerformanceCounter), so the true clock offset is 0 and the first-sample times can be compared **directly**.

Over 5 coordinated takes (5.3 s each, 1000 ms lead, two-way live audio running):
- **Measured start difference:** mean +0.007 ms, range −0.027 … +0.050 ms.
- **Producer's estimate:** within 0.027 ms of the measurement, with reported u of 0.013–0.040 ms.
- **θ estimate error:** 0.003–0.028 ms (true value 0).

These numbers describe the **callback timelines** of one device opened twice on one PC. They do **not** include device input latency and are **not** a two-PC or acoustic alignment result. "Sample-accurate alignment" is not claimed.

## Consequences and limits
- **Two PCs:** not run. The acceptance criterion ("two physical PCs") is open.
- **Real inter-PC offset error and drift:** not measured. The actual alignment residual needs a shared reference signal recorded on both PCs and cross-correlation (LATER-04).
- **The minimum-lead rule is provisional:** it is not derived from measured worst cases on a real LAN.
