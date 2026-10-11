# Session Test Protocol (Stage 6: producer/performer control over a LAN)

**Scope:** session control only, meaning pairing, readiness, consent, scheduled start/stop, confirmations, link loss and reconnect. **No live audio** passes between the PCs in Stage 6.

**Security label:** LAN-only and unencrypted (ADR-012, ADR-016). Use only on a trusted private network. Nothing here is designed or tested for use across the internet.

Record the results in `docs/testing/evidence/` (date, PCs, network, build, commands, output). Never write a pairing code or resume token into evidence; replace it with `<redacted>`.

## 0. Tools
| Tool | Build | Use |
|---|---|---|
| `rr_session_probe.exe` | `core-check-gcc` (GCC) or `msvc-x64` | Scripted producer/performer without Qt. Reproducible runs. |
| `ProducerStudio.exe` / `PerformerClient.exe` | `msvc-x64` with Qt | The real apps (Session panel) |

The probe commands are:
```
rr_session_probe --interfaces
rr_session_probe --producer  [--bind <ip>] [--port <n>] [--code-file <f>] [--audio] [--out <dir>] [--log <f.jsonl>] [--script "..."]
rr_session_probe --performer --host <ip> [--port <n>] (--code <6 digits> | --code-file <f>) [--audio] [--out <dir>] [--log <f.jsonl>] [--script "..."]
script steps (";"-separated): wait <s> | wait-ready [s] | wait-state <State> [s] | wait-link <LinkState> [s] |
  wait-closed | record | stop | stop-and-save | drop-link | consent on|off | leave | quit
test only: --test-protocol-major <n>
```
Without `--audio` the probe uses the **test recorder**: no audio is captured and nothing is written. With `--audio` it records the default input to `--out`.

## 1. Two instances on one PC (done on the development PC, 2026-10-11)
These runs test the logic and the message flow, not the network.

| Run | Producer | Performer | Expect |
|---|---|---|---|
| A | `--producer --port 52000 --code-file c.txt` | `--performer --host 127.0.0.1 --port 52000 --code-file c.txt` | Full take. The producer shows ARM_ACK, START_ACK, TAKE_STARTED, STOP_ACK and TAKE_FINALISED "yes". Same session id on both. |
| B | `--port 52001` | `--code 000000` | `E_BAD_PAIRING_CODE`. The performer ends Disconnected and the producer keeps listening. |
| C | `--audio --out takes` | `--audio --out takes`, script with `drop-link` during recording | LinkLost, then Connected again. Both takes complete with equal length (same device on the same PC). |
| D | default | `--test-protocol-major 2` | `E_VERSION_UNSUPPORTED`, both versions named |
| E2 | `--bind <Wi-Fi IP>` + `stop` while the link is down | `drop-link` | The STOP is re-sent after the reconnect. The performer's take is longer and reported complete. |
| F | none | `--port <unused>` | "connection refused" (WSA 10061) → Disconnected |
| G | `record; wait 3; quit` | default | The performer stops and saves its take on SESSION_CLOSED |

Check after each run with a log: `findstr /C:"<the code>" *.jsonl` must find nothing.

## 2. Two PCs on one private LAN (NOT YET RUN)
Preconditions:
- Both PCs are on the same private network. Windows network profile **Private** on both: *Settings → Network & internet → (adapter) → Network profile type: Private*.
- The build and version are the same on both. Note them, as shown in Help → About.
- The microphones are unmuted if audio content is to be checked.

Steps:
1. **Producer PC:** start Producer Studio. Open the input. Session panel → *Listen on:* choose the LAN adapter (not loopback). Port 52000 → **Create session**. Note the session ID, the address and the pairing code shown.
2. If Windows Firewall asks: allow **Private networks only**. Do not allow Public.
3. **Performer PC:** start Performer Client. Open the input. Enter the producer address, port and code → **Join**. Tick consent on both PCs.
4. Both PCs show *Connected* / *Ready*. The producer shows the performer's name and address.
5. Producer: **Record (both)**. Check that the confirmations appear one by one, and that the performer shows "RECORDING on this PC". Speak or clap on both sides.
6. After about 30 s: **Stop (both)**. Both show the saved take. The producer shows "performer's take: complete, N frames".
7. Link loss: unplug the performer's network cable (or switch Wi-Fi off) for about 5 s during a take. Both keep recording, *Connection lost* is shown, and the link reconnects after the cable is back. Then Stop: both takes are complete.
8. Wrong code, a second performer, and closing the producer app mid-take (the performer must stop and save).
9. Export the diagnostic report on both PCs. Copy the take folders and logs into the evidence.

What may be claimed afterwards: only what was observed. Do not claim alignment accuracy in samples: the start difference shown is an **estimate** without device input latency.

## 3. Windows Firewall (manual, documented; the apps never change it)
Inbound TCP to the producer's control port must be allowed on the **Private** profile only. The performer only makes outbound connections and needs no rule.

Preferred: accept the Windows prompt on first use with **Private** ticked and **Public** unticked.

If no prompt appears, or it was dismissed, an administrator can add one narrow rule. **This is for the producer PC only and must be run deliberately by the researcher; it was not run during development:**
```powershell
New-NetFirewallRule -DisplayName "ProducerStudio control (TCP 52000, Private)" `
  -Direction Inbound -Protocol TCP -LocalPort 52000 -Profile Private -Action Allow `
  -Program "C:\path\to\ProducerStudio.exe"
```
Remove it afterwards:
```powershell
Remove-NetFirewallRule -DisplayName "ProducerStudio control (TCP 52000, Private)"
```
Do **not** disable the firewall, allow the Public or Domain profile, open port ranges, or forward the port on a router.

**Stage 7:** live audio also needs inbound **UDP** on the media port (control port + 1, 52001 by default) on the producer PC, Private profile only. See LIVE_AUDIO_TEST_PROTOCOL §3.

**Stage 11:** take copies need inbound **TCP** on the transfer port (control port + 2, 52002 by default) on the producer PC, Private profile only. The performer PC needs no rule (it connects out). The narrow rule, again **not run during development** and only for the researcher to run deliberately:
```powershell
New-NetFirewallRule -DisplayName "ProducerStudio take transfer (TCP 52002, Private)" `
  -Direction Inbound -Protocol TCP -LocalPort 52002 -Profile Private -Action Allow `
  -Program "C:\path\to\ProducerStudio.exe"
```

Troubleshooting a failed join:
- **"connection refused" (WSA 10061):** wrong address or port, or no session created.
- **"timed out":** often the firewall or the Public profile. Check the profile and the rule.
- Check the producer's address on the producer PC with `ipconfig`. It must match the address shown in the Session panel.

## 4. Stage 9: coordinated recording cycle (evidence `2026-10-11_devpc_stage9_coordinated_runs.txt`)

### 4.1 On one PC with real input devices (done on the development PC, 11 Oct 2026)
Two probes, both `--audio` (the same physical input opened twice; the endpoint is muted in Windows, so the files are silent), with two-way live audio on the real output at −60 dB.

| Run | Producer script | Performer script | Expect |
|---|---|---|---|
| C1 | `checks`; five times `record; wait-state Recording; wait 5; stop; wait-state Ready` | `checks`; `blackhole on` for 3 s during a take (live impairment) | 5 takes complete on both PCs. The live impairment changes no recording. Timing records on both sides. |
| C2 | `record; wait-state Scheduled; stop-now` | — | Cancelled on both PCs; no file |
| C3 | `record; wait 6` | `wait-state Scheduled; drop-link` | No recording on either PC; the link reconnects to Ready |

Afterwards:
- `tools/audit/analyse_take_timing.py p.jsonl r.jsonl --same-pc`: start offsets, measured on the shared clock;
- `tools/audit/verify_take_wav.py`: structure, every sample, frames against the metadata;
- `tools/audit/mci_open_check.c`: Windows opens each WAV and reports its length.

### 4.2 On two PCs (NOT YET RUN): the Stage 9 acceptance test
Preconditions: as §2. Both PCs have the input open; the input and output are at 48 kHz; headphones are on.
1. Producer: **Create session**. Performer: **Join**.
   - Both PCs show the **readiness checklist** with every item for both PCs.
   - Untick consent on the performer: the producer shows "Consent: NO" for the other PC, and **Record (both)** is disabled.
   - Tick it again.
2. Note the start lead (default 1000 ms) and the minimum shown in the Record button's tooltip.
3. Producer: **Record (both)**.
   - The performer shows **"SCHEDULED - recording starts in … s, at …"** and "Session controlled by …".
   - The producer's performer row reads "SCHEDULED (start time acknowledged)", then "RECORDING (confirmed by the performer)" only after the performer's message.
   - The performer does **not** click anything at the start.
4. During the take, make the live audio fail briefly (unplug the performer's network cable for 3 s, or block UDP).
   - Both recording rows stay RECORDING.
   - Then **Stop (both)**: both rows show "saved: complete, N frames".
5. Repeat 3–4 five times.
6. **Cancel before the start:** Record, then **Cancel take** within the countdown. Both PCs return to Ready and no file appears.
7. **Disconnect before the start:** Record, then unplug the performer's cable during the countdown. Expect no recording; this is detected only if the loss is noticed before the start (≤ 3 s, ADR-019).
8. Play every take on each PC in a media player, and run `verify_take_wav.py` on them.
9. **Measured start offset across PCs:** play one shared click (a hand clap near both microphones, or a tone in both headsets) during a take. Measure the offset between the two files by cross-correlation (LATER-04 tool not yet built: do it by hand in an audio editor and record the method). Report it next to the app's *estimated* offset ± u, with the test conditions (network, distance of the source to each microphone, interfaces). Do not report the estimate as the measurement.

## 5. Stage 11: verified take transfer (evidence `2026-10-11_devpc_stage11_transfer_runs.txt`)

### 5.1 On one PC with the real input device (done on the development PC, 11 Oct 2026)
Script: two `rr_session_probe` processes over loopback, `--audio` on both (WASAPI, microphone endpoint muted in Windows, so the takes are near-silent), one take of about 20 s each, then `transfer 1`. Each scenario was a fresh session:

| Run | Injected condition | Expected and observed |
|---|---|---|
| X1 | none | VERIFIED, 1 connection |
| X2 | performer cuts the connection after 100 chunks (`--xfer-drop-after 100`) | PAUSED, resumed from chunk 100, VERIFIED |
| X3 | producer cuts the connection after 80 chunks | PAUSED, resumed from chunk 80, VERIFIED |
| X4 | the same take requested twice | second answer "already verified", nothing rewritten |
| X5 | chunk 5 damaged after hashing (`--xfer-corrupt-chunk 5`) | chunk rejected (NACK), resent, VERIFIED |
| X6 | chunk 3 altered before hashing (`--xfer-corrupt-whole 3`) | whole-file SHA-256 MISMATCH, copy set aside, resent, VERIFIED |
| X7 | HELLO with another session id (`--xfer-wrong-session`) | refused, nothing written, FAILED after 60 s |
| X8 | performer has not allowed copies | refused (`E_TRANSFER_REFUSED`), nothing written |

Independent checks (`scratchpad` script, results in the evidence): Python `hashlib` SHA-256 of every original and copy, `tools/audit/verify_take_wav.py` on every copy, Windows MCI open/length, the app's pre-send hash against `hashlib` after the run, and a search of the logs for tokens and pairing codes.

### 5.2 On two PCs (NOT YET RUN)
Preconditions: §2 and the Stage 11 firewall note in §3. Performer: tick **Allow the producer to receive a verified copy of my takes**.
1. Record one take (§4.2 step 3). Producer: **Get verified copy of the performer's last take**.
   - Both PCs show QUEUED → TRANSFERRING → VERIFYING → **VERIFIED COPY** (producer) / VERIFIED (performer).
   - Record is unavailable on the producer while the copy is moving.
2. On the producer, play the copy in a media player and check its duration against the performer's take. Run `verify_take_wav.py` on it.
3. On both PCs compute `certutil -hashfile <file> SHA256` for the original and the copy and compare (E-HASH).
4. **Interrupted:** record a long take (5 min), request the copy and unplug the performer's network cable for 10 s halfway. Expect PAUSED / RETRYING, then "resumed from chunk N" and VERIFIED. Repeat with the cable out for more than 60 s: expect FAILED with "the original is still on the performer's PC", then request again and expect a resume from the kept chunks.
5. **Duplicate:** request the same take again: "already verified", no second file.
6. **No consent:** untick the performer's checkbox and request: refused, nothing written.
7. Record the network (wired/Wi-Fi), the file size and the transfer time. Do not present one measurement as a throughput figure.
