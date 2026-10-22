# Component Diagrams

**Stage 2 · 11 October 2026.** These are Mermaid diagrams made for engineering
review. They are *not* the hand-drawn report figures; the proposal template's
rule on AI-made figures applies to Figures 1–5 of the report.

## 1. Build targets and dependencies (ADR-001)

```mermaid
flowchart TB
    subgraph EXE[Executables]
        PS[ProducerStudio.exe]
        PC[PerformerClient.exe]
        RV[rr_verify.exe<br/>CLI, VER-01]
    end
    subgraph APP["rr_app (static, Qt 6 Core/Gui/Widgets/Network)"]
        SC[SessionController<br/>owns SessionModel]
        CT[ControlTransport<br/>QTcpServer / QTcpSocket]
        XT[TransferTransport<br/>COULD]
        W[Shared widgets<br/>device picker, meters,<br/>status, telemetry, consent]
    end
    subgraph CORE["rr_core (static, plain C++17, no Qt)"]
        SM[session: state machines<br/>pure transition tables]
        PR[proto: media header v1,<br/>control TLV codec]
        EN[engine: Engine facade]
        AU[audio: devices, callbacks,<br/>meters, watchdog]
        RC[record: recorder thread,<br/>safe WAV writer, metadata]
        LV[live: send/recv threads,<br/>codec iface, jitter buffer]
        TM[timing: probes, offset θ̂,<br/>T→sample mapping]
        TL[telemetry: counters, CSV]
        VF[verify: WAV check,<br/>SHA-256 via CNG]
        RT[rt: SPSC rings]
    end
    subgraph EXT[Third-party]
        MA[miniaudio 0.11.25<br/>vendored]
        OP[libopus 1.6.1<br/>static, I-5]
        QT[Qt 6.11.3<br/>dynamic LGPL]
        WS[Winsock2 / CNG / Win32<br/>OS]
        C2[Catch2 v3.16.0<br/>tests only]
    end
    PS --> APP
    PC --> APP
    RV --> VF
    APP --> CORE
    SC --> SM
    SC --> EN
    CT --> PR
    EN --> AU & RC & LV & TM & TL
    AU --> RT
    RC --> RT
    LV --> RT
    AU --> MA
    LV --> OP
    LV --> WS
    VF --> WS
    APP --> QT
```

## 2. The two audio paths on one PC (master path independent of the live path)

```mermaid
flowchart LR
    MIC((Mic)) --> CB1[Capture callback T1]
    CB1 -- "REC ring (10 s)" --> REC[Recorder T3]
    REC --> WAV[(takeNN_role.wav<br/>MASTER, float32, native)]
    CB1 -- "SEND ring (200 ms)" --> SND[Media send T4<br/>downmix, encode]
    SND -- "UDP" --> NET{{LAN}}
    NET -- "UDP" --> RCV[Media receive T5<br/>validate]
    RCV -- "packet queue (64)" --> CB2[Playback callback T2<br/>jitter buffer, decode, PLC]
    CB2 --> HP((Headphones))
    CB2 -- "MON ring" --> REC
    REC --> MON[(takeNN_role.monitor.wav<br/>what was heard)]
    classDef master fill:#fff,stroke:#000,stroke-width:3px
    class WAV,REC,CB1 master
```

No arrow leads from the network side (T4, T5, T2) into `WAV`. The only data
going *into* the recorder from the live side is the separately named monitor
file (REC-11). Concealment exists only in T2.

## 3. Separation of concerns (the eight areas the stage brief requires)

| # | Concern | Component(s) | Thread(s) | Qt? |
|---|---|---|---|---|
| 1 | UI / presentation | `rr_app` widgets, role windows | T8 | Yes |
| 2 | Session and state coordination | `SessionController` + `rr_core/session` tables | T7 | Controller yes, tables no |
| 3 | Audio capture and playback | `rr_core/audio` | T1, T2, T6 (watchdog) | No |
| 4 | Local recording and file finalisation | `rr_core/record` | T3 | No |
| 5 | Live encode/send, receive/decode/playback | `rr_core/live` | T4, T5, T2 | No |
| 6 | Control messages and acknowledgements | `rr_core/proto` (codec) + `ControlTransport` | T7 | Transport yes |
| 7 | Timing measurement and telemetry | `rr_core/timing`, `rr_core/telemetry` | T4/T5 (probes), T3 (mapping), T6 (CSV) | No |
| 8 | Post-session take transfer and integrity check | `TransferTransport` + `rr_core/verify` | T9, `rr_verify` | Transport yes |

## 4. Deployment on the two PCs

```mermaid
flowchart LR
    subgraph PCP[PC-P · Windows 10/11 x64]
        PSX[ProducerStudio.exe] --- QTD1[Qt DLLs + platforms/qwindows.dll]
        PSX --- REC1[(Recordings\session\takeNN_producer_*.wav)]
    end
    subgraph PCR[PC-R · Windows 10/11 x64]
        PCX[PerformerClient.exe] --- QTD2[Qt DLLs + platforms/qwindows.dll]
        PCX --- REC2[(Recordings\session\takeNN_performer_*.wav)]
    end
    PCR -->|TCP 52000 control| PCP
    PCP <-->|UDP 52001 media + probes| PCR
    PCR -.->|TCP 52002 transfer, COULD| PCP
```

Each deployment folder contains:
- the exe and `windeployqt` output;
- `rr_verify.exe`;
- `LICENSES/` and `NOTICE.txt` (ADR-004).

The `vc_redist.x64.exe` installer runs once on each PC (ADR-002). The
recordings folder defaults to `%USERPROFILE%\Music\RemoteRecording\` (prov.).
