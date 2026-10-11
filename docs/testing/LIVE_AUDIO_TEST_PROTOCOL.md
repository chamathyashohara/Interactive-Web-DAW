# Live Audio Test Protocol (Stage 7: one-way live audio, producer → performer)

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

The live options are listed in the probe's usage text and at the top of `tools/rr_session_probe/main.cpp`.
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
