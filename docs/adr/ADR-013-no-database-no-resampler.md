# ADR-013: No SQLite and no libsamplerate for PP1

- **Status:** Proposed · **Traces:** BRIEF ("only when justified"), DEPENDENCIES.md

## Decision
- **SQLite: not adopted.**
  - Session state lives in memory while a session runs.
  - Anything kept afterwards (take metadata, telemetry, logs) goes to JSON and CSV files, which the analysis scripts read directly (proposal §4.6).
  - No query, concurrency or schema-migration need has been shown. Revisit if takes have to be managed across many sessions.
- **libsamplerate: not adopted.**
  - Capture runs at the native 48 kHz with no conversion (ADR-003), and Opus runs at 48 kHz. **No conversion need has been shown.**
  - If 44.1 kHz devices must be supported (OQ-11), only the *live* path would be converted, using miniaudio's built-in resampler. The master stays native.
  - libsamplerate (BSD-2-Clause) is reconsidered only for drift-corrected *derived* exports (LATER-04), once its quality has been assessed.
