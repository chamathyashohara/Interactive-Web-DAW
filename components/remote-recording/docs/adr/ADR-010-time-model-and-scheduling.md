# ADR-010: Time model: monotonic clock, UDP probe offset estimation, scheduled start, explicit honesty limits

- **Status:** Proposed · **Traces:** SES-05, TEL-03, RES-01, BRIEF (sync honesty), D-10

## Decision
- **Timestamps:** `std::chrono::steady_clock` (QueryPerformanceCounter on MSVC), in nanoseconds, separately on each PC. Wall-clock UTC is only a label in the metadata.
- **Offset:**
  - a four-timestamp UDP probe, repeated (4 Hz, prov.);
  - the estimate θ̂ comes from the probe with the **smallest round trip δ** in a window of the last 16 probes;
  - uncertainty is ±δmin/2.
  - **Each side estimates its own offset.** The performer's estimate converts the producer's start time.
- **Scheduled start:**
  - ARM carries a start time T in **producer** time, with a lead of 1 s (prov.).
  - The performer converts T with θ̂.
  - Each side's **recorder thread** (never the callback) maps T to a sample index. It fits a line through the last 64 (prov.) capture-callback stamps (monotonic time at callback entry, cumulative frames).
- **What this aligns, and what it does not:**
  - It lines up the two *callback-arrival timelines*.
  - It does **not** correct for device input latency, for differences between devices, or for drift during a take.
  - The "estimated recording-start offset" is reported with its uncertainty.
  - The **actual** alignment residual is measured only later, by cross-correlating a shared reference signal (LATER-04, proposal §3.3).
- **Logged now for later drift analysis:** the θ̂ time series and the capture stamps.
