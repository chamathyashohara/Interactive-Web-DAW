# Use Cases: PP1 Baseline

**Stage 1 · 11 October 2026.** Requirement IDs refer to [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md).

**Actors**
- **Producer**: runs ProducerStudio.exe on PC-P and is the session authority.
- **Performer**: runs PerformerClient.exe on PC-R.
- **Tester**: runs the acceptance tests. In the PP1 rehearsal, the producer and the performer are also the testers.

Both PCs are on the same controlled LAN (travel router or Ethernet), as in
ASSUMPTIONS A-02.

UC-01 to UC-07 together are the panel statement. UC-08 is the optional extra
workflow. UC-09 and UC-10 are the main failure cases.

---

### UC-01 Prepare audio devices (both actors)
- **Pre:** the app is installed and started. Headphones and microphone are connected.
- **Main flow:**
  1. The app lists input and output devices (DEV-01).
  2. The user picks a mic and headphones.
  3. The meter moves when the user speaks (DEV-02), and the sample rate shows 48 kHz (DEV-05).
  4. The app reminds the user to use headphones (DEV-07).
- **Alternate flows:**
  - 1a. No input device → message, NOT READY (DEV-03).
  - 3a. The meter stays at silence → "No input signal" with mute and privacy hints (DEV-04).
  - 3b. The device is not at 48 kHz → NOT READY with instructions (DEV-05).
- **Post:** the device is open and its readiness is reported.

### UC-02 Create a session (producer)
- **Pre:** UC-01 done on PC-P.
- **Main flow:**
  1. The producer chooses **New session**.
  2. The app shows the session ID, pairing code, PC-P's IPv4 address and port, and the LAN-only security notice (SES-01, SEC-01).
  3. The producer tells the performer the IP and the code, by voice or note.
- **Post:** the app is listening for one performer.

### UC-03 Join and consent (performer)
- **Pre:** UC-01 done on PC-R, and UC-02 running.
- **Main flow:**
  1. The performer enters the IP and the code (SES-02).
  2. The connection is accepted, and both apps show **Connected** (STA-02).
  3. The performer reads the consent notice and presses **I agree** (STA-03). The producer sees "Performer consented at hh:mm".
- **Alternate flows:**
  - 1a. Wrong code, wrong IP, producer not running, firewall, or version mismatch → specific message, and the performer can retry (SES-03, APP-02).
  - 3a. The performer declines → they stay connected but NOT READY. The producer cannot record.
- **Post:** paired, with consent recorded.

### UC-04 Check readiness (both, the producer decides)
- **Main flow:**
  1. Each side reports device, sample rate, disk space and consent (SES-04, REC-09).
  2. The producer sees READY/NOT READY for both sides, with the reasons.
  3. Record is enabled only when both are READY.
- **Alternate flow:** 1a. Not enough disk space → NOT READY showing the free and required amounts (REC-09).

### UC-05 Talk before, between and during takes (both)
- **Pre:** connected.
- **Main flow:**
  1. Each person speaks and the other hears them in their headphones (COM-01).
  2. Both can see the live telemetry: RTT, packets lost and late, buffer depth (TEL-01).
- **Alternate flows:**
  - 1a. Packets are lost → short concealed glitches in what is *heard*. Recording is not affected (COM-02, REC-07).
  - 1b. Talkback is muted (COM-04, SHOULD).

### UC-06 Record a take (producer controls, both record locally): the core case
- **Pre:** UC-04 shows both READY.
- **Main flow:**
  1. The producer presses **Record**. ARM goes out with take N and start time T (SES-05).
  2. The performer's app replies ARM_ACK and shows "Recording starts in 1 s" (STA-04).
  3. At T, both PCs start writing their **own** mic to `…takeNN_<role>.wav.partial` on their **own** disk (REC-01, REC-03).
  4. Both apps show REC, take N, elapsed time, and the other side's state (STA-01, SES-07).
  5. Both people keep talking or performing while hearing each other (COM-01).
  6. The producer presses **Stop**. STOP is sent, both finalise, and both files are renamed to `.wav` (SES-06, REC-03).
  7. The performer reports TAKE_FINALISED. The producer shows "Performer take N: Saved (frames, duration)".
  8. Each app shows the path, duration and **Open folder** (REC-08).
- **Alternate flows:**
  - 2a. No ACK within the timeout, or a NACK → the take is cancelled on both sides with a message, and no file is left as "Saved".
  - 3a/5a. Live packets are lost → recording continues unaffected (REC-07, ERR-04).
  - 5b. Disk full → ERR-02.
  - 5c. Device lost → ERR-06.
  - 5d. Performer presses **Stop & save** → its own take is finalised and the producer is told (SES-08).
  - 5e. Control link lost → UC-09.
- **Post:** one complete local file **on each PC** for take N, each with its metadata. Clock offset and the estimated start offset are logged under their own names (TEL-03).

### UC-07 Verify the session's files (both PCs, after the session)
- **Main flow:**
  1. On each PC, the tester runs the verification tool on the session folder (VER-01).
  2. The report lists every take: complete or incomplete, format, frames, SHA-256.
  3. The tester plays each file in Windows Media Player or Audacity on the PC that recorded it (REC-08).
  4. Each participant confirms they can hear **their own** voice in **their own** file.
- **Post:** a verification report from each PC, stored as evidence.

### UC-08 Deliver the performer's take to the producer (optional, COULD)
- **Pre:** take N is finalised on PC-R, and the performer has agreed to delivery (XFER-05).
- **Main flow:**
  1. The performer's app sends a **copy** with its SHA-256 (XFER-01, XFER-02).
  2. The producer checks the hash and stores the copy under a name the producer's app chooses (XFER-03).
  3. The copy is marked "Verified copy".
- **Alternate flow:** 2a. Hash mismatch or interruption → retry, then "Copy failed, original still on the performer's PC".
- **Post:** the original is unchanged on PC-R, and there is a verified copy on PC-P. **This is not what makes UC-06 succeed.**

### UC-09 Control link lost during a take
- **Main flow:**
  1. The heartbeat fails, and both apps show "Connection lost, still recording" (SES-10, ERR-03, STA-02).
  2. Both keep recording locally.
  3. The producer shows the performer's take as **UNKNOWN**.
  4. The link returns, and the producer presses Stop. Or the performer presses Stop & save, or the safety limit is reached.
  5. The final status is reported once the link is back.
- **Post:** two local files, with their status shown truthfully. *(The policy waits on OQ-02.)*

### UC-10 Shut down or crash during a take
- **Main flow (graceful):**
  1. The user closes the window during a take and is asked to confirm.
  2. On confirm, the take is finalised and the peer told (ERR-05a).
- **Alternate flow (forced):**
  - 1a. The process is killed or the power fails → the `.partial` file remains.
  - 1b. On the next start, the app lists it as INCOMPLETE (ERR-05b) and may offer recovery (ERR-10, SHOULD).
- **Post:** no incomplete file is ever shown as complete (ERR-08).
