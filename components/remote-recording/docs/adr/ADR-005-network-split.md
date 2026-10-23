# ADR-005: Network split: UDP media and clock probes on Winsock threads, TCP control on Qt Network

- **Status:** Proposed. **Revises D-07.** · **Traces:** COM-*, SES-*, TEL-01/03
- **Stage 6 note:** the **Control** row below is superseded by [ADR-016](ADR-016-control-transport-qt-free-sockets.md) (Qt-free sockets in the core). The other rows stand.

## Decision
| Traffic | Transport | Implementation | Thread |
|---|---|---|---|
| Live audio | UDP | Winsock2 in `rr_core` | media-send, media-receive |
| Clock probes (offset / probe RTT) | UDP, same socket | Winsock2 in `rr_core`. Timestamps taken right after `recvfrom` and right before `sendto`. | media-receive (replies), media-send (requests) |
| Control (pairing, readiness, ARM/STOP, reports, heartbeat) | TCP | `QTcpServer` / `QTcpSocket` in `rr_app` | A dedicated **control thread** with its own Qt event loop, not the UI thread |
| Take transfer (COULD) | TCP, separate connection | Qt Network in `rr_app`, hashing in `rr_core` | transfer worker thread |

## Why it changed from D-07 ("plain Winsock for everything")
- TCP control needs asynchronous connect, accept, framing and timeouts. Qt Network provides these, and Qt is already a dependency.
- The future TLS path (`QSslSocket`) then needs no new transport code (ADR-012).
- UDP stays on blocking Winsock threads, so probe timestamps are not delayed behind an event loop.

## Risks
- The Windows TLS backends are Schannel (native, per Qt docs) and OpenSSL (must be deployed). The Qt pages checked do **not** state which features, such as PSK or DTLS, each backend supports. Query them with `QSslSocket::isFeatureSupported` when designing security.
- Reuse the C++ prototype's Winsock `SIO_UDP_CONNRESET` workaround. Without it, ICMP port-unreachable errors break `recvfrom`. Re-test it in I-4.
- **Readiness change (proposed):** the media path is considered "OK" only once UDP probes have been answered both ways. See the proposed SES-04 amendment in SYSTEM_ARCHITECTURE §10.
