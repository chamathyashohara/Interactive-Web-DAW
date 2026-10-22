# Assumptions and Open Questions

**Stage 1 · 11 October 2026.** If an assumption proves false, the requirements
that depend on it are reviewed. Open questions need an answer from the
**researcher (R)**, the **supervisor (S)** or the **panel (P)** before the stage named.

## 1. Assumptions

| ID | Assumption | Requirements that depend on it | If it's false |
|---|---|---|---|
| A-01 | Two physical Windows 10/11 x64 PCs are available for testing before PP1 | All MUST tests | PP1 can only be PARTIAL (single-PC rehearsal, T-19) |
| A-02 | Both PCs are on a **controlled, trusted LAN** (own router or cable), with both network profiles Private and the apps allowed through the firewall | COM-01, SES-01/02, SEC-01 | Campus networks often block laptop-to-laptop traffic. Bring the router or cable. |
| A-03 | Exactly **one producer and one performer** | SES-02, all of UC-01…UC-10 | More participants are LATER-06 |
| A-04 | **Both people wear headphones** | COM-01, LATER-03 | With speakers there is feedback. Echo cancellation is out of scope. |
| A-05 | Mono microphone input is enough for PP1 | REC-02 | See OQ-12 |
| A-06 | Both devices can run at **48 kHz** in Windows shared mode | DEV-05, REC-02 | See OQ-11 |
| A-07 | Recordings go to a local NTFS drive with enough space (REC-09) | REC-03, ERR-02 | — |
| A-08 | The demo participants are the researcher and a partner who have agreed to take part. **This is a system test, not a study with participants.** | STA-03, OQ-09 | Ethics clearance is needed for anyone else (RO §3.5) |
| A-09 | The toolchain (MSVC + Qt) will be installed before implementation starts | APP-01 | See OQ-04/05. The Stage 0 audit found neither. |
| A-10 | Only the live stream may be lossy. Local master files never pass through the network. | REC-01, REC-07 | Not negotiable (PANEL, BRIEF) |
| A-11 | The PP1 demo date is about **20 October 2026** (chat record §1, "confirm the exact day") | Scope trade-offs | See OQ-08 |

## 2. Open questions

| ID | Question | Who | Needed before | Affects | Current proposal |
|---|---|---|---|---|---|
| OQ-01 | Can the `claude/component4-*.md` notes and proposal "Revision 3" be supplied? (Not found in Stage 0.) | R | Stage 2 | Trace completeness | Proceed on proposal v2 + chat record + brief |
| OQ-02 | **If the control link drops during a take, should the performer keep recording or stop?** (D-11) | R / S | Implementing ERR-03 | ERR-03, T-09, UC-09 | **Keep recording**, which protects the master |
| OQ-03 | Live codec for PP1: PCM16 first, or Opus from the start? (D-08) | R | Implementing COM | COM-07, bandwidth | PCM16 for PP1 (already proven in the prototypes), Opus next |
| OQ-04 | Toolchain: exact MSVC 2022 (v143) or VS 2026's default v145? (D-12) | R | Stage 2 | APP-01, E-BUILD | v143 via VS 2022 Build Tools |
| OQ-05 | Accept Qt 6 LGPL-3.0 with dynamic linking? (D-06) | R / S | Stage 2 | APP-01 UI | Yes for an academic prototype |
| OQ-06 | Does the panel or supervisor expect **measured alignment or latency numbers** at PP1, or is "measured and disclosed, not judged" enough? | S / P | PP1 test plan freeze | TEL-03, LATER-04/10 | Report the estimates only. No threshold. |
| OQ-07 | Does PP1 need the **two GUI apps**, or would the panel accept the terminal prototype if the apps aren't ready? | S | Now (it drives the schedule) | APP-01, the whole matrix | The matrix targets the apps. The prototype is a declared fallback, not a pass. |
| OQ-08 | The exact PP1 date | R | Now | Scope trade-offs | About 20 Oct 2026 |
| OQ-09 | Ethics: does a demo with a partner need clearance, and what is the status of the clearance application (RO §3.5)? | S | Before any test with someone other than the researcher's agreed partner | STA-03, LATER-09 | Treat PP1 as a system test with an agreed team member |
| OQ-10 | Take delivery consent: once per session or per take? | R | Only if XFER is built | XFER-05 | Per session, shown in the consent notice. **Stage 11: implemented as proposed (per session, explicit performer checkbox, default off; D-83). Open for review.** |
| OQ-11 | Support 44.1 kHz devices (resample the live stream only, record the master at its native rate) or require 48 kHz? | R | Implementing DEV-05 | DEV-05, REC-02 | Require 48 kHz for PP1 |
| OQ-12 | Is mono enough for the performer's master (for example a stereo instrument)? | R | Implementing REC | REC-02 | Mono for PP1 |
| OQ-13 | Planned maximum take length (sets the REC-09 disk check) | R | Implementing REC-09 | REC-09 | 30 min (prov.) |
| OQ-14 | Should the producer's app also record the **monitor** (what the producer heard)? (REC-11 SHOULD) | R | — | REC-11 | Yes, labelled as monitor |
| OQ-15 | What hardware and network produced the 9 Oct prototype takes (≈295 ms wall-clock offset)? | R | Before citing them | Evidence | Treat as unverified |
| OQ-16 | Proposal RO §3.5 says "encrypted local storage" for participants' audio. Must the test PCs use BitLocker for PP1? | S | Before tests with participants | Data handling | Not for a system test with team members. Required for the study (LATER-09). |
| OQ-17 | Pairing by typed IP and code, or should the producer be found automatically on the LAN? | R | Implementing SES | SES-01/02 | Typed IP + code for PP1. Discovery later. |

## 3. Provisional design defaults (settings, not performance claims)

These numbers are **starting settings**, chosen so the tests can be run. They are
not targets and not measured results. Each one can be changed, and the actual
value used is recorded in the test evidence.

| Parameter | Default | Used by | Basis |
|---|---|---|---|
| Scheduled-start lead time | 1 s floor, raised to fit the link | SES-05 | Must be much larger than the control RTT. Since Stage 12 (ADR-022) the producer raises it to `minimum + 250 ms` for the measured link; the figure below is the floor, not the value used. Not yet validated on a wireless link. |
| ARM_ACK timeout | 2 s | SES-05 | More than the lead time, so a late ACK cancels cleanly |
| Control heartbeat loss detection | 6 s | SES-10, ERR-03 | Was 3 s (ARCHITECTURE §5.2); raised in Stage 12 (ADR-022) because a wireless adapter roaming or leaving power saving stalls for longer than three missed heartbeats |
| Silence detection for "No input signal" | 3 s of digital silence | DEV-04 | Long enough not to trigger during normal pauses at digital zero. Real rooms are rarely digital zero. |
| Maximum planned take for the disk check | 30 min ≈ 346 MB (48 000 × 4 B × 1 800 s) | REC-09 | Arithmetic for float32 mono at 48 kHz. Matches the proposal's 30-min session length. |
| Record buffer | 10 s of audio | REC-05, TST-01c | ARCHITECTURE §3. The C++ prototype's 1 s was judged too small (A0-G5). |
| Live segment / jitter depth | 10 ms / 3 segments | COM-02 | The prototypes' defaults, which worked on loopback |
| Test parameters | 60 s takes, 3 takes, 10 % injected loss, about 10 s outage | T-07…T-09 | Test design choices that match the Stage 0 loopback runs |
