# ADR-014: Take transfer and verification uses its own TCP connection, SHA-256 via Windows CNG, and never touches the original

- **Status:** Proposed. **XFER is a COULD.** · **Traces:** XFER-01…05, VER-01, ERR-08, BRIEF
- **Stage 11 (11 Oct 2026):** implemented as ADR-020, which keeps every point below except step 5: an interrupted transfer now **resumes from the last verified chunk** (XFER-04). The port is control port + 2 (52002 by default).

## Decision
- **Hashing:** SHA-256 through Windows CNG (`BCryptOpenAlgorithmProvider` with `BCRYPT_SHA256_ALGORITHM`). It is part of Windows, so there is no extra dependency and no custom crypto. Used by `rr_verify.exe` (VER-01) and by the transfer.
- **Transfer (only if built):**
  1. It uses its own TCP connection (port 52002, prov.), so a large file never delays control messages.
  2. The performer sends a header (take ID, size, SHA-256), then streams the file opened **read-only**.
  3. The producer writes to `<name>.partial`, recomputes the hash, and renames only if it matches.
  4. It reports `VERIFIED` or `E_TRANSFER_HASH_MISMATCH`.
  5. A retry restarts the whole file. Chunk-level resume is LATER (XFER-04).
- **The performer's original is never moved, renamed, modified or deleted** by any part of the system.
