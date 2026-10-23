# ADR-020: Verified post-session take transfer: RRXF chunks with SHA-256, resume journal, producer-named copies

- **Status:** Implemented in Stage 11 (11 Oct 2026). Awaiting the researcher's review.
- **Builds on:** ADR-014 (own TCP connection, SHA-256 via Windows CNG, original never touched), ADR-012 (LAN-only security scope), ADR-016 (Qt-free sockets).
- **Changes ADR-014 in one point:** an interrupted transfer now **resumes from the last verified chunk** (XFER-04, previously LATER) instead of always restarting the whole file.
- **Control protocol 1.2:** TRANSFER_REQUEST / TRANSFER_ACK and three optional tags (PROTOCOL_OVERVIEW §15). A 1.1 performer is never asked (the producer checks the agreed minor version).
- **Traces:** XFER-01…05, VER-01, ERR-08, SEC-01…03, OQ-10, D-77…D-85

## Context
Stage 11 asks for the performer's original-quality WAV to reach the producer after a take, with:
- bounded chunks;
- per-chunk integrity checks and a whole-file cryptographic hash;
- resume after a break, mapped to the right take;
- no duplicate or overwritten takes;
- path-safe naming;
- a VERIFIED state that requires both the integrity check and the file-format check;
- the performer's original preserved.

The Opus monitoring stream is never used for this: it is lossy and not the master.

## Decision
- **Transport:** a separate TCP connection, so a large file never delays control messages (ADR-014).
  - **Port:** control port + 2 (52002 by default; media is + 1).
  - **Producer listener:** listens on the **same explicitly selected interface** as the control link (never 0.0.0.0) and accepts **only the joined performer's address**. Others are closed without a reply and counted; their log lines are rate-limited.
  - **Connections:** one at a time; a second one gets ABORT Busy.
  - **Direction:** the performer connects out, so its PC needs no inbound firewall rule.
- **Request:**
  - Only the producer starts a transfer: `TRANSFER_REQUEST(take, transfer port, one-time token)` on the control link.
  - The token is 32 random hex digits (`std::random_device`, as for the resume token). It only binds the transfer connection to this request. It is **not** an authentication mechanism against an attacker (ADR-012) and is **never logged**.
  - The performer answers `TRANSFER_ACK`. It refuses when:
    - delivery consent is not given (XFER-05);
    - a take is being recorded;
    - the take is unknown or not finalised;
    - another transfer is running.
- **Wire format RRXF v1** (own framing, PROTOCOL_OVERVIEW §15):
  - **Messages:** HELLO (magic, version, session id, token, take), OFFER, RESUME, CHUNK, ACK, NACK, DONE, RESULT, ABORT.
  - **Strict decoding:** each message has a fixed layout and is checked exactly; frames are at most 64 KiB + 44 bytes; at most one frame + 64 KiB is buffered.
  - **Why not the control TLV codec:** its fields are limited to 64 KiB and its frames to 16 KiB.
- **What the producer checks:**
  - **HELLO:** the session id equals this session, the take was requested, and the token matches. Otherwise ABORT is sent and **nothing is written**.
  - **OFFER:**
    - size range;
    - chunk size 1–64 KiB;
    - chunk count = ceil(size / chunk);
    - 32-bit float WAV, sane rate and channels;
    - frames fit in the size;
    - frames equal the performer's **TAKE_FINALISED** frame count from the control link;
    - free disk space;
    - on a later connection, the same size, hash and chunk size as the first offer.
- **Integrity:**
  - **Per chunk:** SHA-256 (32 KiB chunks by default). A mismatch gets NACK and the performer resends from that chunk; 4 rejects of the same chunk end the transfer as FAILED.
  - **Whole file:** SHA-256 of the **bytes read back from the producer's disk**, compared with the performer's hash in the OFFER.
  - **Library:** both hashes use Windows CNG (`bcrypt.dll`); there is no custom cryptography.
- **VERIFIED**, set in exactly one place, only when **all** of these hold:
  1. the whole-file hash matches;
  2. the WAV parses as a complete float32 file (`inspect_wav`);
  3. its rate and channels match the offer;
  4. its frames match the offer **and** TAKE_FINALISED;
  5. the file was renamed to its final name **without replacing anything**.

  A duplicate request for a take that already has a copy is answered "already verified" only if that copy passes the same hash and WAV checks. Nothing is rewritten.
- **States shown on both PCs:** queued, transferring, paused/retrying, verifying, VERIFIED, FAILED.
  - The performer shows VERIFIED only from the producer's RESULT.
  - QUEUED and PAUSED end as FAILED after 60 s (prov.), so a failed or silent performer never blocks the producer. The producer can also cancel.
- **Resume:**
  - **What is kept:** the producer writes `<final>.xfer.partial` plus a small journal: session, take, size, SHA-256, chunk size, verified chunks on disk.
  - **When the journal is updated:** every 16 chunks and at the end, after flushing the data to disk.
  - **On a new connection:** the producer resumes from min(journal, whole chunks on disk) only if the journal describes **exactly** this session, take and file.
  - **Torn or foreign journal:** start from 0. An unrelated partial file is renamed aside (`.stale-N`), never deleted.
- **Hash mismatch:** the received copy is renamed aside (`.rejected-N`, kept as evidence) and the performer sends the file once more from chunk 0. A second mismatch is FAILED.
- **Retry:**
  - **Performer:** retries a lost connection every 1 s and gives up after 60 s of continuous failure.
  - **Producer:** keeps a paused transfer for 60 s; a new request later resumes from the journal.
- **Naming (XFER-03):**
  - **Location and name:** the copy is `<producer session folder>/from_performer/take<NN>_performer_<session>.wav`, built only from this PC's own session id (8 hex) and the take id (1–999).
  - **Containment:** every derived path is checked to stay inside that folder.
  - **The performer's file name:** shown only after sanitising (`[A-Za-z0-9._-]`, last path component, at most 80 characters) and **never used to build a path**.
  - **Record:** after VERIFIED, a `<final>.transfer.json` record is written once (no-replace).
- **The original:**
  - **No write access:** the performer opens it **read-only with other writers refused** (`_wfsopen(..., _SH_DENYWR)`), so neither this transfer nor anything else can change it while it is being sent.
  - **Checked before and after:** it is hashed before sending and again after; "original unchanged" is shown and logged.
  - **Default:** a copy, never a move. Nothing on the performer's PC is renamed or deleted.
- **Recording safety:**
  - A queued or running transfer makes the producer NOT READY ("a take transfer is running"), and a sending performer reports itself not ready. No take starts while a file is being moved, so there is no disk or CPU contention with a recording.
  - Requests are refused while a take is armed, scheduled or recording.
  - The audio callback is not involved at all.
- **Consent (XFER-05, OQ-10):**
  - The performer allows copies **per session** with an explicit checkbox (default off). It travels to the producer in READY_STATUS (tag 36), so the producer can show why its button is disabled.
  - Without it, every request is refused.

## Measured on one PC (two probe processes; real input device; see the Stage 11 evidence)
- **Takes:** eight takes of about 20 s (48 kHz, 2 ch, float32, about 7.8 MB, 239 chunks of 32 KiB), all over loopback.
- **Copies verified:** normal, performer-side cut (resumed from chunk 100), producer-side cut (resumed from chunk 80), duplicate request (answered "already verified", nothing rewritten), one damaged chunk (rejected and resent), and a whole-file mismatch (set aside, then resent).
- **Nothing written:** wrong session ID (HELLO refused) and no delivery consent (request refused).
- **Independent checks:** Python `hashlib`, the structural WAV reader and Windows MCI.
  - Every copy is byte-identical to its original and opens at the right length.
  - Every original's hash after the run equals the app's hash before sending.
- **Throughput:** not measured as a claim. Loopback times (about 0.1–0.2 s per 7.8 MB) say nothing about a LAN.

## Consequences and limits
- **Two PCs:** not run. Real network loss, NAT and firewall behaviour, and Wi-Fi throughput are untested.
- **Security:** the LAN-only, unencrypted prototype is unchanged (ADR-012). Anyone on the LAN who can observe the control link can read the token and the audio. The token and the address check prevent accidents, not attacks. TLS is a later stage.
- **Silent link loss:** a silent loss of the transfer connection is detected by the 10 s idle timeout (producer) or 10 s reply timeout (performer).
- **One take at a time.** The producer queues automatic requests.
- **Disk-full during the transfer:** shows as FAILED with the write error. No dedicated test.
- **Qt panel:** the transfer table and buttons are written but **not compiled** (no Qt here).
