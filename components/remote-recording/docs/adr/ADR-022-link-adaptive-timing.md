# ADR-022: One build for a cabled LAN and for Wi-Fi — link-adaptive timing

- **Status:** Implemented in Stage 12 (19 Oct 2026). Awaiting the researcher's review.
- **Builds on:** ADR-010 (four-timestamp clock offset), ADR-016 (Qt-free control sockets),
  ADR-019 (coordinated recording and the start-lead minimum).
- **Traces:** SES-05, STA-01/04, REC-02, NET-02, D-95…D-99

## Context
Every coordinated-recording test so far ran with both apps on one PC over `127.0.0.1`: round trip
about 0.1–0.3 ms, no loss, no jitter, and one shared monotonic clock. Three constants chosen
against that link are too tight for a real wireless one, and all three were invisible on loopback.

1. **The clock-offset sanity ceiling was 100 ms.** `ClockOffsetEstimator` discarded any heartbeat
   whose round trip exceeded it. An ordinary shared Wi-Fi link runs at 50–300 ms, and a laptop
   adapter waking from power saving is worse. Every sample could therefore be rejected,
   `sample_count()` never reached `min_offset_samples` (3), and the performer stayed **not ready**
   for ever, reporting "measuring clock offset to the producer". The producer could never record.
2. **The minimum start lead used the latest round trip.** `min_start_lead_ms()` is
   `margin + 200 ms + 2·RTT + 2·u`. Taking RTT from the *most recent* heartbeat meant one slow
   heartbeat arriving just before the producer pressed Record pushed the minimum above the
   configured 1000 ms lead and the take was refused — while pressing again a second later worked.
   Intermittent, and indistinguishable from a broken application.
3. **The link was declared lost after 3 s** of silence, i.e. three missed heartbeats. A wireless
   adapter roaming between access points or leaving power saving stalls for longer than that, so a
   link that was merely slow was torn down.

## Decision
- **The offset ceiling is a sanity limit, not a quality filter: 100 ms → 1 s.** The estimate is
  already the *best* sample of the window, so a slow sample cannot pull `theta`; it only occupies a
  slot until a better one replaces it. Rejecting slow samples therefore bought nothing and cost the
  measurement entirely. Link quality is still expressed honestly — through the reported
  uncertainty, and so through the minimum start lead — rather than by refusing to measure. A round
  trip over 1 s is a stalled link and is still rejected and counted.
- **`LinkStats` gains `control_rtt_best_ns`**, the smallest round trip in the offset window: the
  delta of the very sample `theta_ns` came from. `control_rtt_ns` (the latest) is unchanged and
  still shown in Diagnostics.
- **`min_start_lead_ms()` uses the best round trip, not the latest.** The two terms of the formula
  now describe the same sample, and the figure no longer swings with every hiccup.
- **The producer sizes the start lead for the link it measured** (`auto_start_lead`, on by
  default): `effective_start_lead_ms() = clamp(max(min_start_lead + 250 ms, configured), 300,
  10000)`. A cabled LAN keeps a short lead; a wireless link gets a longer one; the user does not
  have to know what a scheduling lead is. It **never goes below** the value set by hand, so raising
  the spin box still works, and it can be turned off to pin the lead for a timing experiment. The
  lead is fixed once per take at `start_take()` and the schedule and the evidence log both use that
  one value.
- **`link_lost_after_ms` 3000 → 6000.** Six seconds still detects a genuine loss well inside the
  finalise window.
- **The producer's panel shows the measurement in words**: best round trip, number of offset
  samples, clock-offset uncertainty, the minimum lead and the lead the next take would use.

## Verified (19 Oct 2026)
- `ctest` **175/175**, seven consecutive runs (MSVC x64 Release). One earlier invocation printed
  "Errors while running CTest" without naming a test; it did not recur in the seven runs that
  followed and was not identified.
- `ctest` **173/173** on the Qt-free GCC core preset.
- GUI end-to-end automation (`tools/gui_test/gui_e2e.ps1`): **PASS** — sound, session, join, both
  ready, take recorded (334 077 frames on both PCs), copy **VERIFIED**.
- `check_sources` 150 files, 0 problems.
- New tests: a 60–90 ms round trip is now measured instead of rejected; a 1.5 s round trip is still
  rejected; `best_delta_ns()` is the sample the estimate came from and not the latest; the
  automatic lead clears the measured minimum, is never lowered below a hand-set value, and is the
  value recorded on the take; a hand-pinned lead below the minimum is still refused.

## Consequences and limits
- **Not measured on a real wireless link.** Every number above comes from loopback and from unit
  tests with synthetic timestamps. The constants are now *plausible* for Wi-Fi; they are not
  *validated* on Wi-Fi. That needs the two-PC run (T-07, T-08), which is still **NOT RUN**.
- **A genuine link loss is now noticed up to 6 s later** instead of 3 s. Local recording on both
  PCs is unaffected either way — each writes its own master file (REC-02) — but the producer's
  "connection lost" notice, and any take cancelled by it, arrive later.
- **An automatic lead makes the delay between pressing Record and the start depend on the link.**
  On a poor link the countdown may be noticeably longer, which is honest but may surprise a user.
  The panel states the figure and why.
- **A 1 s ceiling admits samples with very large uncertainty.** They cannot corrupt the estimate,
  but on a bad link the reported uncertainty — and therefore the lead — grows, and on a very bad
  link the lead hits the 10 s clamp and Record is refused with "below the minimum". That is the
  intended honest failure, not a silent bad schedule.
- **Clock-rate drift between two PCs is still not corrected.** The offset is re-estimated
  continuously, but a take started in sync may drift over its length. Unmeasured; it cannot be
  measured on one PC.
