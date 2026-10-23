# System Architecture: Producer Studio and Performer Client

**Stage 2 · 11 October 2026 · status: PROPOSED, awaiting architecture review.**
Inputs:
- `docs/requirements/*` (Stage 1);
- `docs/project/REPOSITORY_AUDIT.md` (Stage 0);
- the official documentation checked on 11 Oct 2026 (§8).

This document **supersedes** the Stage 0 draft `ARCHITECTURE.md`, which is kept
for history. Detail lives in:

| Topic | Document |
|---|---|
| Components and data paths | [COMPONENT_DIAGRAM.md](COMPONENT_DIAGRAM.md) |
| Threads, queues, callbacks | [THREADING_AND_AUDIO_CALLBACKS.md](THREADING_AND_AUDIO_CALLBACKS.md) |
| States and transitions | [SESSION_STATE_MACHINE.md](SESSION_STATE_MACHINE.md) |
| Wire formats, codes, timeouts | [PROTOCOL_OVERVIEW.md](PROTOCOL_OVERVIEW.md) |
| Decisions | [adr/](../adr/README.md) (ADR-001 … ADR-015) |

---

## 1. Principle
The audio that is **kept** (each PC's master WAV) and the audio that is
**heard** (the live stream) travel on separate paths.
- The master path is: capture callback → bounded ring → recorder thread → local disk. Nothing from the network can write into it.
- The live path can lose, delay and conceal audio, and that is the only place where it does.

The only cross-PC influence on a recording is *when* it starts and stops, set
by an acknowledged schedule. It never changes the content.

## 2. Structure (ADR-001)
- **`rr_core`** (C++17, no Qt): audio, recording, live media, protocol codecs, state tables, timing, telemetry, verification.
- **`rr_app`** (Qt 6): session controller, control transport, shared widgets.
- **ProducerStudio.exe / PerformerClient.exe:** role windows only.
- **`rr_verify.exe`:** verification CLI.

Both apps share more than 90 % of the code. The roles differ in:
- the state-machine table (SESSION_STATE_MACHINE §3.3 vs §3.4);
- which side listens (the producer);
- the window layout.

## 3. Audio policies

| Item | Policy | Basis |
|---|---|---|
| Device sample rate | Native rate only, no conversion. Readiness requires **48 000 Hz** (OQ-11). | ADR-003. Prototypes. Opus supports 48 kHz. |
| Master file | WAV IEEE float **32-bit**, native rate, native channels *(amendment A-1 pending)*, `.partial` → rename, header refresh every 5 s | ADR-007 |
| Bit depth on the master path | float32 exactly as the device delivers it. No dither, gain or limiting. | BRIEF (original quality) |
| Live format | Mono downmix, 48 kHz. PCM16 first, then Opus 1.6.1 | ADR-006 |
| Live frame duration | **10 ms** default (prov.). 2.5/5/10/20 ms allowed (40/60 with Opus). Fixed for a session. | Prototype working value. RQ1 variable. **Not claimed optimal.** |
| Device period | 10 ms requested (prov.), shared mode, low-latency profile. Actual sizes logged as "reported device buffering". | ADR-003 |
| Jitter buffer | Fixed depth D = 3 frames (prov.), range 1–16. Loss/late/underrun/rebuffer/drift-skip rules. | ADR-011, PROTOCOL §3.3 |
| Concealment | Playback and monitor file only | BRIEF |

## 4. Time, synchronisation and measurement definitions

Every quantity has one name, one definition and one unit. The UI, CSV and
reports use exactly these names (RES-01).

Notation:
- t is a monotonic time in ns on the named PC (`steady_clock`, which is QPC);
- P = producer, R = performer.

| Name (exact label) | Definition | Unit | Where it comes from | Not to be confused with |
|---|---|---|---|---|
| **Control RTT** | Time from sending HEARTBEAT to receiving its ACK over TCP. Includes the TCP stack and the control thread's event loop. | ms | T7 | Probe RTT, network delay |
| **Probe RTT (δ)** | δ = (t4 − t1) − (t3 − t2) for one UDP probe, which excludes the responder's processing | ms | T4/T5 | Control RTT |
| **Estimated clock offset (θ̂)** | θ of the probe with the minimum δ among the last 16. θ = ((t2 − t1) + (t3 − t4)) / 2 is an estimate of *responder clock − requester clock*. | ms | T5 | Recording-start offset |
| **Offset uncertainty (u)** | u = δmin / 2. The true offset lies within θ̂ ± u if the timestamps are exact; asymmetric network paths cannot push it outside that range. | ms | T5 | — |
| **Network one-way delay** | **Not measured.** It needs synchronised clocks. If shown at all, then only as "estimated one-way transit = t_arrival − (t_send + θ̂) ± u". | — | — | RTT/2 |
| **Packets lost (network)** | Sequence numbers never received within a 64-packet reorder window | count, % | T5 | Concealed frames |
| **Frames concealed (playout)** | Frames played as concealment = lost-at-playout + late + underrun | count, % | T2 | Network loss |
| **Late packets** | Arrived after their frame had already been played or concealed | count | T2 | Lost |
| **Arrival jitter (J)** | RFC 3550 §6.4.1: D = (R_j − R_i) − (S_j − S_i), J ← J + (\|D\| − J)/16. S comes from `capture_index` ÷ 48 000 and R from the local arrival time. | ms | T5 | Jitter-buffer depth |
| **Jitter-buffer depth** | Target D (configured), and the current fill = frames queued ahead of playout | frames, ms | T2 | Arrival jitter |
| **Reported device buffering** | miniaudio's internal period size × period count ÷ rate, for capture and playback | ms | T1/T2 init | Device latency (the true acoustic latency is **not measured** in PP1) |
| **Recording-start offset (estimated)** | Δ_start = (t̂_R(S_R) − θ̂) − t̂_P(S_P), where t̂_X(S) is the stamp-regression time of the first sample on PC X. Uncertainty = u + both stamp residuals. **Excludes the difference in device input latency.** | ms ± | TAKE_STARTED + metadata | Alignment residual |
| **Sample-clock drift** | Per PC: ε = (device frames ÷ 48 000) ÷ (Δt_mono) − 1 (device vs local QPC). Across the two PCs: the slope of θ̂(t) combined with both ε values. **Raw data logged in PP1, analysed later.** | ppm | T6 log | Offset |
| **Final alignment residual** | The lag, in samples, of the peak cross-correlation between a shared, electrically fed reference signal in both masters, after alignment (proposal §3.3) | samples, µs | **LATER-04**, offline | Everything above. It is *never* inferred from the estimates above. |
| **Record overrun** | Frames dropped from the REC ring (REC-05), with positions | frames | T1 | Live loss |
| **Callback duration (max)** | Longest time spent in T1 or T2 per second | µs | T1/T2 | — |

**Honest statement for PP1:**
- A scheduled, acknowledged start lines up the *callback-arrival timelines*, within the reported uncertainty.
- It does not prove sample-accurate alignment.
- Alignment accuracy is measured later.

## 5. Session control (summary)
- **Link and session/take machines:** separate, with explicit transition tables (SESSION_STATE_MACHINE).
- **Pairing:** typed IP plus pairing code. One performer per session.
- **Readiness:** device, rate, disk, consent, link, and the UDP media path verified by probes.
- **Arm:** ARM → ARM_ACK required before T − 100 ms. Otherwise CANCEL.
- **Start:** scheduled start T = now + 1 s (prov.). Scheduled stop with a 300 ms lead (prov.).
- **After stop:** TAKE_FINALISED is reported. The peer's status is UNKNOWN until that report arrives.
- **Link lost mid-take:** both PCs keep recording locally (pending OQ-02).

## 6. Security (ADR-012)
- **PP1:** LAN-only, unencrypted and unauthenticated. This is stated in both apps, the README and the NOTICE.
- **Cheap protections:**
  - peer address filtering;
  - full input validation;
  - size caps;
  - receiver-chosen file names;
  - a cap on pairing attempts.
- **Future:** an established TLS/DTLS stack (Qt Network backends, checked with `isFeatureSupported`). **Never custom cryptography.** SHA-256 for verification comes from Windows CNG.

## 7. Windows build and packaging requirements
| Item | Requirement | Status on this PC (Stage 0 audit) |
|---|---|---|
| Compiler | MSVC v143 (VS 2022 Build Tools, VCTools workload) | **Missing** |
| SDK | Windows 10/11 SDK (comes with VCTools) | **Missing** |
| CMake / Ninja | CMake ≥ 3.21 / Ninja | Present (4.4.2 via WinLibs). The VS-bundled one is preferred. |
| Qt | 6.11.3 `msvc2022_64`, Base only | **Missing** |
| miniaudio | 0.11.25 header vendored in `third_party/` with SHA-256 | To vendor in I-1 |
| libopus | 1.6.1, CMake (`-A x64`), static | I-5 |
| Catch2 | v3.16.0 (tests) | I-1 |
| Runtime on demo PCs | Official `vc_redist.x64.exe`. The `windeployqt` folder including `platforms/qwindows.dll`. | — |
| Licence files | LGPL-3.0/GPL-3.0 texts, Qt notices, Opus BSD-3 notice, miniaudio MIT-0/Unlicense notice (optional), Catch2 not shipped | I-1 checklist |

## 8. Dependency decisions, checked against official sources on 11 Oct 2026

| Dependency | Decision | Version | Licence and obligations | Key facts checked | Main risk |
|---|---|---|---|---|---|
| miniaudio | **Adopt** | 0.11.25 | Public domain or MIT-0. No attribution required. | Native rate with `sampleRate = 0`. Lock-free SPSC rings. Never start/stop from the callback. Notification types and their limits. WASAPI `noAutoStreamRouting`/`noAutoConvertSRC`. | Notification coverage, thread priority (verify) |
| Qt 6 Core/Gui/Widgets/Network | **Adopt** (OQ-05) | 6.11.3 | LGPL-3.0, dynamic. Source/offer, relink ability, notices. | Windows 10 1809+/11, MSVC 2022. Base modules not GPL-only. Schannel/OpenSSL TLS backends. | LGPL compliance work. Windows 10 support ends after 6.12. |
| libopus | **Adopt in I-5** (order per OQ-03) | 1.6.1 | BSD-3, royalty-free patent grants | Frame sizes 2.5–60 ms. PLC via NULL. CMake on VS 2022 x64. | Build integration, decode cost in the callback |
| Catch2 | **Adopt, test-only** | v3.16.0 | BSL-1.0, not shipped | C++14 minimum. `Catch2WithMain`. | — |
| Standalone Asio | Reject | — | — | Qt Network + Winsock cover the needs | — |
| SQLite | Reject for PP1 | — | — | No persistence need (ADR-013) | — |
| libsamplerate | Reject for PP1 | — | — | No conversion need shown (ADR-013) | — |
| OpenSSL | Not now | — | Apache-2.0 (3.x), must be deployed separately if used | Qt docs say OpenSSL is needed at runtime if chosen | Deferred to the security stage |

Sources:
- miniaudio manual <https://miniaud.io/docs/manual/index.html>, plus the v0.11.22 header (notifications, WASAPI fields)
- Opus encoder and decoder API <https://opus-codec.org/docs/opus_api-1.5/>, licence <https://opus-codec.org/license/>, downloads <https://opus-codec.org/downloads/>, CMake README <https://github.com/xiph/opus/blob/main/cmake/README.md>
- Qt platforms <https://doc.qt.io/qt-6/supported-platforms.html>, licensing <https://doc.qt.io/qt-6/licensing.html>, LGPL obligations <https://www.qt.io/licensing/open-source-lgpl-obligations>, SSL <https://doc.qt.io/qt-6/ssl.html>, QSslSocket <https://doc.qt.io/qt-6/qsslsocket.html>, Windows deployment <https://doc.qt.io/qt-6/windows-deployment.html>, CMake getting started <https://doc.qt.io/qt-6/cmake-get-started.html>
- Catch2 releases <https://github.com/catchorg/Catch2/releases>, v2→v3 migration notes (C++14)

**Not verified yet, to check in I-1:**
- the thread priority (MMCSS) of miniaudio's WASAPI threads;
- Qt's exact minimum CMake version;
- which TLS features Schannel supports;
- the 0.11.25 header fields, re-checked against v0.11.22.

## 9. Requirement coverage (MUST requirements → where the architecture handles them)
| Requirement group | Handled by |
|---|---|
| APP-01/02 | ADR-001/002, PROTOCOL §7 |
| DEV-01…05 | ADR-003, `rr_core/audio`, readiness guard |
| REC-01…09 | ADR-007, THREADING §3/§7, COMPONENT §2 |
| SES-01…08 | SESSION_STATE_MACHINE, PROTOCOL §5 |
| COM-01…03 | ADR-005/006/008/011, PROTOCOL §2–3 |
| STA-01…05 | SESSION_STATE_MACHINE §5, CONSENT message |
| ERR-01…08 | State tables, PROTOCOL §6, THREADING §8 |
| TEL-01, TST-01 | §4, THREADING §9. The test mode lives in `rr_core/live` (loss) and `rr_core/record` (stall). |
| VER-01/02 | `rr_verify`, ADR-014 |
| SEC-01…03, RES-01 | ADR-012, §4 |

## 10. Proposed requirement amendments (need the researcher's approval)
| ID | Change | Reason |
|---|---|---|
| A-1 | REC-02: record the device's **native channel count (1 or 2)**, not forced mono | Forcing 1 channel makes miniaudio downmix, which changes the original (ADR-007, OQ-12) |
| A-2 | SES-04: add "**media path verified**" (UDP probes answered both ways) to readiness | Otherwise a firewall blocking UDP gives a "Ready" session with no live audio |
| A-3 | ERR-03 / SES state: a link lost **before** T in Scheduled **cancels** the take. Only a take already Recording continues. | Never start a recording that the producer cannot see or stop |
| A-4 | TEL-01: label "control RTT" separately from "probe RTT" | Two different measurements (§4) |

## 11. Risk register
| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | Toolchain not installed in time for PP1 (~20 Oct) | High / High | Install today. The Rust prototype is the declared fallback (OQ-07). |
| R2 | Device unplug not reported by WASAPI or miniaudio | Medium / High | Explicit device IDs, no auto-routing, watchdog (ADR-003) |
| R3 | Opus decode cost in the callback causes playback glitches | Low–Medium / Low (live only) | Measure the callback duration. Fallback decode thread (ADR-011). |
| R4 | Laptop mic arrays: native rate not 48 kHz, or 2 channels | Medium / Medium | Clear NOT READY instructions. Amendment A-1. |
| R5 | Campus network blocks peer traffic | High / High | Controlled LAN (A-02). Readiness requires the media path (A-2). |
| R6 | LGPL obligations missed when handing over binaries | Medium / Medium | Packaging checklist in I-1 (ADR-004) |
| R7 | Misreading estimates as measured alignment | Medium / High (research validity) | §4 naming rules, RES-01 review (T-16) |
| R8 | Disk stall > 10 s overflows the REC ring | Low / High | Overrun counted with positions and `has_gaps`. Forced in T-11c. |
| R9 | Clock drift between two independent devices fills or empties the jitter buffer | Certain over long runs / Low | Drift-skip rule, counted |
