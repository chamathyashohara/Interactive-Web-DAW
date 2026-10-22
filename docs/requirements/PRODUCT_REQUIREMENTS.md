# Product Requirements: Producer Studio and Performer Client

**Stage 1 baseline · 11 October 2026 · status of every requirement: Not started**
(no product code exists yet, see `docs/project/REPOSITORY_AUDIT.md`)

Related: [USE_CASES.md](USE_CASES.md) · [PP1_ACCEPTANCE_MATRIX.md](PP1_ACCEPTANCE_MATRIX.md) ·
[ASSUMPTIONS_AND_OPEN_QUESTIONS.md](ASSUMPTIONS_AND_OPEN_QUESTIONS.md)

---

## 1. The acceptance statement everything traces to

> **PANEL (non-negotiable):** two people record locally on two separate PCs and
> have audio communication between them.
> (PP1 comment sheet: *"remote recording (to local storage) by 2 people and audio
> communication between the two."*)

**Two different things that must not be confused:**

| Term | Meaning | Priority |
|---|---|---|
| **Local recording** | Each PC writes *its own* microphone to a WAV file on *its own* disk. The producer's PC holds the producer's take and the performer's PC holds the performer's take. | **MUST**. This is what the panel statement asks for. |
| **Take delivery** | *After* a take, a **copy** of the performer's file is sent to the producer and verified. The performer's original stays where it is. | **COULD**. An additional workflow, never needed to meet the panel statement. |

## 2. Priority labels (MoSCoW)

| Label | Meaning in this project |
|---|---|
| **MUST** | Needed to demonstrate the panel statement at PP1, or to make that demonstration safe, honest and testable. Every MUST has a reproducible test in the acceptance matrix. |
| **SHOULD** | Reliability and the telemetry that is useful for evaluating the prototype. Aim for PP1, but missing it does not fail PP1. |
| **COULD** | Useful only once the core has been demonstrated |
| **LATER** | Out of PP1 scope by decision: internet/NAT traversal, advanced echo cancellation, commercial DAW features, advanced drift compensation, and anything else listed in §14 |

## 3. Trace sources

| Code | Source |
|---|---|
| **PANEL** | The acceptance statement in §1 |
| **BRIEF** | Researcher's product brief, 11 Oct 2026 (two executables, producer authority, local master, honesty rules) |
| **RO** | Proposal v2: main objective §2.1, FR1–FR10, NFR1–NFR10, ethics §3.5 |
| **A0** | Stage 0 audit finding, for example `A0-G1` = gap G1 in REPOSITORY_AUDIT §4.2 |
| **D-nn** | `docs/decisions/DECISION_LOG.md` |

**Column key:** *Test* = a test ID in the acceptance matrix. *Evidence* = an
artefact code (§15). Thresholds marked **(prov.)** are provisional design
defaults, collected in ASSUMPTIONS §3. They are settings, not performance claims.

---

## 4. Applications (APP)

| ID | Pri | Requirement: user-visible behaviour | Rationale / trace | Test | Evidence | Status |
|---|---|---|---|---|---|---|
| APP-01 | MUST | Two separate executables, **ProducerStudio.exe** and **PerformerClient.exe**, are built from one CMake source tree. Each starts on its own from a deployment folder on a Windows 10/11 x64 PC that has no development tools installed. | BRIEF, D-04. Separate apps stop the roles being confused during a session. | T-01 | E-SCR, E-BUILD | Not started |
| APP-02 | MUST | Each app shows its role, app version and protocol version (title bar and About). If the protocol versions differ, pairing is refused with a message naming both versions. | Mismatched builds on two PCs are a likely demo failure | T-05e | E-SCR | Not started |
| APP-03 | SHOULD | Network ports can be set, so both apps can run on one PC for rehearsal or as a fallback demo | A0 (prototype fallback practice) | T-19 | E-SCR | Not started |

## 5. Devices and microphone availability (DEV)

| ID | Pri | Requirement: user-visible behaviour | Rationale / trace | Test | Evidence | Status |
|---|---|---|---|---|---|---|
| DEV-01 | MUST | Each app lists the input and output devices Windows reports, by their Windows names, and lets the user choose one of each | PANEL (each person records their own mic and hears the other) | T-02 | E-SCR | Not started |
| DEV-02 | MUST | A live input level meter for the selected microphone is shown before and during recording | The user must be able to see that the mic works before a take | T-02 | E-SCR | Not started |
| DEV-03 | MUST | If there is no input device, or the chosen device cannot be opened, the app shows a message naming the device and the reason, sets readiness to **NOT READY**, and keeps running | BRIEF (report device failures) | T-03 | E-SCR, E-APPLOG | Not started |
| DEV-04 | MUST | If the device is open but delivers digital silence for 3 s (prov.), a **"No input signal"** warning appears. It points to the mic mute switch and to Windows *Settings → Privacy & security → Microphone → Let desktop apps access your microphone*. | Windows privacy settings and mute keys can give silence rather than an error (A0: the 10 Oct stats file shows -120 dB input) | T-04 | E-SCR | Not started |
| DEV-05 | MUST | The app shows the device's actual sample rate. If the device cannot run at 48 kHz, it is NOT READY and shows how to set 48 kHz in Windows Sound settings. | D-09, A-06. Prototypes required 48 kHz. | T-02, T-03b | E-SCR | Not started |
| DEV-06 | SHOULD | The last device selection is remembered per PC | Fewer setup mistakes during a demo | T-02 | E-SCR | Not started |
| DEV-07 | SHOULD | A **"Use headphones"** reminder is shown on the device screen | No echo cancellation in scope (LATER-03). Speakers cause feedback. | T-02 | E-SCR | Not started |

## 6. Local recording and safe files (REC)

| ID | Pri | Requirement: user-visible behaviour | Rationale / trace | Test | Evidence | Status |
|---|---|---|---|---|---|---|
| REC-01 | MUST | **Each PC records its own selected input to a local file on its own disk.** The master is never made from the network stream. | PANEL, RO FR2, BRIEF | T-07, T-08 | E-WAV, E-VRF | Not started |
| REC-02 | MUST | Master format: WAV, 32-bit IEEE float, mono, at the device's rate (48 kHz). The format is stated in the take metadata. | BRIEF (original quality, documented PCM/WAV), D-09 | T-15 | E-VRF | Not started |
| REC-03 | MUST | **Safe creation and finalisation.** While recording, the file is `…​.wav.partial`. On stop, the WAV header is completed, the data flushed, and the file renamed to `.wav`. Only then does the UI say **Saved**. File names include the session ID, take number and role, and an existing file is never overwritten. | BRIEF (incomplete files and finalisation errors must be visible), A0-G6 | T-07, T-10b, T-15 | E-VRF, E-SCR | Not started |
| REC-04 | MUST | A per-take metadata file (JSON) records: session ID, take number, role, device name, sample rate, frame count, local start time (monotonic and UTC wall clock), first-sample index, status (`complete` or `incomplete:<reason>`), and the record-path overrun count with sample positions | Needed to check files and analyse alignment later | T-15 | E-JSON, E-VRF | Not started |
| REC-05 | MUST | If the record buffer ever overflows (disk too slow), the lost range is counted and its positions logged. The take is marked **"has gaps"** in both the UI and the metadata. It is never silent. | BRIEF (report overruns), A0-G5 | T-11c (forced with TST-01c), T-16 | E-JSON, E-SCR | Not started |
| REC-06 | MUST | The audio callback does no disk I/O, network I/O, UI calls, blocking logging, locking or allocation. It only uses preallocated bounded queues. | BRIEF core audio rules | T-16 | E-REVIEW, E-UNIT | Not started |
| REC-07 | MUST | **Loss of live-media packets never affects either local recording.** Both keep recording with no gaps and no change of state. | PANEL + BRIEF (the performer records whatever happens to the live stream), RO main objective | T-08 | E-WAV, E-VRF, E-CSV | Not started |
| REC-08 | MUST | **Playback check on both PCs.** After each take the app shows the file path, duration and frame count, and has **Open folder**. The file plays in a standard player (Windows Media Player or Audacity) on the PC that recorded it. | PANEL (show that local recording happened) | T-07 | E-SCR, E-LOG | Not started |
| REC-09 | MUST | Before arming, the app checks free space on the recording drive against the space a take of the planned maximum length needs: 30 min (prov.) × 48 000 × 4 B ≈ 346 MB. If there is not enough, it shows NOT READY with the free and required amounts. | BRIEF (disk failures). Prevents a doomed take. | T-11a | E-SCR | Not started |
| REC-10 | SHOULD | In-app playback of the last take | Faster check than an external player | T-07 | E-SCR | Not started |
| REC-11 | SHOULD | Each side also records a separately labelled **monitor file** (what this person heard live, after concealment) plus a concealment-position log | RO (evaluation data). The prototypes did this. | T-08, T-17 | E-WAV, E-CSV | Not started |

## 7. Session control and states (SES)

| ID | Pri | Requirement: user-visible behaviour | Rationale / trace | Test | Evidence | Status |
|---|---|---|---|---|---|---|
| SES-01 | MUST | The producer creates a session. The app generates a session ID and a pairing code, and shows the producer PC's IPv4 address(es) and port so the performer can enter them. | RO FR1, BRIEF (producer is the authority) | T-05a | E-SCR | Not started |
| SES-02 | MUST | The performer joins by entering the producer's IP and the pairing code. The producer accepts only a matching code. **One performer per session** in PP1. | BRIEF (invite/pair the performer) | T-05a, T-05b | E-SCR | Not started |
| SES-03 | MUST | Failed joins (wrong code, wrong IP, producer not running, firewall blocking, version mismatch) each give a specific message. The user can retry, and nothing crashes. | BRIEF (report refused connections) | T-05b–e | E-SCR, E-APPLOG | Not started |
| SES-04 | MUST | **Readiness.** Each side reports device OK, sample rate OK, disk space OK and consent given. The producer sees both sides' readiness, and **Record is disabled until both are READY**. | BRIEF (check readiness) | T-06 | E-SCR | Not started |
| SES-05 | MUST | **Arm and scheduled start.** Pressing Record sends ARM with a take number and a start time T = now + 1 s (prov.). The performer replies ARM_ACK with its planned local start. Both start writing at their own mapping of T. Without an ACK within 2 s (prov.), or after a NACK, the take is cancelled on both sides with a message. | BRIEF (acknowledgements, scheduled future start). A0-G2: the prototypes had neither. | T-07, T-07b | E-SCR, E-JSON | Not started |
| SES-06 | MUST | **Stop and finalisation.** Stop on the producer sends STOP. Both sides finalise, and the performer reports TAKE_FINALISED (frames, status). The producer shows the performer's take as **Saved / Incomplete / Unknown**. | BRIEF (receive status, take management) | T-07 | E-SCR, E-JSON | Not started |
| SES-07 | MUST | The current session state is shown as text on both apps, using the states in ARCHITECTURE §7: Idle, Listening/Connecting, Connected, Ready/Not ready, Armed, Recording, Finalising, Error | BRIEF (clear recording states) | T-07 | E-SCR | Not started |
| SES-08 | MUST | **The performer cannot start a take on its own.** It can always press **Stop & save** for its own recording, and **Leave session**. The producer is told when either happens. | BRIEF (performer follows the producer's schedule) + consent (STA-05) | T-14 | E-SCR | Not started |
| SES-09 | SHOULD | Take numbers match on both sides, so `takeNN` on both PCs is the same take | Simpler post-session matching | T-07 | E-VRF | Not started |
| SES-10 | SHOULD | A control heartbeat detects a lost control link within 3 s (prov.) | ERR-03 depends on it | T-09 | E-SCR, E-APPLOG | Not started |
| SES-11 | COULD | Automatic reconnection after a lost control link | Convenience | T-09 | E-APPLOG | Not started |

## 8. Live audio communication (COM)

| ID | Pri | Requirement: user-visible behaviour | Rationale / trace | Test | Evidence | Status |
|---|---|---|---|---|---|---|
| COM-01 | MUST | **Both directions:** while connected, each person hears the other's microphone in their headphones, between takes (talkback) and during takes, on a controlled LAN | PANEL ("audio communication between the two"), RO FR3 | T-07 | E-LOG (participant sign-off), E-CSV | Not started |
| COM-02 | MUST | Live audio travels on its own path from recording: UDP packets with sequence number, capture timestamp and CRC, a bounded jitter buffer, and loss concealment **for playback only** | BRIEF (sequence numbers, bounded jitter buffer; concealment is not a repair to the master) | T-08, T-16 | E-CSV, E-REVIEW | Not started |
| COM-03 | MUST | Bad packets (truncated, wrong length, CRC failure, unknown type, unknown session, not from the paired peer's address) are dropped and counted. They never crash the app and never reach a master file. | BRIEF (bad packets), A0-G1 | T-12 | E-CSV, E-SCR | Not started |
| COM-04 | SHOULD | **Mute talkback**: each person can stop sending their mic live without stopping their local recording | The producer may want silence in the performer's ears during a take | T-07 | E-SCR | Not started |
| COM-05 | SHOULD | A volume control for the incoming live audio | Comfort and safety | T-07 | E-SCR | Not started |
| COM-06 | SHOULD | Segment size and jitter-buffer depth can be changed at runtime | RO FR4 (RQ1/RQ2 experiments) | T-17 | E-CSV | Not started |
| COM-07 | SHOULD | Opus codec for the live stream, at legal Opus frame sizes | BRIEF preference, D-08 **(open, OQ-03)** | T-17 | E-CSV | Not started |

## 9. Status visibility and consent (STA)

| ID | Pri | Requirement: user-visible behaviour | Rationale / trace | Test | Evidence | Status |
|---|---|---|---|---|---|---|
| STA-01 | MUST | **Recording status visible to both people.** Each app shows a prominent REC indicator with take number and elapsed time, **and the other side's reported state** (for example "Performer: RECORDING / SAVED / INCOMPLETE / UNKNOWN" and "Producer: RECORDING"). | BRIEF (clearly show whether the take is being saved and is complete) | T-07, T-09 | E-SCR | Not started |
| STA-02 | MUST | Connection state is visible on both apps: Not connected / Connecting / Connected / **Connection lost** | BRIEF (display connection status) | T-05, T-09 | E-SCR | Not started |
| STA-03 | MUST | **Consent.** Before becoming READY, each person sees a notice: their microphone will be recorded **on their own PC** when the producer starts takes, live audio is sent to the other PC, and whether the producer may request a copy of takes (XFER). They must press **I agree**. The consent time is stored in the session metadata, and the producer sees "Performer consented at hh:mm". | RO §3.5 (told audio is recorded, informed consent), ethics | T-06 | E-SCR, E-JSON | Not started |
| STA-04 | MUST | The performer sees each take coming: "Recording starts in 1 s" when ARM arrives, then REC | No surprise recording (consent) | T-07 | E-SCR | Not started |
| STA-05 | MUST | Either person can withdraw at any time (SES-08 for the performer; Stop and End session for the producer). Withdrawing never deletes a file. | RO §3.5 (participants may withdraw) | T-14 | E-SCR | Not started |

## 10. Error paths (ERR)

| ID | Pri | Requirement: user-visible behaviour | Rationale / trace | Test | Evidence | Status |
|---|---|---|---|---|---|---|
| ERR-01 | MUST | **No device:** see DEV-03 and DEV-04 | BRIEF | T-03, T-04 | — | Not started |
| ERR-02 | MUST | **Disk full or write error during a take:** writing stops, the `.partial` file is kept, the take is marked `incomplete:disk`, the other side is told, and the UI shows the path | BRIEF (disk failures) | T-11b | E-SCR, E-VRF | Not started |
| ERR-03 | MUST | **Control link lost during a take:** both PCs **keep recording locally** and show "Connection lost, still recording". The take ends when STOP arrives after reconnection, when Stop & save is pressed, or at a safety limit. Until the producer gets the performer's report, it shows the performer's take as **UNKNOWN**, never "Saved". *(Policy pending OQ-02 / D-11.)* | BRIEF (disconnects), protects the master | T-09 | E-SCR, E-VRF | Not started |
| ERR-04 | MUST | **Brief live-media loss:** see REC-07. The monitor is concealed and counted, and recording state does not change. | PANEL, BRIEF | T-08 | E-CSV | Not started |
| ERR-05 | MUST | **App shutdown.** (a) Closing an app during a take asks for confirmation. Confirming finalises the take as `complete (stopped by shutdown)` and tells the other side. (b) After a forced kill, crash or power loss, the `.partial` file is left in place, and on the next start the app **lists leftover `.partial` files as INCOMPLETE**. | BRIEF (incomplete files) | T-10 | E-SCR, E-VRF | Not started |
| ERR-06 | MUST | **Device lost during a take:** the audio captured so far is finalised, the take marked `incomplete:device`, the other side told, and the device screen reopened | BRIEF (device failures), A0-G7 | T-13 | E-SCR, E-VRF | Not started |
| ERR-07 | MUST | **Bad packets:** see COM-03 | BRIEF | T-12 | — | Not started |
| ERR-08 | MUST | **An incomplete file is never shown as complete**, either in the app or in the verification report | BRIEF | T-10, T-11, T-15 | E-VRF | Not started |
| ERR-09 | SHOULD | Every error is written with a timestamp to a log file next to the takes | Diagnosis after a demo | T-03…T-13 | E-APPLOG | Not started |
| ERR-10 | SHOULD | Recover a `.partial` file into a valid `.wav` copy, keeping the original | Saves a take after a crash | T-10b | E-VRF | Not started |

## 11. Telemetry (TEL) and test hooks (TST)

Every measurement is labelled by what it actually is (ARCHITECTURE §6). The UI
never shows one quantity under another's name, and an estimate is always
labelled "estimate".

| ID | Pri | Requirement: user-visible behaviour | Rationale / trace | Test | Evidence | Status |
|---|---|---|---|---|---|---|
| TEL-01 | MUST | A minimal live panel on both apps: connection state, **control RTT**, live packets received / lost / late / concealed, jitter-buffer depth (ms), input and output peak level | Enough to see whether the live link works, and to explain a glitch during the demo | T-07, T-08 | E-SCR | Not started |
| TST-01 | MUST | A **test mode**, off by default and clearly marked when on, that can (a) drop a set percentage of *outgoing live* packets, (b) replace the mic with a test tone, and (c) pause the recorder thread for a set number of seconds, to force a record-buffer overflow | Makes REC-07, REC-05 and the integrity checks reproducible. The prototypes' `--sim-loss` and `--tone` proved (a) and (b) work. | T-08, T-11c | E-SCR, E-CSV | Not started |
| TEL-02 | SHOULD | A per-second CSV log of TEL-01's values, plus record overruns and RFC 3550 arrival jitter | RO FR10, evaluation | T-17 | E-CSV | Not started |
| TEL-03 | SHOULD | Estimated clock offset and its uncertainty (±δmin/2), and the **estimated** recording-start offset between the two takes, logged per take | BRIEF (measure and disclose sync, keep the terms apart). No pass threshold at PP1. | T-07 | E-JSON | Not started |
| TEL-04 | SHOULD | A concealment-event log with sample positions in the monitor file | Shows the master/monitor contrast | T-08 | E-CSV | Not started |

## 12. Post-session verification (VER)

| ID | Pri | Requirement: user-visible behaviour | Rationale / trace | Test | Evidence | Status |
|---|---|---|---|---|---|---|
| VER-01 | MUST | A command-line **verification tool** is pointed at a session folder. For every take it reports: file present, valid RIFF/WAVE, format, frame count against the metadata, duration, status, SHA-256, and any `.partial` or mismatch. It writes the report to a text file. | PANEL evidence on both PCs. ERR-08. | T-15 | E-VRF | Not started |
| VER-02 | MUST | The two PCs' files for the same take can be identified from their names alone (session ID + take number + role) | Matching after the session | T-15 | E-VRF | Not started |
| VER-03 | SHOULD | Test-tone integrity check: count damaged 10 ms blocks (the method of `tools/audit/analyse_wav.py`) | REC-07 evidence | T-08 | E-VRF | Not started |

## 13. Take delivery to the producer (XFER), an *additional* workflow

**This is not local recording.** It is optional for PP1. Local recording (REC-01)
is met without it.

| ID | Pri | Requirement: user-visible behaviour | Rationale / trace | Test | Evidence | Status |
|---|---|---|---|---|---|---|
| XFER-01 | COULD | After a take is finalised, the performer's app can send a **copy** to the producer over a reliable connection (TCP). The original on the performer's PC is never changed or deleted. | BRIEF ("later stage"), RO FR8 | T-18 | E-HASH, E-SCR | Implemented in Stage 11 (ADR-020); tested on one PC, two PCs not run |
| XFER-02 | COULD, **but mandatory if XFER-01 is built** | The performer computes the SHA-256 of the whole file. The producer checks it and labels the copy **"Verified copy"** only if it matches. Otherwise it retries, then shows "Copy failed, original still on the performer's PC". | BRIEF (integrity checks, final verification), A0-G8 | T-18 | E-HASH | Implemented in Stage 11 (ADR-020); tested on one PC, two PCs not run |
| XFER-03 | COULD, mandatory if XFER-01 is built | The producer chooses the received file's name itself and never overwrites an existing file | A0 (Rust allowlist idea), security | T-18 | E-SCR | Implemented in Stage 11 (ADR-020); tested on one PC, two PCs not run |
| XFER-04 | LATER | Chunked transfer with per-chunk checks and resume after interruption | BRIEF (retry/resume) | — | — | Implemented in Stage 11 (ADR-020); tested on one PC, two PCs not run |
| XFER-05 | COULD | The performer agrees to delivery, at session level or per take (OQ-10) | Consent | T-18 | E-SCR | Implemented in Stage 11 (ADR-020); tested on one PC, two PCs not run |

## 14. Security disclosure (SEC) and research honesty (RES)

| ID | Pri | Requirement: user-visible behaviour | Rationale / trace | Test | Evidence | Status |
|---|---|---|---|---|---|---|
| SEC-01 | MUST | Both apps state in About and on the session screen: **"LAN prototype: audio and control are not encrypted. Use only on a trusted private network."** | BRIEF (don't present the unencrypted prototype as safe), D-13 | T-01 | E-SCR | Not started |
| SEC-02 | MUST | Media and control are accepted only from the paired peer's address | A0-G1 | T-12 | E-CSV | Not started |
| SEC-03 | MUST | Every received field is checked (lengths, ranges, types) before use | BRIEF (bad packets) | T-12, T-16 | E-REVIEW | Not started |
| RES-01 | MUST | No UI text, log or report claims zero latency, zero loss, perfect synchronisation or sample-accurate alignment. Synchronisation is **measured and the limits disclosed**, never asserted. | BRIEF (network honesty) | T-16 | E-REVIEW | Not started |

## 15. Out of scope for PP1 (LATER)

| ID | Item | Why later |
|---|---|---|
| LATER-01 | Internet use, NAT traversal, STUN/TURN/relay | BRIEF: separately documented later work |
| LATER-02 | Encryption and authentication (RO NFR7), single-use session codes | Needs a vetted TLS library. No custom crypto. |
| LATER-03 | Acoustic echo cancellation | Headphones are assumed (A-04) |
| LATER-04 | Drift measurement and compensation, sample-accurate alignment, aligned export (RO FR5 drift part, FR8 reassembly, H3) | Measured in a later stage. **Not a PP1 acceptance condition.** |
| LATER-05 | Commercial DAW features: multitrack timeline, editing, mixing, plugins, markers (RO FR6 markers), transport play/locate | Not part of the panel statement |
| LATER-06 | More than two participants (RO NFR8) | PP1 is two people |
| LATER-07 | Export to the shared Web DAW project (RO FR9) | Project-level integration later |
| LATER-08 | macOS build (RO NFR10) | Windows first |
| LATER-09 | Usability study and SUS (RO RQ4, NFR9) | Needs ethics clearance (OQ-09) |
| LATER-10 | End-to-end latency measured by impulse (RO §3.3) | Measurement stage |

### Research targets carried from the proposal: **not** PP1 acceptance conditions

These come from proposal v2 Table 4 and the NFRs. They are measured in later
stages. PP1 neither claims nor tests them.

| Proposal target | Source | When |
|---|---|---|
| Alignment error < 1 ms at every RTT, no correlation with RTT | NFR1, H3, Table 4 | Measurement stage (LATER-04) |
| Drift corrected to < 1 ms over 30 min | NFR4, Table 4 | LATER-04 |
| < 1 buffer underrun per minute at the selected operating point, 1 % loss | NFR3, Table 4 | Parameter sweep |
| < 15 % CPU, < 300 MB RAM, 4 layers | NFR5, Table 4 | Later |
| Monitoring latency compared with the 20–30 ms comfort band [1] | NFR2, Table 4 | LATER-10 |
| SUS ≥ 70 | NFR9, Table 4 | LATER-09 |
| Capture continues through a 30 s network interruption | NFR6 | **PP1 checks the behaviour (T-09, about 10 s), not the 30 s figure** |

## 16. Evidence artefact codes

| Code | Artefact |
|---|---|
| E-BUILD | Build log of the exact commit, toolchain version, and file listing of the deployment folder |
| E-SCR | Screenshot named `T-xx_<PC>_<step>.png` |
| E-WAV | The take WAV files themselves |
| E-JSON | Per-take metadata file |
| E-CSV | Per-second telemetry and concealment logs |
| E-VRF | Output of the verification tool (VER-01) |
| E-APPLOG | Application log file |
| E-HASH | SHA-256 values on both sides (transfer) |
| E-LOG | Filled, dated test log sheet, with participant sign-off where a person judges something (for example "I heard the other person") |
| E-REVIEW | Code-review checklist with reviewer and date |
| E-UNIT | Unit-test run output |
