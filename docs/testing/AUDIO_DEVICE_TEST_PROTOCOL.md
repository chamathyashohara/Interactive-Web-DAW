# Manual Audio Device Test Protocol (Windows): Stage 4 local recording

**Purpose:** show with real microphones that **each app records its own microphone to a
playable, correctly finalised local WAV**, independently of any network. Run it on **each**
PC that will be used at PP1, for both apps.

**Evidence folder:** `evidence/stage4/<YYYY-MM-DD>_<PC-name>/`. Save the screenshots,
console output, the WAV/JSON files and the filled-in log table (§6).

## 0. Preparation (record the results in §6)

1. Windows 10/11 x64. Note the PC model and the microphone and headphone models.
2. **Unmute the microphone.** Use the mute key, then *Settings → System → Sound → Input → (device)*: volume above 0, not muted.
   > On the development PC (11 Oct 2026) the default capture endpoint **was muted**: `muted=True`, read with the Windows Core Audio API. That makes every sample exactly 0.
3. *Settings → Privacy & security → Microphone*: "Let desktop apps access your microphone" = **On**.
4. Set the microphone format to **48000 Hz**: *Sound settings → More sound settings → Recording → (device) → Properties → Advanced*.
5. Build according to `docs/build/WINDOWS_BUILD.md`, or use the build handed over for the test. Note the commit hash shown in Help → About.

## 1. Command-line check, no GUI (also works where Qt is not installed)

```powershell
.\rr_audio_probe.exe --list
.\rr_audio_probe.exe --record 10 --out "$env:USERPROFILE\Music\RR-probe"
```
Speak or sing during the 10 s.

**Pass:**
- The per-second lines show **peak dBFS clearly above −120** while you speak, typically −40 to −6.
- `result: status=complete finalised=yes`, `has_gaps=no`.
- `valid finished float32 WAV: YES`.
- `frames in file == metadata: yes`.
- Exit code 0.

**Fail:** constant `-120.0` (muted or blocked, see §0), any `NO`, or a non-zero exit code.

## 2. Each GUI app records independently (T-02, T-07 local part)

Do this for **ProducerStudio.exe** and then for **PerformerClient.exe**:

1. Start the app. It shows its role name, "Not connected", "Not ready".
2. *Audio devices*: choose the microphone and the headphones → **Open input**.
   - The format line shows "WAV float32, 48000 Hz, N channel(s)", plus the device stream and the conversion notes.
3. Speak. The meter(s) move. Stay silent for 5 s: the meters drop, but the "No input signal" warning does **not** appear, because a live microphone is never digital zero.
4. Press **Record** (performer: **Record (local test)**). The red "● REC take 01 0:0x.x" counts up.
5. Speak for at least 20 s, then press **Stop**. "Saving take 01..." appears briefly, then:
   - green **"Saved take 01: <path> | 2x.xx s, 48000 Hz, N ch, float32 WAV"**.
6. Press **Open folder**. The folder contains `take01_<role>_<session>.wav` and `.json`, and **no** `.wav.partial`.
7. **External playback:** open the `.wav` in Windows Media Player, or Audacity if installed. You hear your own voice, for the full duration.
8. Repeat steps 4–7 twice more. You get take02 and take03. No file is overwritten.

**Pass:** all of the above, three times, in both apps. Screenshot of the saved line and of the player.

## 3. Error paths (Stage 4 part of T-03, T-04, T-10, T-11, T-13)

| # | Do this | Expected | Evidence |
|---|---|---|---|
| E1 | Mute the mic (mute key), Open input, wait 4 s | Red "No input signal …" warning appears. Unmuting clears it within about 3 s. | Screenshot |
| E2 | Set the mic to 44100 Hz in Windows, then Open input | Red "Not ready: input device runs at 44100 Hz but 48000 Hz is required…". No recording possible. | Screenshot |
| E3 | Disable the only microphone (Sound settings → device → Don't allow), Refresh | "No input device found …". Open input disabled. No crash. | Screenshot |
| E4 | While recording, **unplug the USB microphone/headset** (or disable it in Device Manager) | Red **"INCOMPLETE take NN (incomplete_device): input device stopped …"**. The file is kept. The input closes, and Refresh + Open input works again. Never shown as "Saved". | Screenshot + JSON (`"status": "incomplete_device"`) |
| E5 | While recording, close the window → answer **No**, then close again → **Yes** | No: recording continues. Yes: the app quits. The take's JSON says `"status": "complete_shutdown"` and the WAV plays. | JSON + playback |
| E6 | While recording, kill the app: `taskkill /F /IM ProducerStudio.exe`. Restart it. | The *Incomplete recordings* list shows the `.wav.partial`. **Recover selected** creates `takeNN_….recovered.wav`. It plays up to shortly before the kill: recovery reads the bytes on disk, not the header, so only the writer's unflushed 1 MiB buffer is lost (at most about 2.7 s of stereo float32 at 48 kHz). The `.partial` file is still there. | Screenshot + both files |
| E7 | Recordings folder on a nearly full drive (see PP1_ACCEPTANCE_MATRIX §4.1: 200 MB VHD) → Record | Red "Not ready: not enough disk space. X MB free, Y MB needed …". No file created. | Screenshot |
| E8 | Recordings folder on a 400 MB VHD. Start recording, then fill the drive (`fsutil file createnew T:\fill.bin <bytes>` leaving about 5 MB) | Red **"INCOMPLETE take NN (incomplete_disk): write failed …"**. The `.wav.partial` is kept. Never "Saved". | Screenshot + `.partial` |

## 4. What this protocol does NOT test
- Live talkback, networking or producer-controlled recording (later stages).
- Alignment between two PCs.
- Long takes (> 30 min) and the WAV 4 GiB limit (6.2 h mono).

## 5. Known honest limits to state with the results
- WASAPI **shared mode**: the samples are the Windows audio engine's capture stream, after any driver or Windows processing (for example "audio enhancements"). They are **not** raw converter data. The JSON `capture.conversion_notes` lists what the app knows.
- The app records the device's **native channel count**. Many laptop mic arrays deliver 2 channels.

## 6. Log table (copy into the evidence folder)

```text
Date/time:          Tester:            PC model:           Windows build:
Commit (About):     Mic model:         Headphones:         Mic format in Windows:
| Step | ProducerStudio PASS/FAIL | PerformerClient PASS/FAIL | Notes / file names |
| §1 probe | | | |
| §2 take01..03 + external playback | | | |
| E1 .. E8 | | | |
```
