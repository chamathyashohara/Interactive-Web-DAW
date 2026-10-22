# PP1 Acceptance Matrix

**Written at Stage 1 · 11 October 2026. Status reviewed 20 October 2026: every test is still NOT RUN.**

The product now exists: Stages 0–12 are implemented and the two applications build and run
(see [../STAGE_PLAN.md](../STAGE_PLAN.md) and [../build/WINDOWS_BUILD.md](../build/WINDOWS_BUILD.md)).
What has **not** happened is this matrix. Every stage was verified with both applications on
**one** PC; no test below has been run on the two physical PCs that §1 requires, so by the rule in
§1 PP1 would today be reported **PARTIAL**. The `Status` column is accurate and must only be
changed from a real two-PC run with filed evidence.

Test environment: `tools/fault/send_bad_packets.py` (§2) now exists and covers T-05(e)
and T-12. T-07b uses the port-blocking route named in its own row, not the tool.

Requirements: [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) · Use cases: [USE_CASES.md](USE_CASES.md)

---

## 1. PP1 completion criteria

**Required for "PP1 accepted":**

1. Every **MUST** test (T-01 to T-16) passes on **two physical Windows PCs** on
   the controlled LAN in §2, using one recorded build (commit hash in E-BUILD).
2. Evidence for each test is filed under `evidence/PP1/<YYYY-MM-DD>/T-xx/`, and
   the test log sheet (§5) is filled in, dated and signed by both participants.
3. The limitations list (§6) is presented alongside the demo.

**If any MUST test fails or is not run,** PP1 is reported as **PARTIAL**, naming
the failed tests. Nothing is claimed beyond what passed.

**Panel-critical subset:** T-07 (both record locally and talk) and T-08 (local
recordings unaffected by live loss) **are** the panel statement. The other MUST
tests make that demonstration safe, honest and repeatable.

**Not required for PP1 acceptance** (unless the supervisor or panel says so, see OQ-06):
- reliability on the public internet;
- sample-accurate alignment, or any alignment or latency threshold;
- drift correction;
- a SUS score;
- take delivery (XFER, COULD);
- Opus (COM-07, SHOULD).

**Synchronisation is measured and its limits disclosed.** T-07 records the
estimated clock offset, its uncertainty and the estimated start offset between
the two takes (TEL-03). These numbers are **reported, not judged**, at PP1.

**About the Stage 0 prototypes.** The terminal prototypes `duplexrec` (C++ and
Rust) showed the core of T-07 and T-08 **on loopback only**. They do **not** meet
APP-01, SES-05, STA-03 and others. If they are shown at PP1, they must be
presented as prototypes, and this matrix stays unpassed.

## 2. Test environment (record it in E-LOG before testing)

| Item | Required setting |
|---|---|
| PCs | Two physical Windows 10/11 x64 PCs, called **PC-P** (producer) and **PC-R** (performer). Record the model, OS build and audio devices of each. |
| Network | **Controlled LAN:** a dedicated travel router or a direct Ethernet cable. Not campus Wi-Fi. Both network profiles set to **Private**. Record the IPs and the link type (wired or Wi-Fi). |
| Firewall | Both apps allowed on Private networks |
| Audio | Headphones on both. A microphone on both. Both devices set to 48 kHz in Windows Sound settings. |
| Build | The same commit on both PCs, deployed as a folder (APP-01) |
| Tools | Verification tool (VER-01). Bad-packet tool `tools/fault/send_bad_packets.py` (sends malformed UDP datagrams and fake HELLO frames; `--list` shows the cases, `tools/fault/README.md` how to run them). Audacity or Windows Media Player. Admin rights for the VHD steps in T-11. |
| Participants | Researcher plus one partner, both agreeing to take part in the test (OQ-09) |

## 3. Test procedures

"Pass" lists only functional checks. No invented performance thresholds.
"Proto" = what the Stage 0 prototypes showed (REPOSITORY_AUDIT §3).

| Test | Pri | Covers | Steps | Pass when | Evidence | Proto | Status |
|---|---|---|---|---|---|---|---|
| **T-01** Launch and identity | MUST | APP-01, APP-02, SEC-01 | Copy the deployment folders to both PCs (no dev tools installed). Start ProducerStudio on PC-P and PerformerClient on PC-R. Open About. | Both start. Role, app version and protocol version are shown. The LAN-only security notice is visible. | E-BUILD, E-SCR | n/a (single CLI exe) | NOT RUN |
| **T-02** Device selection | MUST | DEV-01, DEV-02, DEV-05, DEV-06/07 (S) | On each PC: open the device list, pick the mic and headphones, speak. | The lists match Windows Sound settings. The meter moves when speaking. The rate shows 48 kHz. (S: selection remembered after restart. Headphone reminder shown.) | E-SCR | Device list only | NOT RUN |
| **T-03** No device / device won't open | MUST | DEV-03, DEV-05, ERR-01 | (a) Disable the mic in *Sound settings → Input → Don't allow*, then start the app. (b) Set the mic to 44.1 kHz and select it. | (a) A message naming the device, NOT READY, no crash. (b) NOT READY with the 48 kHz instruction. | E-SCR, E-APPLOG | Not shown | NOT RUN |
| **T-04** Mic privacy / mute | MUST | DEV-04, ERR-01 | Turn off *Let desktop apps access your microphone* (or press the mic-mute key), start the app, select the mic, wait 5 s. | The "No input signal" warning appears, with the mute and privacy hints | E-SCR | Not shown | NOT RUN |
| **T-05** Pairing and refused connections | MUST | SES-01, SES-02, SES-03, APP-02, STA-02 | (a) Correct IP and code. (b) Wrong code. (c) Wrong IP. (d) Producer app closed. (e) The bad-packet tool sends a HELLO with another protocol version. | (a) Both show Connected. (b)–(e) A specific message for each case. Retry works afterwards. No crash. | E-SCR, E-APPLOG | Not shown (no pairing) | NOT RUN |
| **T-06** Consent and readiness | MUST | STA-03, SES-04 | Connect without pressing I agree, then check whether the producer can press Record. Then agree. | Record disabled until consent. After consent, both READY. The producer shows the consent time, which is also in the session metadata. | E-SCR, E-JSON | Not shown | NOT RUN |
| **T-07** Coordinated take with live talk *(panel-critical)* | MUST | REC-01/03/04/08, SES-05/06/07, STA-01/02/04, COM-01, TEL-01 (+ S: SES-09, TEL-03, REC-10, COM-04/05) | Record **3 takes of 60 s** (test parameter). In each, the participants count 1–20 alternately, each hearing the other. Producer presses Record, then Stop. After each take, open each file in a player on its own PC. | For every take: the performer showed a countdown, then REC. Both apps showed REC and the other side's state. Both people confirm they heard the other live (signed in E-LOG). **Both PCs** have a `.wav` (no `.partial`) whose frames match the metadata (VER-01). Each person hears their **own** voice in their **own** file. The producer showed the performer's take as Saved. Clock offset, uncertainty and the estimated start offset are recorded (not judged). | E-WAV, E-JSON, E-VRF, E-SCR, E-LOG, E-CSV | **Loopback only**, CLI, no ARM/ACK, null audio | NOT RUN |
| **T-07b** ARM not acknowledged | MUST | SES-05 | Use the bad-packet tool as a fake performer that never ACKs, or block PC-R's control port after pairing. Press Record. | The take is cancelled on both sides with a message. No file is marked Saved. | E-SCR | Not shown | NOT RUN |
| **T-08** Local recordings unaffected by live loss *(panel-critical)* | MUST | REC-07, ERR-04, COM-02, TST-01a/b, TEL-01 (+ S: VER-03, TEL-04, REC-11) | Test mode on both: tone input (440 Hz on PC-P, 660 Hz on PC-R). PC-R drops **10 %** of outgoing live packets (test parameter). Record a 60 s take. | Both local files COMPLETE. The tone check finds **0 damaged blocks** in both local files. PC-P's live counters show lost/concealed > 0. Recording state never changed during the take. | E-WAV, E-VRF, E-CSV, E-SCR | **Loopback only**: 0 damaged blocks in all 3 runs | NOT RUN |
| **T-09** Control link lost during a take | MUST | ERR-03, STA-01, STA-02 (+ S: SES-10, SES-11) | During a take, on PC-R run `Disable-NetAdapter -Name "<adapter>" -Confirm:$false` (or pull the cable) for about 10 s, then re-enable it. Then the producer presses Stop. | Both show "Connection lost, still recording". The producer shows the performer's take as UNKNOWN until reconnection. Both files end up COMPLETE and cover the outage without gaps. The behaviour matches the agreed policy (OQ-02). | E-SCR, E-VRF, E-APPLOG | Not shown | NOT RUN |
| **T-10** Shutdown during a take | MUST | ERR-05, ERR-08, REC-03 (+ S: ERR-10) | (a) Close ProducerStudio during a take and confirm. (b) Run `taskkill /F /IM PerformerClient.exe` during a take, then restart PerformerClient. | (a) The producer's take is complete ("stopped by shutdown") and the performer was told. (b) The `.partial` file remains, is listed as INCOMPLETE after the restart, and VER-01 flags it. Never shown as complete. | E-SCR, E-VRF | Not shown | NOT RUN |
| **T-11** Disk space and write errors | MUST | REC-09, ERR-02, ERR-08, REC-05, TST-01c | Make a small test drive (admin, §4). (a) Point the recordings folder at a **200 MB** drive. (b) On a **400 MB** drive, start a take, then fill the drive to about 5 MB free (`fsutil file createnew T:\fill.bin <bytes>`). (c) On a normal drive, during a take, use TST-01c to pause the recorder thread for longer than the record buffer holds. | (a) NOT READY showing free vs required space. (b) Take marked `incomplete:disk`, `.partial` kept, peer told. (c) Take marked "has gaps", with positions in the metadata. | E-SCR, E-VRF, E-JSON | Not shown | NOT RUN |
| **T-12** Bad packets | MUST | COM-03, SEC-02, SEC-03, ERR-07 | During a take, the bad-packet tool (from PC-R's IP **and** from a third address or port) sends: truncated, bad CRC, oversized length field, unknown type, wrong session ID, valid-looking audio from a non-peer address. | No crash. Each type is counted. No injected audio is heard. Both local files COMPLETE with frames matching the metadata. | E-CSV, E-SCR, E-VRF | Not shown (both prototypes accept any source, A0-G1) | NOT RUN |
| **T-13** Device lost during a take | MUST | ERR-06 | During a take, unplug the USB mic/headset on PC-R, or disable it in Device Manager. | The captured audio is finalised as `incomplete:device`. The producer is told. The device screen reopens. | E-SCR, E-VRF | Not shown | NOT RUN |
| **T-14** Performer withdraws | MUST | SES-08, STA-05 | (a) During a take, the performer presses Stop & save. (b) The performer presses Leave session. (c) Try to start a take from PC-R. | (a) The performer's take is finalised and the producer told. (b) The producer sees the performer left, and no file is deleted. (c) There is no way to start a take on PC-R. | E-SCR | Partly (Rust: remote ignores `r`) | NOT RUN |
| **T-15** Post-session verification | MUST | VER-01, VER-02, REC-02, REC-04, ERR-08 | Run the verification tool on the session folder on **both** PCs after T-07 to T-14. | The report lists every take with format (float32, mono, 48 kHz), frames = metadata, status and SHA-256. Incomplete takes are flagged as such. Matching takes are identifiable by name across the PCs. | E-VRF | Not shown | NOT RUN |
| **T-16** Real-time and honesty review | MUST | REC-06, COM-02, SEC-03, RES-01, REC-05 | Code review against the checklist in §4.2, plus the unit tests (ring buffer, header/CRC, jitter buffer, field validation). Review all UI strings and report templates for forbidden claims. | Every checklist item ticked with file and line references. Unit tests pass. No UI or report text claims zero latency, zero loss or perfect synchronisation. | E-REVIEW, E-UNIT | n/a | NOT RUN |
| T-17 Telemetry export | SHOULD | TEL-02, TEL-04, COM-06, COM-07, REC-11 | Look at the CSV and logs after T-07 and T-08. Change segment size and depth at runtime. | CSV columns present and labelled. Concealment positions line up with the monitor file. | E-CSV | Loopback: CSV and concealment log present | NOT RUN |
| T-18 Take delivery | COULD | XFER-01, 02, 03, 05 | After a take, send the performer's copy. Then repeat while disabling the network adapter mid-transfer. | The copy's SHA-256 matches the original, and it is labelled "Verified copy". The original is unchanged (hash before and after). The interrupted transfer ends in retry or a clear failure, never a false "verified". | E-HASH, E-SCR | Rust loopback: byte-identical, no hash | One PC only (Stage 11, two processes, real input; normal, interrupted both ways, duplicate, damaged chunk, whole-file mismatch, wrong session, no consent). **Two PCs NOT RUN.** |
| T-19 Single-PC rehearsal | SHOULD | APP-03 | Run both apps on one PC with different ports and repeat T-07 | Same as T-07, but recorded as one PC (not evidence for the panel statement) | E-SCR | Loopback shown | NOT RUN |

## 4. Test aids

### 4.1 Small test drive for T-11 (Windows Pro, admin)

```text
diskpart
  create vdisk file="C:\pp1test\small200.vhdx" maximum=200 type=fixed
  select vdisk file="C:\pp1test\small200.vhdx"
  attach vdisk
  create partition primary
  format fs=ntfs quick label=PP1T200
  assign letter=T
  exit
```

Repeat with `maximum=400` for T-11b. Detach afterwards with `select vdisk …`
then `detach vdisk`.

### 4.2 Real-time and honesty review checklist (T-16)

- [ ] The capture/playback callback calls no file, socket, logging, Qt or allocation API, and takes no mutex (list each function it reaches).
- [ ] Every queue between threads has a fixed capacity, one writer and one reader, and a counted overflow path.
- [ ] Received packets are length- and range-checked before any field is used, and the source address is checked against the paired peer.
- [ ] The concealment code writes only to the playback/monitor path, never to the master writer.
- [ ] Finalisation patches the header, flushes and renames, and every failure path leaves `.partial` and sets an `incomplete:` status.
- [ ] Every telemetry label matches ARCHITECTURE §6, and estimates are labelled "estimate".
- [ ] No string claims zero latency, zero loss, perfect sync or sample accuracy.

## 5. MUST requirement → test traceability (every MUST has a test)

| MUST | Test(s) | MUST | Test(s) | MUST | Test(s) |
|---|---|---|---|---|---|
| APP-01 | T-01 | SES-01 | T-05 | ERR-01 | T-03, T-04 |
| APP-02 | T-01, T-05e | SES-02 | T-05 | ERR-02 | T-11b |
| DEV-01 | T-02 | SES-03 | T-05 | ERR-03 | T-09 |
| DEV-02 | T-02 | SES-04 | T-06 | ERR-04 | T-08 |
| DEV-03 | T-03 | SES-05 | T-07, T-07b | ERR-05 | T-10 |
| DEV-04 | T-04 | SES-06 | T-07 | ERR-06 | T-13 |
| DEV-05 | T-02, T-03b | SES-07 | T-07 | ERR-07 | T-12 |
| REC-01 | T-07, T-08 | SES-08 | T-14 | ERR-08 | T-10, T-11, T-15 |
| REC-02 | T-15 | COM-01 | T-07 | TEL-01 | T-07, T-08 |
| REC-03 | T-07, T-10, T-15 | COM-02 | T-08, T-16 | TST-01 | T-08, T-11c |
| REC-04 | T-15 | COM-03 | T-12 | VER-01 | T-15 |
| REC-05 | T-11c, T-16 | STA-01 | T-07, T-09 | VER-02 | T-15 |
| REC-06 | T-16 | STA-02 | T-05, T-09 | SEC-01 | T-01 |
| REC-07 | T-08 | STA-03 | T-06 | SEC-02 | T-12 |
| REC-08 | T-07 | STA-04 | T-07 | SEC-03 | T-12, T-16 |
| REC-09 | T-11a | STA-05 | T-14 | RES-01 | T-16 |

That is 48 MUST requirements, each covered by at least one of the 17 MUST tests (T-01 to T-16 plus T-07b).

## 6. Limitations to disclose at PP1 (fill in from the actual results)

- Tested on one controlled LAN only. No claims about Wi-Fi in other places or about the internet.
- Not encrypted or authenticated (SEC-01). Use on trusted networks only.
- Synchronisation: the start is coordinated by a scheduled time and acknowledged, and its offset is **estimated** with a stated uncertainty. **Alignment accuracy was not measured at PP1.**
- No echo cancellation: headphones are required.
- Live audio quality depends on the network. Concealment glitches are expected under loss, and they never affect the local recordings (T-08).
- Two participants only. Windows only.
- Any MUST test that did not pass, with its reason.

## 7. Test log sheet (copy to `evidence/PP1/<date>/TEST_LOG.md`)

```text
Date/time:            Build commit:            Testers:
PC-P model/OS/devices/IP:
PC-R model/OS/devices/IP:
Network (router model / cable, wired or Wi-Fi):
| Test | Result PASS/FAIL/NOT RUN | Evidence paths | Notes | Initials P / R |
Participant statement (T-07): "I heard the other person live in every take" — P: ____  R: ____
```
