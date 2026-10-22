# Live Audio Test Protocol (Stage 7: one-way, Stage 8: two-way live audio)

> **Stage 8:** live audio is now two-way. §1–§3 are the Stage 7 one-way procedure, kept as they were; the probe reproduces them with `--one-way`. Stage 8 runs and tests are in §4–§6.

**Scope:** the live monitor stream only. The producer's microphone is heard at the performer's PC (Opus over UDP, ADR-017). Session control is SESSION_TEST_PROTOCOL. Two-way talkback is not built.

**Security label:** LAN-only and unencrypted (ADR-012). Use only on a trusted private network.

**What may be claimed:** only what was observed and measured, with the conditions stated.
- Do not claim "no glitches" from a run unless the counters (underruns, concealed, lost, late) were 0 for a stated duration, network and setting.
- Inter-arrival jitter and loss counters are **not** latency.
- The live stream is a monitor: it never repairs or changes either master recording.

Record results in `docs/testing/evidence/` (date, PCs, network, build, commands, output, settings). Never write a pairing code into evidence.

## 0. Tools
| Tool | Use |
|---|---|
| `rr_session_probe --live` | Scripted producer/performer with live audio, no Qt (the same `rr_media` code as the apps) |
| `tools/audit/analyse_live_sink.py <file.wav>` | Frequency, level, dropout and dip blocks of a `--live-sink wav:` file |
| `ProducerStudio.exe` / `PerformerClient.exe` | The real apps: Live audio panel under the Session panel |

The live options are listed in the probe's usage text and at the top of `tools/rr_session_probe/Main.cpp`.
- `--live-source tone` is a labelled **test tone**, not a microphone.
- `--live-sink null|wav:` is a labelled **test playback clock** (10 ms), not an output device.
- `--sim-*` (test only) drops, duplicates or reorders packets in the producer before `sendto`.

## 1. Two instances on one PC (done on the development PC, 11 Oct 2026; evidence `2026-10-11_devpc_stage7_live_runs.txt`)
These runs test the logic, the codec and the counters, **not** a real network or a remote listener.

| Run | Producer | Performer | Checks |
|---|---|---|---|
| L1 | `--live` (tone) | `--live --live-sink wav:live_sink.wav` | Packets sent ≈ received, 0 lost, 0 invalid. The sink is 440 Hz at the expected level, 0 dropout blocks. |
| L2 | `--live --sim-loss 5 --sim-dup 2 --sim-reorder 2 --sim-burst 200:25` | as L1 | No crash. Duplicates, reordering, loss estimate, underruns, refills and concealment all counted. Playback resumes after each burst. |
| L3 | `--bind <Wi-Fi IP> --live` | `--host <Wi-Fi IP> --live …` | As L1 over the LAN address |
| L4 | `--audio --live` (mic source) + `record; stop` | `--audio --live --live-sink device --live-gain-db -60` | Real WASAPI playback callbacks at 48 kHz, 0 wrong-rate callbacks, worst `render_add` time. Both master takes complete and separate. |
| L5a–e | `--frame-ms 2.5/10/20`, `--application audio`, bitrates | `--jitter-frames 1/2/4/8` | Responsiveness versus stability (ADR-017) |

## 2. Two PCs on one private LAN (NOT YET RUN): acceptance "real audio is heard at the remote PC"
Preconditions:
- Both PCs on the same private network, Windows network profile **Private** on both.
- The same build on both.
- **Headphones on the performer PC.** Speakers feed the producer's voice into the performer's microphone and master.
- Both input and output devices set to 48 000 Hz in Windows Sound settings.

Steps:
1. Start a session as in SESSION_TEST_PROTOCOL §2, steps 1–4.
2. Performer: open an **output** device in the audio panel. In *Live audio from the producer*, set the volume to about −30 dB and tick **Hear the producer**.
3. Producer: open the input device and tick **Send my microphone live to the performer**.
   - The producer's Live line shows *SENDING to <performer address:port>*.
   - The *Performer reports* line updates about twice a second.
4. Producer speaks or plays for 60 s. The performer confirms it is **heard**, and both note the displayed counters every 15 s.
5. **Loss condition:** during 4, unplug the performer's network cable or turn Wi-Fi off for about 3 s, then reconnect.
   - Expected: underruns, concealment, then refilling, with no crash.
   - The producer pauses sending after 3 s without reports and resumes when they return.
6. **Separation from the masters:** during 4, press **Record (both)** and later **Stop (both)** (SESSION_TEST_PROTOCOL).
   - Check that both takes complete.
   - Check that the performer's master contains only the performer's microphone. With headphones, the producer's voice must not be in it.
7. Repeat 4 with jitter buffer 1, 3 and 8 frames. Note the underruns and concealment per minute for each, and the subjective delay.
8. Export the diagnostic report on both PCs. It includes the live counters.

Optional, with probes instead of the apps (same LAN):
```
producer PC:  rr_session_probe --producer --bind <LAN IP> --port 52000 --audio --live --script "wait-ready 120; wait 60; live-stats; quit"
performer PC: rr_session_probe --performer --host <producer LAN IP> --port 52000 --code <code> --live --live-sink device --live-gain-db -30 --script "wait-ready 60; wait-closed"
```

## 3. Windows Firewall (manual, documented; the apps never change it)
The producer PC needs inbound **TCP 52000** (control, SESSION_TEST_PROTOCOL §3) and inbound **UDP 52001** (live media) on the **Private** profile only.

The performer PC needs no inbound rule. It sends first, from a connected UDP socket, and receives only the replies to its own outbound flow.

Preferred: accept the Windows prompt with **Private** ticked and **Public** unticked. Otherwise an administrator adds one narrow rule on the producer PC. **This is documented, not run during development:**
```powershell
New-NetFirewallRule -DisplayName "ProducerStudio live audio (UDP 52001, Private)" `
  -Direction Inbound -Protocol UDP -LocalPort 52001 -Profile Private -Action Allow `
  -Program "C:\path\to\ProducerStudio.exe"
Remove-NetFirewallRule -DisplayName "ProducerStudio live audio (UDP 52001, Private)"
```
The UDP port is the control port + 1. If the control port is changed in the app, change the rule to match.

Troubleshooting:
- **Producer shows "waiting for the performer to listen":** no performer report has arrived.
  - The performer has not ticked *Hear the producer*, or has no session.
  - Or UDP 52001 is blocked inbound on the producer PC (firewall or Public profile).
- **Performer shows "no live packets":** the producer is not sending, or its reports are failing (see above).
- **"needs 48000 Hz":** set the device's default format to 48 000 Hz in Windows Sound settings. There is no resampler (ADR-013).
- **Underruns or concealment counted but no packets lost:** the buffer is too small for the timing on that network or device. Raise the jitter buffer.

## 4. Stage 8: two instances on one PC (done on the development PC, 11 Oct 2026; evidence `2026-10-11_devpc_stage8_duplex_runs.txt`)
Both probes run with `--live`, which is two-way. The producer's test tone is 440 Hz and the performer's is 660 Hz, so a sink shows who is heard. Each probe saves a sink (`--live-sink wav:`) and, where needed, its source on the same test clock (`--source-wav`). Analyse with `tools/audit/analyse_live_duplex.py --sink … [--source …] --own-hz … --remote-hz …`.

| Run | What it shows | Producer / performer options and script |
|---|---|---|
| D1 | Both directions at once; each side hears only the other | tone / tone, wav sinks |
| D2 | **Recording, send mute and receive mute at once.** Masters complete; masters contain no received audio | `--audio` on both (real input recorded); producer `record`, `mute on/off`, `stop`; performer `hear off/on` |
| D3 | **Accidental feedback / duplicate audio and software round trip:** the performer sends back what it hears (`--live-source echo`), and the producer finds its own bursts in what it hears | producer `--live-source bursts --source-wav`; performer `--live-source echo`; jitter 3 and 8 frames (**excessive buffering**: the round trip grows with the buffer) |
| D4 | **Asymmetric failure during a take:** producer → performer blackholed for 6 s; the other direction and both recordings unaffected | performer `blackhole on; wait 6; blackhole off` |
| D4b | The same without the control-link hint: the performer stops after 3 s (no blind sending) and resumes at once afterwards | performer `--no-control-hint` |
| D5 | **Device change:** the performer re-opens its input, then its output, while both directions run (real devices, −60 dB) | `--audio --live-sink device --live-gain-db -60`; performer `reopen-input`, `reopen-output` |
| D6 | Different impairments per direction are counted per direction | producer `--sim-loss 5`; performer `--sim-dup 3 --sim-burst 150:20` |

## 5. Stage 8: two PCs on one private LAN (NOT YET RUN), the acceptance run
Preconditions:
- SESSION_TEST_PROTOCOL §2 preconditions.
- **Headphones on BOTH PCs.** There is no echo cancellation.
- Input and output at 48 000 Hz on both PCs.
- Producer firewall rule for UDP on the media port (§3).

Steps (the apps, with the Live audio panel under the Session panel):
1. Create and join a session. Tick consent on both PCs.
2. On both PCs: open input and output, tick **Send my microphone live** and **Hear …**, and set the volume to about −30 dB.
3. **Both people hear each other** (acceptance 1). Each says a sentence; the other confirms hearing it. Note the five status rows on both PCs.
4. **Recording while talking** (acceptance 2): **Record (both)**, talk for 30 s, **Stop (both)**.
   - Both takes must be complete.
   - Listen to each master: it must contain only that PC's own microphone (with headphones, no voice of the other person).
5. **Mute and monitor controls are independent and visible** (acceptance 3), during a take:
   - performer **Mute my microphone**: the producer's incoming row shows "remote MUTED", and the performer's recording row still shows RECORDING;
   - producer untick **Hear the performer**: the performer's outgoing row shows "remote has hearing switched off";
   - change each volume, then undo each control.
6. **One direction fails** (acceptance 4), during a take: on the producer PC, block inbound UDP for the media port for about 10 s (disable the §3 rule, or `New-NetFirewallRule … -Action Block`, removed afterwards).
   - The performer → producer direction stops. The producer's incoming row shows "NO PACKETS".
   - Producer → performer continues while the control link is up.
   - **Neither recording row changes. Both takes complete.**
   - Re-enable the rule: the stream resumes.
7. **Duplicate audio / feedback check:** with the performer briefly on **speakers** at low volume (only for this check, and NOT during a take), the producer speaks.
   - The producer hears themselves delayed. This is the failure mode headphones prevent.
   - Then back to headphones: the echo must be gone.
8. **Excessive buffering:** set the jitter buffer to 16 frames on one PC, then to 1 frame.
   - Note the subjective delay and the underruns/concealed per minute, per direction.
   - Return to 3.
9. **Device change:** while talking, the performer unplugs the headset (or chooses another device in the audio panel) and plugs it back.
   - No crash.
   - The rows show the device state.
   - The live streams resume after the device is re-opened.
10. Both PCs: **Export live report (one page)**, and add the test conditions (network, switch, Wi-Fi or cable, distance, headphones) to the test record.

What may be claimed afterwards: only the observed results, with these conditions. No echo cancellation exists, so none may be claimed.

## 6. Echo cancellation, headphones and what the app does about feedback
- **Echo cancellation is NOT implemented** (LATER-03). Nothing in the app removes the other person's voice from your microphone.
- **Headphones are required on both PCs.** The Live audio panel says so, and the one-page report records whether headphones were confirmed.
- What the app does:
  - it never plays a side's own stream back to it (the stream-id check; `wrong_stream` counter);
  - it never writes received live audio into a recording (separate rings, ADR-007/017/018);
  - it lets each person mute their microphone without stopping their recording.
- Feedback through the air (speakers → microphone) is **not detected automatically in the apps**. It is measured in tests with `analyse_live_duplex.py` (own-tone share and burst delay).
