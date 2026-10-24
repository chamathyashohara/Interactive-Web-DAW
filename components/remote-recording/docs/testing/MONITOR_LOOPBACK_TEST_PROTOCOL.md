# Manual Test Protocol: Local Playback, Monitoring and Diagnostics (Stage 5)

Run on **each** PC planned for PP1, in **both** apps. Evidence goes in
`evidence/stage5/<YYYY-MM-DD>_<PC>/`: screenshots, the exported report JSON, console output
and the log table (§5).

> **Safety:** wear **headphones** for every step that turns monitoring on. Start with the
> output volume low. Monitoring a live microphone through loudspeakers causes howling feedback.

## 0. Preparation
- Microphone unmuted and set to 48 kHz. Headphones connected. The Stage 4 protocol §0 applies.
- Note the input and output device names and the Windows output format (*Sound settings → Playback → device → Advanced*).

## 1. Command-line checks (no GUI)
```powershell
# (a) 1 s test tone on the default output at -20 dBFS: you should hear a 440 Hz beep.
.\rr_audio_probe.exe --tone 1 --level-dbfs -20
# (b) Monitor your mic in your headphones for 60 s (choose the headphone output index from --list):
.\rr_audio_probe.exe --list
.\rr_audio_probe.exe --monitor 60 --output <headphones index> --gain-db 0
# (c) The same, re-opening the input at 30 s while the output keeps running:
.\rr_audio_probe.exe --monitor 60 --output <headphones index> --reopen-input-at 30
```
**Pass:**
- (a) the beep is heard.
- (b) you hear yourself with a short delay, and the per-second lines show:
  - peak/RMS following your voice;
  - `underruns 0`, `overflows 0` (a few at start-up are acceptable; note them);
  - a stable monitor fill around 10–20 ms;
  - exit 0, and the final engine report has `"fault": "none"` for both devices.
- (c) the `RE-OPENED INPUT … ok (output open: yes)` line appears. Monitoring resumes within about 1 s. Underruns rise by only a few at the reopen. The fill returns to the earlier value, and `device_events` shows 2 opens each.

## 2. GUI checks (both apps)
| # | Do | Expected |
|---|---|---|
| G1 | Open input, then open output (headphones) | Both format lines are filled in. The processing line says "Saved master: unprocessed… monitoring is OFF". |
| G2 | Press **Test output** | 1 s beep in the headphones. Button disabled while it plays. |
| G3 | Tick **Monitor my input**, speak | You hear yourself. The processing line lists the channel map, the gain and the estimated buffer. The monitor buffer line shows the fill and 0 underruns. |
| G4 | Move **Monitor gain** to −20 dB, record a 10 s take while speaking, untick monitoring | You hear yourself quieter. **The saved take's level is NOT reduced:** compare with a take at 0 dB in an editor or with the meters. |
| G5 | Speak loudly or tap the mic until it clips | Red **CLIP** next to that channel for about 2 s. Clipped-samples counter rises. |
| G6 | With monitoring on, unplug the headphones (or disable them in Sound settings) while a take records | Red "The output device … Monitoring stopped; recording is not affected." **The take continues** and later saves as "Saved". The log has `playback_device_fault`. |
| G7 | Change the input device while the output is open (Close input → choose → Open input) | The output stays open. Monitoring resumes. The buffer line shows input opens +1. |
| G8 | Leave monitoring on for **10 minutes** while talking now and then | Underruns/overflows stay at (or very near) their start-up values. Drift trims may appear, about one every few minutes when the two devices' clocks differ slightly; this is expected and counted. Note the counts. |
| G9 | Diagnostics → **Export diagnostic report (JSON)…** | File saved. It opens in a text editor, and `"audio"` contains both devices and the counters you saw. |
| G10 | Monitor through **speakers** at low volume for a moment (optional, carefully) | You may hear feedback build up. The on-screen warning explains why. Turn it off. This confirms the warning, not a defect. |

## 3. Optional electrical loopback (prepares the later latency measurement)
Connect the output to the input with a cable (headphone out → line/mic in, with suitable
attenuation), with monitoring **off**. Press **Test output** while recording a take. The take
contains the beep, which shows output → input works without any acoustic path. **Do not
turn monitoring on with the cable connected** (electrical feedback loop). Measuring the delay
is a later stage (LATER-10): the app does not yet timestamp the tone.

## 4. Known limits to state with the results
- Monitor delay is shown as an **estimate** (buffer target plus device buffers). It is not measured.
- The two devices run on separate clocks. Small drift is absorbed by counted trims or underruns.
- RMS and peak are meter values over about 50 ms intervals.

## 5. Log table
```text
Date/time:     Tester:     PC:     Commit (About):     Input:     Output (headphones):
| Step | ProducerStudio | PerformerClient | Counts / notes |
| 1a 1b 1c | | | |
| G1 .. G10 | | | |
```
