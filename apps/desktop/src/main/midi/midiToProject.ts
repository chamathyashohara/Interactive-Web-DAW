import { randomUUID } from "node:crypto";
import { createProject, createTrack, MAX_BPM, MAX_SONG_BARS, MAX_TRACKS, MIN_BPM, TICKS_PER_BAR, TRACK_COLORS, type Note, type Project } from "@daw/shared";
import type { ParsedMidi } from "./parseMidi";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Builds a Project from a parsed MIDI file: one track per MIDI track that has notes (all-drum-channel tracks become drum
 * tracks), the first tempo, and a song long enough to hold every note. Capped at the DAW's track and song-length limits.
 */
export function midiToProject(parsed: ParsedMidi, id: string, name: string): Project {
  const used = parsed.tracks.filter((t) => t.notes.length > 0).slice(0, MAX_TRACKS);
  if (used.length === 0) throw new Error("the MIDI file has no notes");

  const maxEnd = Math.max(...used.flatMap((t) => t.notes.map((n) => n.startTick + n.durationTicks)));
  const songBars = clamp(Math.ceil(maxEnd / TICKS_PER_BAR), 1, MAX_SONG_BARS);
  const songLen = songBars * TICKS_PER_BAR;

  const base = createProject(id, name);
  const tracks: Project["tracks"] = {};
  const trackOrder: string[] = [];
  let synthN = 0;

  used.forEach((mt, i) => {
    const isDrum = mt.notes.every((n) => n.channel === 9);
    const trackId = `track-${randomUUID()}`;
    const clipId = `clip-${randomUUID()}`;
    const label = mt.name || (isDrum ? "Drums" : `Synth ${++synthN}`);
    const track = createTrack(trackId, label, isDrum ? "drums" : "synth", TRACK_COLORS[i % TRACK_COLORS.length]!, clipId);
    const clip = track.clips[clipId]!;
    clip.name = label;
    clip.startTick = 0;
    clip.lengthTicks = songLen;
    clip.notes = {};
    for (const n of mt.notes) {
      if (n.startTick >= songLen) continue;
      const duration = Math.min(n.durationTicks, songLen - n.startTick);
      if (duration < 1) continue;
      const note: Note = { id: randomUUID(), pitch: clamp(n.pitch, 0, 127), startTick: n.startTick, durationTicks: duration, velocity: clamp(n.velocity, 1, 127) };
      clip.notes[note.id] = note;
    }
    tracks[trackId] = track;
    trackOrder.push(trackId);
  });

  return { ...base, tempo: parsed.tempoBpm ? clamp(parsed.tempoBpm, MIN_BPM, MAX_BPM) : base.tempo, songBars, tracks, trackOrder };
}
