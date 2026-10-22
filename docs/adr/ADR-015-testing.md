# ADR-015: Testing uses Catch2 v3.16.0 (test-only) plus the acceptance tests

- **Status:** Proposed · **Traces:** T-16 (E-UNIT), ADR-001

## Decision
- **Catch2 v3.16.0** (released 25 Aug), not v3.16.1 (released 8 Oct, only 3 days before this decision).
  - BSL-1.0 licence. Catch2 v3 requires C++14.
  - Link `Catch2::Catch2WithMain`. Fetch it by tag with a hash.
- **Test-only:** never linked into a deployed exe, so it adds no deployment licence obligation.
- **`rr_core` unit tests:**
  - SPSC ring;
  - WAV writer, including a simulated crash, `.partial` recovery and the no-overwrite rename;
  - media header and CRC (including the check value `0xCBF43926`);
  - control TLV codec (malformed and truncated input, fuzz loop);
  - jitter buffer (the Rust prototype's 6 cases, plus underrun, rebuffer and drift skip);
  - **every valid and invalid transition** of both state machines;
  - clock-offset maths;
  - T→sample mapping.
- **Integration:** both apps running on one PC (T-19), plus the tone-integrity check (VER-03).
- **Acceptance:** PP1_ACCEPTANCE_MATRIX on two PCs.
