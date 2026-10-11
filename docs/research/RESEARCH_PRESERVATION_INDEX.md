# Research Preservation Index

**Project:** J26-IM-303 · IT4010 · Component 04 (Interactive Remote Recording & Communication)
**Researcher:** Chandrasena P K H P (IT23251182)
**Index taken:** 11 October 2026 (Stage 0 audit)

This index points to the original files. It does **not** copy them. Nothing
listed here was moved, edited or deleted during Stage 0.

The C++ prototype zip was *extracted into a temporary scratch folder* so it
could be read and built. The original zip is untouched.

The SHA-256 prefix (first 16 hex characters) shows whether a file has changed
since this index was made. To check one:

```powershell
(Get-FileHash -Algorithm SHA256 "D:\DAW RESEARCH\PP1\duplexrec-rs\src\packet.rs").Hash.Substring(0,16).ToLower()
```

**Preserve?** = must be kept. Never delete or overwrite these files.
**Status:** *Current* = governs the C++17 work. *Reference* = cite or learn from it. *Historical* = earlier direction, kept as evidence and not a dependency. *Unrelated* = not Component 04.

---

## 1. Literature

| SHA-256 prefix | Path (under `D:\DAW RESEARCH\`) | Identified as (from PDF metadata) | Proposal v2 ref | Status | Preserve? |
|---|---|---|---|---|---|
| 19870b9a5d0493dc | `An_Overview_on_Networked_Music_Performance_Technologies.pdf` | Rottondi et al., *IEEE Access* 2016 | [1] | Reference | Yes |
| 19870b9a5d0493dc | `LATENCY\An_Overview_on_…Technologies.pdf` | Byte-identical duplicate of the above (`cmp`) | [1] | Reference | Yes (duplicate, harmless) |
| 56416781f8ae91ee | `LATENCY\How_Late_is_Too_Late_…_AR_Remote_Musical_Collaboration.pdf` | File name only (metadata not read) | [8] | Reference | Yes |
| 947e01239499116f | `LATENCY\TimeisnotonmysideCIMXXII.pdf` | File name only (no metadata title) | [9] | Reference | Yes |
| 8337e78be8dfd049 | `SYNCHRONIZE\3543873.3587987.pdf` | **"WAM-studio, a Digital Audio Workstation (DAW) for the Web"**, M. Buffa et al., ACM | [4] | Reference | Yes |
| 6abd4f13af6001a3 | `s11042-024-20448-9.pdf` | **"A systematic review on WebRTC for potential applications and challenges beyond audio video streaming"**, *Multimedia Tools and Applications* | [2] | Reference (history of the WebRTC direction) | Yes |
| 7dfa70b0362913cf | `Democratizing_Networked_Music_Performance_with_a_RL-Based_SD-WAN.pdf` | *IEEE Communications Magazine* 62(12), 2024, doi 10.1109/MCOM.001.2400171 | not cited | Reference | Yes |
| a6f036616f46352f | `The_Internet_of_Sounds_Convergent_Trends_Insights_and_Future_Directions.pdf` | *IEEE Internet of Things Journal* 10(13), 2023, doi 10.1109/JIOT.2023.3253602 | not cited | Reference | Yes |

**Citation check needed:** proposal v2 lists ref [2]'s authors as "A. Mahmoud and
M. Aboelela". The PDF's `/Author` metadata says "Vivek K.", which may be a
typesetter. Check the author list on the PDF's first page before final submission.

The PDFs' contents were not summarised. Only their identity was confirmed.

## 2. Proposal and assessment documents

| SHA-256 prefix | Path | What it is | Status | Preserve? |
|---|---|---|---|---|
| 33c255ae5be9748b | `D:\DAW RESEARCH\IT4010_TAF_R2 v3.pdf` | Topic Assessment Form | Reference | Yes |
| 2aa70b68cf112851 | `D:\DAW RESEARCH\IT23251182_Proposal_RemoteRecordingModule.docx` | 21 Aug draft, 2 173 words. Browser module: WebRTC, Node/Express, React, MongoDB. | Historical | Yes |
| 31b1c3cfee85ce92 | `C:\Users\ASUS\Downloads\Proposal_Report_IT23251182.docx` | 31 Aug, 5 053 words, WebRTC direction | Historical | Yes |
| f600945111e3084b | `…\Downloads\Proposal_Report_IT23251182 (1).docx` | 4 Sep, 5 891 words, WebRTC + MongoDB | Historical | Yes |
| ffbfa8b4a8b4d0a9 | `…\Downloads\Proposal_Report_IT23251182 (2).docx` | 5 Sep, 6 370 words, WebRTC | Historical | Yes |
| 055189871b8cf3a4 | `…\Downloads\Proposal_Report_IT23251182 (3).docx` | 5 Sep, 6 331 words, WebRTC. **Not** the standalone revision, despite the "(3)" in its name. | Historical | Yes |
| f68d21080a99e914 | `…\Downloads\Proposal_Report_IT23251182_V1.docx` | 13 Sep (saved 16:46 UTC), 5 899 words, WebRTC + MongoDB | Historical | Yes |
| 57852109ae9603a1 | `…\Downloads\Proposal_Report_IT23251182_v2.docx` | 13–14 Sep, 10 909 words. **Standalone C++17, dual-path capture**, RQ1–4, H1–3, FR1–10, NFR1–10, Appendix B. **Newest standalone proposal on disk.** | **Current** | **Yes. It exists only in Downloads, so back it up.** |

**"Revision 3" was not found.** No file on disk is labelled Revision 3. The
newest standalone proposal (v2) still contains "24-byte" (2×) and an "80 ms"
mention. That means the 28 Sep corrections in the chat record (26 bytes, 60 ms)
are **not** in any proposal file on this PC. If a Revision 3 exists (for example
as a claude.ai download), it has to be supplied before the audit can count as
covering it.

## 3. Decision and progress records

| SHA-256 prefix | Path | What it is | Status | Preserve? |
|---|---|---|---|---|
| 7b3e7bd444b1b0ac | `D:\DAW RESEARCH\PP1\DAW_Component04_Chat_Record.md` | Organised record of 7 Sep to 10 Oct 2026: panel feedback, dual-path idea, Opus frame facts, header correction, drift arithmetic, PP1 plan | **Current** | Yes |

## 4. Prototype code and data

### 4.1 C++17 / miniaudio prototype (`duplexrec-pp1.zip`)

| SHA-256 prefix | Path | Status | Preserve? |
|---|---|---|---|
| fd21eb835f635fa2 | `C:\Users\ASUS\Downloads\duplexrec-pp1.zip` (9 Oct 2026, 1 761 853 B) | **Working** (on loopback, see the audit) | **Yes. It exists only in Downloads, so back it up.** |

Contents: `src/main.cpp` (1 109 lines, single file), `src/miniaudio.h` v0.11.22,
`src/miniaudio_impl.c`, `CMakeLists.txt`, `README.md`, `tools/plot_take.py`,
`example/` (json, csv, png), and `bin/windows/duplexrec.exe` (cross-compiled).

### 4.2 Rust / cpal reference prototype (`duplexrec-rs`)

Path: `D:\DAW RESEARCH\PP1\duplexrec-rs\` · Status: **Working** (on loopback; 14/14 unit tests) · Preserve: **Yes**. It is not a git repository, so the hashes below are its only change record.

| SHA-256 prefix | File | | SHA-256 prefix | File |
|---|---|---|---|---|
| 3e751f23295b0c6d | `Cargo.toml` | | 4282341dddeeec81 | `src/recorder.rs` |
| 9f236880322de06f | `Cargo.lock` | | 124a4eddc38a3aad | `src/shared.rs` |
| c5faefa6273347b5 | `README.md` | | 2982298e9dd4285d | `src/stats.rs` |
| 4c8b389d3a2ae9fb | `src/audio.rs` | | 1e9f511d73de2e9d | `src/transfer.rs` |
| c8d110205578ae7e | `src/jitter.rs` | | 5c37b8b92427bd79 | `tools/plot_take.py` |
| aee32c51b950075c | `src/main.rs` | | 5342703a71aa84ca | `example/take01_B.png` |
| 944740ac635ddf6e | `src/net.rs` | | d76b0dbdb1cf5b5a | `example/take01_B.json` |
| 2809d9092d08be5b | `src/packet.rs` | | 5cf1e9fe736b2af8 | `example/take01_B_concealed.csv` |

### 4.3 Portable Rust build and recorded takes

Path: `D:\DAW RESEARCH\PP1\duplexrec-portable\` · Preserve: **Yes** (measurement evidence).

| SHA-256 prefix | File | Notes |
|---|---|---|
| 5bc6986701e74478 | `duplexrec.exe` | Byte-identical to `duplexrec-rs\target\release\duplexrec.exe` |
| e0024ad7537a4568 | `HOW TO RUN.txt` | Two-laptop instructions |
| da0392315feea94f / 28aaff3229a34e5a | `takes/take0{1,2}_B.json` | 9 Oct 21:51. RTT ≈ 0.9–1.1 ms, **wall-clock offset ≈ 295.5 ms**, take 1: 1 concealed segment, 17 late |
| bf05594a67b0e8c2 / 4dfe6a57b77ead9e / b56270b043d0ebf1 / 2f76ef0d33bd08d7 | `takes/take0{1,2}_B_{local,monitor}.wav` | 32-bit float, 2.9 s and 1.55 s |
| 4352f49ce88f0ad7 / b8c6cf0c5f344008 / c9dce92957a17dc5 | `takes/stats_*.csv` | `stats_A_461b6f67.csv` (10 Oct, 5.3 MB) starts with `in_peak_db = -120`, meaning no input signal at that point |

**Provenance unknown.** The ~295 ms wall-clock offset with ~1 ms RTT suggests
two different machines on a LAN, because two processes on one PC share a wall
clock. No document records that run. **The researcher must confirm the hardware
before calling these files a two-PC test.**

### 4.4 Browser prototypes (Historical, not runtime dependencies)

| Path | Files (excl. node_modules/build) | What it is | Preserve? |
|---|---|---|---|
| `D:\DAW RESEARCH\TESTING\TESTING-4\` | 42 | Node/Express/Socket.IO + React/TS, WebRTC voice, MediaRecorder, markers (matches the 21 Aug proposal) | Yes (historical) |
| `D:\DAW RESEARCH\TESTING\TESTING-2\` | 35 | "Remote DAW Studio" WebRTC prototype + `server-go` | Yes (historical) |
| `D:\DAW RESEARCH\TESTING\TESTING\` | 12 | `remote-studio-prototype` (Vite) | Yes (historical) |
| `D:\DAW RESEARCH\TESTING\TEST-10\` | 150 | `hiruna-portfolio`, a Firebase portfolio site | **Unrelated** (not Component 04) |

### 4.5 Other

| SHA-256 prefix | Path | What it is | Status |
|---|---|---|---|
| c4b74944d367d1a4 | `D:\DAW RESEARCH\images.jpg` | Photo of the Colombo skyline (Lotus Tower), viewed | Unrelated (decorative). Keep. |
| — | `D:\DAW RESEARCH\PP1\TEST\` | Empty folder | — |

## 5. Missing materials (searched, not found, contents NOT invented)

The search covered all of `C:\Users\ASUS` and `D:\`, recursively, for
`component4*`, `*chat-record*`, `*Chat_Record*` and `daw-alignment-spike*`, plus
any folder named `claude`.

| Requested or referenced item | Result | Likely location |
|---|---|---|
| `claude/component4-standalone-revision.md` | **Not found** | claude.ai Project knowledge (chat record §13 says "saved in the DAW RESEARCH project") |
| `claude/component4-chat-record.md` | **Not found** under that name. `PP1\DAW_Component04_Chat_Record.md` exists and is probably the same record. | claude.ai Project |
| `claude/component4-pp1-prototype.md` | **Not found** | claude.ai Project |
| `claude/component4-pp1-rust.md` | **Not found** | claude.ai Project |
| `component4-figure-briefs.md`, `component4-test1-alignment-spike.md` | **Not found** | claude.ai Project |
| `Proposal_Report_IT23251182.docx` **(Revision 3)** | **Not found**. See §2. | Supply it if it exists |
| `daw-alignment-spike.zip` (Test 1 kit: reference/record/analyse/selftest .py) | **Not found** | Chat download |
| `pp1-example-take01_B.png` | Not found under that name. Similar charts exist: `duplexrec-rs\example\take01_B.png` and `example/take01_B.png` inside the zip. | — |
| Figures 1–5 (hand-drawn diagrams) | **Not found.** The proposal still has placeholders. | Not yet drawn |
| Appendix A interview/survey evidence | **Not found** | Not yet collected |
| Bibliography file (.bib / Zotero export) | **None found.** References exist only inside proposal v2. | — |
| Screenshots of prototype runs | **None found** | — |

## 6. Scope as it stands (extracted, the originals are unchanged)

**Current standalone scope:** proposal v2 (standalone C++17, dual-path capture)
plus the researcher's 11 Oct 2026 decision. That means two native Windows apps,
*Producer Studio* and *Performer Client*, built from one C++17 codebase.

**Panel acceptance criterion (PP1 comment sheet, quoted in the chat record §9.1 and both prototype READMEs):**

> "Candidate said: remote recording (to local storage) by 2 people and audio communication between the two."

**Historical wording, kept as evidence but no longer governing:**

| Source | Historical wording | Current position |
|---|---|---|
| 21 Aug draft and drafts of 31 Aug to 13 Sep | "without leaving the browser", WebRTC, Web Audio, Node/Express signalling, React, MongoDB, "upload takes to the backend" | Replaced by standalone native (proposal v2 §1.2, decision D-01) |
| Proposal v2 §4.5 | "imported into the shared Web DAW project" as a session manifest | **Project-level** integration only (export files). No runtime dependency. Deferred (FR9). |
| Proposal v2 §4.6 | JUCE 7, standalone Asio, libsamplerate, SQLite | Stays a proposal-era stack. See `docs/architecture/DEPENDENCIES.md` for the current minimal set. |
| Proposal v2 §4.3 | "fixed 24-byte header" | Correct value is **26 bytes** (Table 2 fields add up to 26). Still uncorrected in v2. |
| Proposal v2 Table 3 / text | "80 ms" segment | The Opus *encoder* frame sizes are 2.5–60 ms, so there is no 80 ms frame. Use **60 ms**. (The decoder accepts *packets* of up to 120 ms, so say "frame" precisely; see ADR-006.) Still uncorrected in v2. |
| Proposal v2 NFR7 (encryption), NFR8 (4 participants), NFR10 (macOS) | — | Not part of the PP1 target. Later, separately documented stages. |

## 7. Backup recommendation (not done by the agent)

Two files that govern the work exist **only** in Downloads. The researcher should
copy them (copy, not move) into the research folder:

```powershell
Copy-Item "C:\Users\ASUS\Downloads\Proposal_Report_IT23251182_v2.docx" "D:\DAW RESEARCH\"
Copy-Item "C:\Users\ASUS\Downloads\duplexrec-pp1.zip" "D:\DAW RESEARCH\PP1\"
```
