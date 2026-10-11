# libs/network: module boundary (no code yet)

This folder is deliberately empty at Stage 3 and has **no CMake target**.

**Will contain (increments I-3/I-4, ADR-005, ADR-008, ADR-009):**
- the media header v1 codec and the control TLV codec (Qt-free, unit-tested);
- Winsock UDP media and probe threads;
- the jitter buffer (ADR-011).

The TCP control transport itself is Qt Network code and will live in `libs/ui_common`
(or a dedicated Qt-side library), not here.

**Rules:** Qt-free (ADR-001). No custom cryptography (ADR-012).
