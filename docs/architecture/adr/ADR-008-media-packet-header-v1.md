# ADR-008: Media packet header v1 (26 bytes, versioned, CRC over header and payload)

- **Status:** Proposed · **Traces:** COM-02/03, SEC-02/03, proposal Table 2

## Decision
The header keeps the prototypes' 26-byte layout and proposal Table 2's fields
(sequence, capture timestamp, session, layer/stream, length, flags, reserved,
CRC), with two changes:

1. Byte 20 now carries a **version nibble (1)** and a **type nibble**.
2. The **CRC-32 covers bytes 0–21 and the payload**. The prototypes covered only the payload, so a corrupted sequence number or timestamp was accepted.

The full layout is in PROTOCOL_OVERVIEW §2.

**Not wire-compatible with the prototypes, on purpose.** Their type values
(0–3) read as version 0 and are rejected and counted as `unsupported_version`.

## Notes
- CRC-32 (IEEE 802.3) detects **corruption only**. It is not authentication (ADR-012).
- Sequence numbers are u32 per stream, compared with serial arithmetic `int32(a − b)`.
- The timestamp is the sender's **capture-device frame index** (u64). It is not a clock time.
