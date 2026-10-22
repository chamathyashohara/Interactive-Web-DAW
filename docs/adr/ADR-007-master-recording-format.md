# ADR-007: Master recording in WAV float32 at native rate, with an in-house safe writer

- **Status:** Proposed · **Traces:** REC-01…05, REC-09, ERR-02/05/08, VER-01, D-09

## Decision
- **Format:** RIFF/WAVE, `WAVE_FORMAT_IEEE_FLOAT` (tag 3), 32-bit, with a `fact` chunk. Device-native rate, which must be 48 000 Hz. Channel count: see the amendment below.
- **Never on the master path:** resampling, dither, gain, limiting or concealment. The samples written are exactly the ones the capture callback delivered.
- **Writer:** in-house, about 200 lines, unit-tested, in place of miniaudio's `ma_encoder`, because we need control over:
  1. writing to `takeNN_<role>_<session8>.wav.partial`;
  2. **refreshing the header sizes every 5 s (prov.)**, so a crash leaves a file that can be recovered up to the last refresh;
  3. on stop: final header patch, `FlushFileBuffers`, then `MoveFileExW(partial, final, MOVEFILE_WRITE_THROUGH)` **without** `MOVEFILE_REPLACE_EXISTING`, so nothing is ever overwritten;
  4. distinct status codes for disk-full, write error, device loss and crash (PROTOCOL_OVERVIEW §6).
- **Metadata:** `takeNN_<role>_<session8>.json`, written to a temp file and renamed.
- **Size limit:** WAV's 32-bit sizes cap a file at 4 GiB, which is about 6.2 h of mono float32 at 48 kHz. Arming refuses a planned length that would exceed it. RF64 is LATER.

## Proposed requirement amendment (needs approval: affects REC-02, OQ-12)
REC-02 says "mono". Many laptop microphone arrays have 2 channels, and asking
miniaudio for 1 channel makes it **downmix**, which changes the original
signal. Proposal:
- **record the device's native channel count (1 or 2)** in the master;
- downmix only for the *live* stream;
- store the channel count in the metadata.
