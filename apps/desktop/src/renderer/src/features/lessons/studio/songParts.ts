import { MAX_SONG_BARS, MAX_TRACKS, PPQ, TICKS_PER_BAR, createTrack, type Clip, type Note, type OpBody, type Project, type Track } from "@daw/shared";
import type { SongSpec } from "./types";

/**
 * The Make a Song lessons build one song (docs/lessons/SONG-WORKFLOW-GAPS.md): Am - F - C - G, one chord per bar, so one
 * clip is 4 bars, at 124 BPM. Each lesson starts from "the song so far": the parts it needs, in the bars the plan puts
 * them. Tracks are lesson tracks ("lesson-song-<part>"), so they stay in the lesson's own workspace.
 */

export type Part = "piano" | "pads" | "kick" | "hats" | "clap" | "bass" | "arp" | "melody";
export const PARTS: Part[] = ["piano", "pads", "kick", "hats", "clap", "bass", "arp", "melody"];
export const SONG_TEMPO = 124;

/** Am, F, C, G in root position around middle C. */
export const PROGRESSION = [
  [57, 60, 64],
  [53, 57, 60],
  [60, 64, 67],
  [55, 59, 62],
];
/** Root pitch class of the chord in each bar (bar 1 = Am). */
export const rootPc = (bar: number) => [9, 5, 0, 7][(bar - 1) % 4]!;
export const chordPcs = (bar: number) => PROGRESSION[(bar - 1) % 4]!.map((p) => p % 12);
const BASS_ROOTS = [45, 41, 36, 43]; // A2 F2 C2 G2

export const KICK = 36;
export const HAT = 42;
export const CLAP = 39;

const NAMES: Record<Part, string> = { piano: "Piano", pads: "Pads", kick: "Kick", hats: "Hats", clap: "Clap", bass: "Bass", arp: "Arp", melody: "Melody" };
const COLORS: Record<Part, string> = { piano: "#22d3ee", pads: "#818cf8", kick: "#f97316", hats: "#a3e635", clap: "#fb7185", bass: "#a78bfa", arp: "#34d399", melody: "#facc15" };
export const songTrackId = (part: Part) => `lesson-song-${part}`;
export const barTick = (bar: number, beat = 1) => (bar - 1) * TICKS_PER_BAR + (beat - 1) * PPQ;

type N = Omit<Note, "id">;
/** [bar 1-4, beat (1-4.75), length in beats, pitch] */
type Phrase = [number, number, number, number][];
export const PHRASES: Record<"A" | "B" | "C", Phrase> = {
  A: [[1, 1, 1, 76], [1, 2, 1, 74], [1, 3, 2, 72], [2, 1, 1, 72], [2, 2, 1, 69], [2, 3, 2, 65], [3, 1, 2, 67], [3, 3, 2, 64], [4, 1, 2, 67], [4, 3, 2, 71]],
  B: [[1, 1, 2, 76], [1, 3, 1, 77], [1, 4, 1, 76], [2, 1, 2, 77], [2, 3, 2, 72], [3, 1, 1, 72], [3, 2, 1, 74], [3, 3, 2, 76], [4, 1, 4, 74]],
  C: [[1, 1, 1, 76], [1, 2, 1, 74], [1, 3, 2, 72], [2, 1, 2, 69], [2, 3, 2, 72], [3, 1, 2, 67], [3, 3, 2, 64], [4, 1, 4, 67]],
};
/** Phrase A with its last bar moved off the beat onto a note outside the G chord (Lesson 8.2 fixes it). */
const UNSETTLED: Phrase = [...PHRASES.A.slice(0, 8), [4, 1.5, 3.5, 69]];

/** The notes of one part for one 4-bar block (bar-relative ticks). */
function block(part: Part, spec: SongSpec["song"], letter: "A" | "B" | "C"): N[] {
  const bars = [0, 1, 2, 3];
  switch (part) {
    case "piano":
    case "pads":
      return bars.flatMap((b) => PROGRESSION[b]!.map((pitch) => ({ pitch, startTick: b * TICKS_PER_BAR, durationTicks: TICKS_PER_BAR - PPQ / 16, velocity: part === "piano" ? 90 : 70 })));
    case "kick":
      return bars.flatMap((b) => [0, 1, 2, 3].map((beat) => ({ pitch: KICK, startTick: b * TICKS_PER_BAR + beat * PPQ, durationTicks: PPQ / 4, velocity: 110 })));
    case "hats":
      return bars.flatMap((b) => [0, 1, 2, 3].map((beat) => ({ pitch: HAT, startTick: b * TICKS_PER_BAR + beat * PPQ + PPQ / 2, durationTicks: PPQ / 4, velocity: 80 })));
    case "clap":
      return bars.flatMap((b) => [1, 3].map((beat) => ({ pitch: CLAP, startTick: b * TICKS_PER_BAR + beat * PPQ, durationTicks: PPQ / 4, velocity: 100 })));
    case "bass": {
      const style = spec.bass ?? "chopped";
      if (style === "chords") return bars.flatMap((b) => PROGRESSION[b]!.map((pitch) => ({ pitch, startTick: b * TICKS_PER_BAR, durationTicks: TICKS_PER_BAR - PPQ / 16, velocity: 100 })));
      if (style === "long") return bars.map((b) => ({ pitch: BASS_ROOTS[b]!, startTick: b * TICKS_PER_BAR, durationTicks: TICKS_PER_BAR, velocity: 100 }));
      return bars.flatMap((b) => Array.from({ length: 8 }, (_, e) => ({ pitch: BASS_ROOTS[b]!, startTick: b * TICKS_PER_BAR + e * (PPQ / 2), durationTicks: PPQ / 2, velocity: 100 })));
    }
    case "arp":
      return bars.flatMap((b) => Array.from({ length: 16 }, (_, s) => ({ pitch: PROGRESSION[b]![s % 3]! + 12, startTick: b * TICKS_PER_BAR + s * (PPQ / 4), durationTicks: PPQ / 4, velocity: 85 })));
    case "melody": {
      const phrase = spec.melody === "unsettled" ? UNSETTLED : PHRASES[letter];
      return phrase.map(([bar, beat, len, pitch]) => ({ pitch, startTick: (bar - 1) * TICKS_PER_BAR + Math.round((beat - 1) * PPQ), durationTicks: Math.round(len * PPQ), velocity: 95 }));
    }
  }
}

function clipAt(part: Part, bar: number, notes: N[], id: string): Clip {
  return { id, name: NAMES[part], startTick: barTick(bar), lengthTicks: 4 * TICKS_PER_BAR, notes: Object.fromEntries(notes.map((n, i) => [`${id}-n${i}`, { id: `${id}-n${i}`, ...n }])) };
}

/** The tracks of "the song so far". With `sharedDrums`, kick, hats and clap are one "Drums" track (Lesson 10.1). */
export function songTracks(spec: SongSpec["song"]): Track[] {
  const tracks: Track[] = [];
  const drums: Clip[] = [];
  for (const part of PARTS) {
    const ranges = spec.parts[part];
    if (!ranges?.length) continue;
    const clips: Clip[] = [];
    let n = 0;
    for (const [from, to] of ranges) {
      for (let bar = from; bar <= to; bar += 4) {
        const letter = (spec.melodyPattern ?? "A")[n % (spec.melodyPattern ?? "A").length] as "A" | "B" | "C";
        clips.push(clipAt(part, bar, block(part, spec, letter), `${songTrackId(part)}-b${bar}`));
        n++;
      }
    }
    const isDrum = part === "kick" || part === "hats" || part === "clap";
    if (isDrum && spec.sharedDrums) {
      drums.push(...clips);
      continue;
    }
    const name = spec.genericNames && !isDrum ? `Synth ${tracks.filter((t) => t.instrument === "synth").length + 1}` : NAMES[part];
    const t = createTrack(songTrackId(part), name, isDrum ? "drums" : "synth", COLORS[part], "unused");
    tracks.push({ ...t, volume: spec.volume ?? t.volume, clips: Object.fromEntries(clips.map((c) => [c.id, c])) });
  }
  // Empty tracks to draw in (Special tasks): one empty 4-bar clip on bar 1.
  for (const part of spec.empty ?? []) {
    const isDrum = part === "kick" || part === "hats" || part === "clap";
    const t = createTrack(songTrackId(part), NAMES[part], isDrum ? "drums" : "synth", COLORS[part], `${songTrackId(part)}-b1`);
    tracks.push({ ...t, clips: { [`${songTrackId(part)}-b1`]: { id: `${songTrackId(part)}-b1`, name: NAMES[part], startTick: 0, lengthTicks: 4 * TICKS_PER_BAR, notes: {} } } });
  }
  // Reference parts play along so the learner hears the song, but are never applied to the Studio.
  for (const part of PARTS) {
    const ranges = spec.reference?.[part];
    if (!ranges?.length) continue;
    const isDrum = part === "kick" || part === "hats" || part === "clap";
    const id = `lesson-song-ref-${part}`;
    const clips: Clip[] = [];
    for (const [from, to] of ranges) for (let bar = from; bar <= to; bar += 4) clips.push(clipAt(part, bar, block(part, spec, "A"), `${id}-b${bar}`));
    const t = createTrack(id, `Reference: ${NAMES[part]}`, isDrum ? "drums" : "synth", "#64748b", "unused");
    tracks.push({ ...t, volume: 60, clips: Object.fromEntries(clips.map((c) => [c.id, c])) });
  }
  if (drums.length) {
    // One clip per block holding every drum (clips on one track never overlap).
    const merged = new Map<number, Clip>();
    for (const c of drums) {
      const m = merged.get(c.startTick);
      if (!m) merged.set(c.startTick, { ...c, id: `lesson-song-drums-${c.startTick}`, name: "Drums", notes: { ...c.notes } });
      else Object.assign(m.notes, c.notes);
    }
    const t = createTrack("lesson-song-drums", "Drums", "drums", "#f472b6", "unused");
    tracks.unshift({ ...t, volume: spec.volume ?? t.volume, clips: Object.fromEntries([...merged.values()].map((c) => [c.id, c])) });
  }
  return tracks;
}

/** Ops (one undo step) that replace the lesson's tracks with the song so far, at 124 BPM, `bars` long. */
export function songPartsOps(project: Project, spec: SongSpec["song"]): { ok: true; ops: OpBody[] } | { ok: false; reason: string } {
  const remove = project.trackOrder.filter((id) => id.startsWith("lesson-k-") || id.startsWith("lesson-song-"));
  const removable = remove.length >= project.trackOrder.length ? remove.slice(0, project.trackOrder.length - 1) : remove;
  const tracks = songTracks(spec);
  if (project.trackOrder.length - removable.length + tracks.length > MAX_TRACKS) return { ok: false, reason: `This lesson needs ${tracks.length} free tracks (a song can have at most ${MAX_TRACKS}). Delete some tracks in the Studio and try again.` };
  const ops: OpBody[] = removable.map((trackId) => ({ type: "deleteTrack", trackId }));
  const bars = Math.min(MAX_SONG_BARS, spec.bars);
  if (project.songBars < bars) ops.push({ type: "setSongLength", bars });
  if (project.tempo !== SONG_TEMPO) ops.push({ type: "setTempo", bpm: SONG_TEMPO });
  if (project.loop) ops.push({ type: "setLoop", loop: null });
  if (spec.masterVolume !== undefined && project.masterVolume !== spec.masterVolume) ops.push({ type: "setMasterVolume", volume: spec.masterVolume });
  for (const t of tracks) ops.push({ type: "addTrack", track: t });
  return { ok: true, ops };
}
