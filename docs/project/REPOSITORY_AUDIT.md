# Repository and Prototype Audit (Stage 0)

**Date:** 11 October 2026 · **Machine:** the researcher's single Windows 11 Pro PC (10.0.26300)
**Companion index:** [../research/RESEARCH_PRESERVATION_INDEX.md](../research/RESEARCH_PRESERVATION_INDEX.md)

No product features were implemented in Stage 0. Every build and run result
below comes from a command that was actually run. Results that could not be
obtained are marked **NOT RUN** and the reason is given.

---

## 1. Repository map

There is no single existing repository. The work is spread over four places:

| Location | Kind | Build system | Language | Version control |
|---|---|---|---|---|
| `D:\DAW RESEARCH\PP1-TEST\` | **New C++17 repo (this one)**. Documents only. | none yet (CMake planned) | — | git, initialised 11 Oct 2026 |
| `C:\Users\ASUS\Downloads\duplexrec-pp1.zip` | C++17 prototype (archive) | CMake ≥ 3.16 | C++17 + C (miniaudio impl) | none |
| `D:\DAW RESEARCH\PP1\duplexrec-rs\` | Rust reference prototype | Cargo | Rust edition 2024 | **none**. Only `.gitignore` is present. |
| `D:\DAW RESEARCH\TESTING\TESTING*` | Browser prototypes (historical) | npm / Vite | TypeScript / JS (+ Go in TESTING-2) | not checked |

### 1.1 C++17 prototype `duplexrec-pp1.zip`

| Aspect | Finding |
|---|---|
| Entry point | `src/Main.cpp` → `main()` (single 1 109-line file, CLI) |
| Dependencies | miniaudio **v0.11.22** (vendored header), `ws2_32` (Winsock), C++17 `<filesystem>`, `<thread>` |
| Audio code | `data_cb` (duplex callback): tone/mic → `localRb`, `netRb` (miniaudio `ma_pcm_rb`). Jitter-buffer playout → output → `monRb`. Meters via atomics. |
| Network code | One UDP socket. `sender_thread` (PCM16 segments, 26-byte header, CRC-32, 1 Hz ping). `receiver_thread` (validate, jitter-buffer insert, control, ping/pong). `SIO_UDP_CONNRESET` workaround. |
| Recording | `writer_thread`: `ma_encoder` WAV float32 for `_local` and `_monitor`, concealment CSV, take JSON |
| Control | `r`/`q` on stdin. START/STOP sent **over UDP, 3 times, with no acknowledgement**. Either peer can start a take. |
| Clock | Ping/pong with `steady_clock` (monotonic) |
| Tests | **None** |
| Generated artefacts | `takes/takeNN_<name>_{local,monitor}.wav`, `_concealed.csv`, `.json`, `stats_<name>_<session>.csv`. A prebuilt `bin/windows/duplexrec.exe` is included. |
| Docs | `README.md` (build, run, demo script, viva notes) |

### 1.2 Rust reference prototype `duplexrec-rs`

| Aspect | Finding |
|---|---|
| Entry point | `src/main.rs` (CLI with an interactive prompt when double-clicked) |
| Dependencies | cpal 0.18, rtrb 0.4, hound 3.5, ctrlc 3.5 (`Cargo.lock` pinned). Toolchain `stable-x86_64-pc-windows-gnu`. |
| Audio code | `audio.rs`: separate input and output callbacks, `rtrb` SPSC rings, requires the device at 48 kHz |
| Network code | `net.rs` (UDP send/recv, ping/pong with **wall clock**), `packet.rs` (same 26-byte header, CRC-32), `jitter.rs` |
| Recording | `recorder.rs` (hound WAV float32) |
| Control | `--role main/remote`. **Only main starts and stops** (remote ignores `r`, main ignores incoming START/STOP). Control goes over UDP, 3 times, no ACK. |
| Take transfer | `transfer.rs`: after each take, remote → main over TCP. `DXF1` magic, name, u64 size, bytes, 1-byte ACK. File-name allowlist. **2 full retries. No checksum, no chunking, no resume.** |
| Tests | 14 unit tests (packet 7, jitter 6, transfer 1) |
| Generated artefacts | Same file family as C++ (remote keeps no monitor WAV), plus the transferred `takeNN_B_*` on main |
| Docs | `README.md`, `..\duplexrec-portable\HOW TO RUN.txt` |

## 2. Inventory: what exists and what state it is in

| Path | Purpose | Status | Preserve? |
|---|---|---|---|
| `PP1-TEST\README.md`, `PP1-TEST\docs\**` | Stage 0 audit, architecture, plan | Working (documents) | Yes |
| `Downloads\duplexrec-pp1.zip` | C++17 PP1 prototype | **Working on loopback** (see §3). Two-PC not tested. | **Yes. Back up out of Downloads.** |
| `PP1\duplexrec-rs\` | Rust reference prototype | **Working on loopback**, 14/14 tests | **Yes** |
| `PP1\duplexrec-portable\` | Rust portable exe + 9 Oct takes | Working exe. Takes are evidence of **unknown provenance**. | Yes |
| `PP1\DAW_Component04_Chat_Record.md` | Decision record | Reference (current) | Yes |
| `Downloads\Proposal_Report_IT23251182_v2.docx` | Current standalone proposal | Reference (current) | **Yes. Back up out of Downloads.** |
| Earlier proposal drafts (6 files) | Browser-era drafts | Historical | Yes |
| Literature PDFs (8 files, 1 duplicate) | Literature | Reference | Yes |
| `TESTING\TESTING`, `TESTING-2`, `TESTING-4` | WebRTC/React prototypes | Historical, **NOT RUN** (out of scope) | Yes |
| `TESTING\TEST-10` | Portfolio website | Unrelated | Not Component 04 (do not touch) |
| `PP1\TEST\` | Empty folder | Unknown | — |
| Producer Studio / Performer Client | Final two-app product | **Planned. No code exists.** | — |

## 3. Build and run status (actual commands, actual output)

All prototype runs wrote **only** into the session scratch folder
(`…\Temp\claude\…\scratchpad\runs\`). No project data was written or overwritten.
The C++ zip was extracted to `scratchpad\cpp_proto_extract\`; the original zip is
unchanged. The test scripts are [`tools/audit/loopback.sh`](../../tools/audit/loopback.sh) (two copies on
127.0.0.1, ports 51000/51002, `--null-audio`, tones 440 and 660 Hz, A presses
`r` at about 3 s and 9 s) and [`tools/audit/analyse_wav.py`](../../tools/audit/analyse_wav.py) (standard
library only; counts 10 ms blocks whose RMS differs by more than 10 % from the
median).

| # | What | Command | Result |
|---|---|---|---|
| R1 | Rust unit tests | `cargo test --release` in `duplexrec-rs` | **14 passed, 0 failed** |
| R2 | Rust device list | `duplexrec.exe --list-devices` | WASAPI: 2 inputs (Realtek mic array, Oculus), 3 outputs |
| R3 | Rust loopback, main/remote, A `--sim-loss 10` | `loopback.sh <rust exe> runs/rust "--role main --sim-loss 10" "--role remote"` | Both exit 0. Take 1 started on A, followed on B "(by peer)". A dropped 142 packets, B concealed 142 (10.09 %). **Local WAVs: 0/603 and 0/602 damaged blocks**, 440/660 Hz. B's take was delivered to A over TCP. **`cmp` shows the transferred copy is byte-identical.** |
| C1 | C++ MinGW build (dynamic) | `cmake -G Ninja … -DCMAKE_CXX_COMPILER=g++` + `cmake --build` (g++ 16.2.0) | Builds. **The exe will not start (exit 127).** It depends on `libstdc++-6.dll`/`libgcc_s_seh-1.dll`, and Git's older MinGW DLLs come first on PATH. |
| C2 | C++ MinGW build (static) | same with `-DCMAKE_EXE_LINKER_FLAGS=-static` | Builds and runs |
| C3 | C++ warnings | `g++ -std=c++17 -Wall -Wextra -fsyntax-only Main.cpp` | **0 warnings** |
| C4 | C++ device list (own build and bundled exe) | `duplexrec.exe --list-devices` | WASAPI devices listed. This is the **first recorded run of the bundled exe on real Windows**; the chat record says it had never been run. |
| C5 | C++ loopback, own static build, A `--sim-loss 10` | `loopback.sh <static exe> runs/cpp "--sim-loss 10" ""` | Both exit 0. B started "(peer)". A dropped 139, B concealed 139 (9.84 %), 49 of them during the take (49 lines in the concealment CSV). **Local WAVs: 0/604 damaged blocks each**, 440/660 Hz. B monitor: 94/604 damaged blocks (each concealed 10 ms segment straddles about 2 analysis blocks). |
| C6 | C++ loopback, **bundled** exe | `loopback.sh bin/windows/duplexrec.exe runs/cpp_bundled "--sim-loss 10" ""` | Both exit 0. Dropped 127, concealed 126 (the last drop before A quit is correctly not counted). **Local WAVs: 0 damaged blocks**. B monitor: 104/604. |
| M1 | C++ build with **MSVC** | — | **NOT RUN.** No MSVC toolset is installed (see `docs/environment/TOOLCHAIN_AUDIT.md`). |
| W1 | Browser prototypes | — | **NOT RUN.** Historical and out of scope. |
| H1 | Any test with **real microphones**, or on **two PCs** | — | **NOT RUN.** Only one PC was available, and loopback used `--null-audio` test tones. |

**What these results prove:** both prototypes, on this Windows PC, run the
dual-path design end to end. Shared start/stop, a separate local master, the
live UDP stream, loss accounting that matches the injected loss, and local
files with no damage when the monitor stream loses about 10 %.

**What they do not prove:** real-device capture quality, behaviour on a real LAN
or Wi-Fi, firewall behaviour, device unplugging, long takes, disk-full
handling, or how well the two takes line up in time.

## 4. C++ prototype vs Rust reference

| Capability | C++ `duplexrec-pp1` | Rust `duplexrec-rs` |
|---|---|---|
| Local float32 WAV master per peer | Yes | Yes |
| Live UDP monitor, PCM16, 26-byte header, CRC-32 | Yes | Yes (same format) |
| Jitter buffer: reorder, late, PLC (repeat at halving gain), "peer stopped ≠ loss" | Yes (inline, untested) | Yes (6 unit tests) |
| RFC 3550 interarrival jitter | Yes | Yes |
| Producer-only control (roles) | **No.** Either peer can start a take. | **Yes** (`--role main/remote`) |
| Start/stop delivery | UDP × 3, no ACK, starts on arrival | Same |
| Scheduled future start | No | No |
| Offset clock | `steady_clock` (monotonic) | Wall clock (`SystemTime`) |
| Post-take transfer to producer | **No** | Yes. TCP, byte-identical in R3, but no hash, no resume. |
| Received-file name allowlist (path traversal) | n/a | Yes (1 unit test) |
| UDP source-address filtering | **No.** `from` is ignored. | **No.** The source is ignored. |
| Device-loss handling | Not handled | Not checked |
| Crash-safe WAV (`.partial`, header patch) | No (`ma_encoder` finalises on uninit only) | Not checked |
| Rings | `ma_pcm_rb`, **1 s** each | `rtrb` |
| Device rate | Asks miniaudio for 48 kHz. miniaudio may convert (not verified). | Requires the device at 48 kHz |
| Unit tests | **0** | 14 |
| UI | Terminal | Terminal + double-click prompts |

### 4.1 Ideas worth reusing in the C++17 product

These are only **design inputs**. Each has to be re-implemented and re-tested in
the new code, so none of them counts as validated in C++ until its own tests pass.

1. The 26-byte media header and CRC-32 (both prototypes agree; Rust has the unit tests, including the CRC check value `0xCBF43926`).
2. Jitter-buffer semantics: count loss only once later packets arrive, detect late arrivals, PLC fade-out, reset when a new peer session starts. The Rust tests show which cases to cover.
3. The callback splits input into separate rings (kept vs heard) and never touches disk or sockets (both).
4. Winsock `SIO_UDP_CONNRESET` handling (C++). Without it, ICMP port-unreachable errors break `recvfrom` on Windows.
5. Role semantics: producer-only control, the performer ignores local record commands, the producer ignores incoming start/stop (Rust).
6. The received-file name allowlist and "never accept a file carrying our own name" (Rust `transfer.rs`).
7. Measurement outputs: per-take JSON, per-second CSV, concealment-position CSV, and `plot_take.py`.
8. "Don't quit while a take is still being sent" (Rust `main.rs`, `sends_pending`).

### 4.2 Defects and gaps found by reading the code

These are recorded so that they are **not** carried into the product unexamined.

| # | Where | Issue | Effect |
|---|---|---|---|
| G1 | both | No check of the UDP source address | Any host on the LAN can inject audio or START/STOP. Acceptable only on a trusted private LAN. |
| G2 | both | START/STOP over UDP × 3 with no ACK, starting on arrival | No proof the peer started. No scheduled start. Start offset = network delay + writer poll (≤ 5 ms in C++). |
| G3 | C++ | No roles | Two people pressing `r` can create conflicting takes |
| G4 | C++ | `crc32()` builds its table lazily without synchronisation, and the sender and receiver threads call it concurrently | Data race (undefined behaviour) on the first packets. In practice the table values are identical, but it is still a defect. |
| G5 | C++ | Local ring is only 1 s and the overrun counter covers the whole session | A disk stall over about 1 s loses master audio. The take JSON reports the session total, not the per-take count. |
| G6 | C++ | WAV header written only at `ma_encoder_uninit` | A crash or power loss leaves a file with a wrong header and no "incomplete" marker |
| G7 | C++ | No device-stop or unplug notification | A device failure would not be reported |
| G8 | Rust | Transfer has no checksum, no chunking, no resume | A failed transfer resends the whole file. Integrity relies on TCP alone (byte-identical in the R3 loopback). |
| G9 | Rust | Offset uses wall clock | NTP steps corrupt the estimate. Fine for display, wrong for alignment research. |
| G10 | both | No scheduled start, drift or alignment measurement | Expected. Planned for later (Stage 3/7). |
| G11 | C++ | Dynamic MinGW build fails because of PATH DLL conflicts | Distribute static or MSVC builds only |

## 5. Scope and acceptance target

The extracted scope and the historical wording are in the preservation index, §6.
**PP1 acceptance target:** *"remote recording (to local storage) by 2 people and
audio communication between the two"*, on **two real Windows PCs**.

## 6. Smallest reliable path to a two-PC PP1 demonstration

Both prototypes already do what the panel asked for, on loopback. The biggest
remaining risk is **real hardware and a real network**, not missing code. So the
smallest reliable path is testing first and code second:

1. **Two-PC rehearsal with existing binaries (no code, about 1 hour, do it first).**
   Use the Rust `duplexrec-portable` folder (roles + transfer, 14 tests), *and*
   the bundled C++ exe, on the exact network you will use on the day (travel
   router or Ethernet, both Windows profiles set to Private, firewall allowed,
   headphones, both devices at 48 kHz). Record: does `rtt` appear, can each
   person hear the other, does `r` on A start B, do both `*_local.wav` files play
   back clean, and does B's take arrive on A (Rust). Keep the files and a
   screenshot as **dated evidence**. This also settles the unknown provenance
   of the 9 Oct takes.
2. **Freeze a C++ PP1 baseline in this repo (the smallest C++ step).** Import the
   zip's sources unchanged under `prototypes/cpp-pp1/` with their hash, and
   commit. Build it with MSVC once installed, or MinGW `-static` today.
3. **Only if PP1 should show C++: two small, testable changes** to that baseline.
   (a) `--role producer|performer` so only the producer starts and stops (G3).
   (b) Accept packets only from the configured peer address (G1). Add unit tests
   for the header/CRC and the jitter buffer, using the Rust tests as the case
   list, and fix G4. Then repeat the step 1 rehearsal.
4. **Present honestly:** "C++17 engine prototype (terminal) proving the dual-path
   design on two PCs. Producer Studio / Performer Client GUI apps are in
   progress (increments I-1+)." Keep the Rust build as the fallback on both laptops.

The two-executable Qt product (increments I-1…I-4 of `docs/STAGE_PLAN.md`) is the right
long-term target. It is **not** the smallest path to a reliable two-PC demo in
about 9 days, because it still needs a compiler install, Qt, and new code that
has never run on two PCs. Steps 2–3 above need the researcher's approval, because
they add a `prototypes/` folder to this repo.
