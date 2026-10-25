# ADR-005: The singer plays a delivered, verified backing track locally (not a live stream)

**Status:** accepted. **Date:** 24 October 2026.

## Context

A producer wants a singer in another place to sing over the song, with the vocal landing exactly on the music. Two designs were possible:

1. **Stream the producer's output live** to the singer (the talkback path, Opus over UDP).
2. **Render the arrangement, deliver it once, verified, and let the singer's PC play it** from disk on the same audio clock as its microphone.

## Decision

Option 2. The backing track is rendered with the DAW's offline export (tracks named "Vocal take N" excluded), identified by its SHA-256, served over HTTP
on the control port + 3 to the joined singer only (one-time token, resumable), verified, decoded, and scheduled on the audio-context frame the take starts recording on.

## Why

- A live stream adds network latency and jitter to the music; a vocal sung to a delayed, glitchy stream cannot be placed exactly, and a dropout ruins a take.
- With a local file the only timing question is the sound card's own delay, which is a single number measured on the singer's PC and removed at placement.
- Start of music and start of recording are the same audio frame by construction (verified: lag 0 samples), whatever the network does.
- The export path already exists, is sample-accurate, and is what the producer will hear and mix.

## Consequences

- The singer must have the current backing track before Record (a few MB per minute; seconds on a LAN). Changing the arrangement triggers a re-render and re-send;
  Record waits (and says so) until the singer has the new one.
- The singer hears what the producer rendered, not live edits during a take (nor the producer's live tweaks while playing).
- The first Play after an edit is delayed by the render. A live low-latency stream could be added later for monitoring only; it would not replace this.
- The protocol gains optional messages (1.3). Peers on 1.2 (the C++ recorder) are never sent them and still work as before.
