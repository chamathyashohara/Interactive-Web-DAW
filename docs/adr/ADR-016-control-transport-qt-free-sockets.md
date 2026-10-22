# ADR-016: Control transport on Qt-free sockets in the core (supersedes the TCP-control row of ADR-005)

- **Status:** Implemented in Stage 6 (11 Oct 2026). Awaiting the researcher's review. **Supersedes** only the "Control … `QTcpServer` / `QTcpSocket` in `rr_app`" row of ADR-005. The UDP media, probe and take-transfer rows of ADR-005 are unchanged.
- **Traces:** SES-01…SES-12, ERR-03, APP-02, SEC-01…03, ADR-009, ADR-010, ADR-012, D-38

## Context
ADR-005 put TCP control on Qt Network in a control thread inside `rr_app`. Qt is not installed on the development PC (Stage 3 decision "Write + partial verify"), so control code inside `rr_app` could not be compiled, run or tested there. The Stage 6 brief asks for verified behaviour: duplicate, late and malformed messages, timeouts, reconnects, version mismatch and two-instance runs.

## Decision
- The control link (`rr::net::ControlLink`, `libs/network`) uses a thin socket wrapper (`rr::net::TcpSocket`). This is Winsock2 on Windows, with BSD sockets kept compilable for the GCC check. Sockets are non-blocking and multiplexed with `select()` on **one link thread per app**.
- The session logic (`rr::control::SessionController`, `libs/control`) is Qt-free and single-threaded. The UI thread calls `poll()` every 50 ms. The Qt layer (`SessionPanel`) only renders snapshots and forwards button presses.
- The producer listens on **one explicitly selected IPv4 interface** (never `0.0.0.0`), with `SO_EXCLUSIVEADDRUSE` on Windows. The UI lists the interfaces and marks loopback, private and non-private addresses.
- The framing is ADR-009's length-prefixed TLV, as implemented in PROTOCOL_OVERVIEW §11.
- **TLS is not implemented** (ADR-012). The build is labelled **LAN-only, unencrypted** in the UI, the README and this ADR.

## Why
- **Verifiability:** the whole control path (codec, link, controller, recorder scheduling) builds and runs with the GCC core-check preset. It has unit tests plus two-process runs on one PC (`rr_session_probe`). Inside `rr_app` it could only have been checked lexically.
- **Fits ADR-001:** the Qt-free core owns the protocol. The UI cannot bypass the state machine.
- **One threading model:** the link thread never touches audio or the UI. The controller never blocks. The audio callback is untouched (recording scheduling lives in the recorder thread).

## Consequences and costs
- Qt Network's ready-made features (async connect, `QSslSocket`) are given up. Async connect and timeouts are hand-written and tested with loopback tests.
- **Future TLS** can no longer be "swap `QTcpSocket` for `QSslSocket`". The options for a later security stage, all established libraries and never custom cryptography, are:
  1. Windows **Schannel** (SSPI) wrapped around `TcpSocket`. Native, nothing to deploy, but the API is verbose.
  2. **OpenSSL** or **mbedTLS** over `TcpSocket`. Portable, one more dependency to deploy and licence.
  3. Run the control connection in `rr_app` on `QSslSocket` and feed the frames to the Qt-free controller. This brings back the Qt Network dependency for that path.

  The choice is left to the security stage (ADR-012). Authentication could be a certificate fingerprint compared on both screens.
- **Responsiveness:** select timeout 20 ms + UI poll 50 ms. A control round trip through both apps' poll loops takes about 60–80 ms on loopback, observed in the two-process runs. This is well inside the 1000 ms start lead. The **network** RTT measured by heartbeats is separate (about 0.1–0.3 ms on loopback).

## Not changed
- UDP media and clock probes (ADR-005, ADR-010) are still to be built in the live-audio stage. In Stage 6 the clock offset comes from **TCP heartbeat timestamps** (four-timestamp method, min-δ of 16, u = δmin/2). The UDP probes may replace it later. Any TCP-specific error (for example Nagle delay or retransmission) only widens δ, and therefore u.
