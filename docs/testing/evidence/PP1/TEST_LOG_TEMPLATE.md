# PP1 test log — TEMPLATE

**This file is a blank form. It is not evidence.** Copy it to
`docs/testing/evidence/PP1/<YYYY-MM-DD>/TEST_LOG.md` on the day of the run and fill it
in as you go. Do not pre-fill any result, and do not mark a test PASS from a one-PC
rehearsal — §1 of the acceptance matrix requires two physical PCs.

Procedures and pass conditions: [../../../requirements/PP1_ACCEPTANCE_MATRIX.md](../../../requirements/PP1_ACCEPTANCE_MATRIX.md)

## Environment (fill in before testing)

| Item | Value |
|---|---|
| Date / time | |
| Build commit (`git rev-parse HEAD`, clean tree) | |
| Build configuration | MSVC v143 / Qt 6.11.3 / Release / preset `msvc-x64` |
| PC-P (producer): model, OS build | |
| PC-P audio devices (input / output), sample rate | |
| PC-P IP | |
| PC-R (performer): model, OS build | |
| PC-R audio devices (input / output), sample rate | |
| PC-R IP | |
| Network: router model or direct cable, wired / Wi-Fi | |
| Both network profiles set to Private | yes / no |
| Both apps allowed through Windows Firewall (Private) | yes / no |
| Headphones on both PCs | yes / no |
| Deployed as a folder, no dev tools on either PC | yes / no |
| Testers (initials) | P: ____  R: ____ |

## Results

Record exactly what happened. `NOT RUN` is a valid and honest result; a guess is not.

| Test | Covers | Result (PASS / FAIL / NOT RUN) | Evidence path | Notes | Initials P / R |
|---|---|---|---|---|---|
| T-01 Launch and identity | APP-01/02, SEC-01 | | `T-01/` | | |
| T-02 Device selection | DEV-01/02/05 | | `T-02/` | | |
| T-03 No device / won't open | DEV-03/05, ERR-01 | | `T-03/` | | |
| T-04 Mic privacy / mute | DEV-04, ERR-01 | | `T-04/` | | |
| T-05 Pairing and refusals | SES-01/02/03, STA-02 | | `T-05/` | (e) uses `tools/fault/send_bad_packets.py --case hello-bad-version` | |
| T-06 Consent and readiness | STA-03, SES-04 | | `T-06/` | | |
| **T-07 Coordinated take with live talk** | REC-01/03/04/08, SES-05/06/07, COM-01 | | `T-07/` | panel-critical; 3 takes of 60 s | |
| T-07b ARM not acknowledged | SES-05 | | `T-07b/` | block PC-R's control port after pairing | |
| **T-08 Local recordings unaffected by live loss** | REC-07, ERR-04, COM-02 | | `T-08/` | panel-critical; 10 % injected loss | |
| T-09 Control link lost during a take | ERR-03, STA-01/02 | | `T-09/` | | |
| T-10 Shutdown during a take | ERR-05/08, REC-03 | | `T-10/` | | |
| T-11 Disk space and write errors | REC-09, ERR-02/08 | | `T-11/` | needs the VHD steps, admin | |
| T-12 Bad packets | COM-03, SEC-02/03, ERR-07 | | `T-12/` | `send_bad_packets.py --case all` from a non-peer address | |
| T-13 Device lost during a take | ERR-06 | | `T-13/` | | |
| T-14 Performer withdraws | SES-08, STA-05 | | `T-14/` | | |
| T-15 Post-session verification | VER-01/02, REC-02/04 | | `T-15/` | run on **both** PCs | |
| T-16 Real-time and honesty review | REC-06, COM-02, SEC-03, RES-01 | | `T-16/` | checklist in matrix §4.2 | |
| T-17 Telemetry export (SHOULD) | TEL-02/04, COM-06/07 | | `T-17/` | | |
| T-18 Take delivery (COULD) | XFER-01/02/03/05 | | `T-18/` | one-PC runs already filed; this is the two-PC run | |
| T-19 Single-PC rehearsal (SHOULD) | APP-03 | | `T-19/` | not evidence for the panel statement | |

**Outcome:** PP1 is ACCEPTED only if every MUST test above (T-01 … T-16 plus T-07b)
passed on two physical PCs. Otherwise write **PARTIAL** and list the tests that failed
or were not run.

```
Outcome: ____________________
Tests failed or not run: ____________________
```

## Measured numbers (T-07 — reported, not judged)

| Take | Clock offset (ms) | Uncertainty (ms) | Best control RTT (ms) | Start lead used (ms) | Estimated start offset (ms) | Frames PC-P | Frames PC-R |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |

No threshold applies to these figures (OQ-06). They are the measurement and its stated
uncertainty, nothing more. Alignment accuracy was **not** measured at PP1.

## Participant statement (T-07)

> "I heard the other person live in every take."

P: ____________  R: ____________

## Limitations presented with the demo

Copy §6 of the acceptance matrix here and add anything this run revealed, including the
Stage 12 note that the link-adaptive constants are validated only if this run used a
real wireless link.
