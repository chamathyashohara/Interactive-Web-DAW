# ADR-009: Control protocol is length-prefixed binary frames with TLV fields, over TCP

- **Status:** Proposed · **Traces:** SES-01…10, APP-02, STA-03, ERR-03

## Decision
- **Frame:** `u32 length | u16 type | u16 reserved | u32 msg_id | u32 ref_id | TLV…`, big-endian, at most 64 KiB (PROTOCOL_OVERVIEW §4).
- **Fields** are TLV (`u16 tag, u16 len, value`). **Unknown tags are ignored**, so a minor version can add fields. A missing required tag returns `E_PROTOCOL_MALFORMED`.
- **Versioning:** the major versions must be equal. Minor versions may differ, and features are limited to what both sides support.
- Every state-changing command gets an explicit ACK or NACK with an error code, and the sender has a timeout.
- The encoder/decoder is plain C++ in `rr_core`, with fuzz-style unit tests. The transport is Qt Network (ADR-005).

## Alternatives
- **JSON lines:** readable, but needs a parser dependency and makes length limits harder to enforce.
- **Protobuf:** adds a code generator and a dependency for about 20 messages.
