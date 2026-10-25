import { PPQ, TICKS_PER_BAR, createTrack, type Clip, type Note, type OpBody, type Project, type Track } from "@daw/shared";

/**
 * Tools the Make a Song lessons give the learner in their workspace, for the steps the Web DAW has no button for yet
 * (see docs/lessons/SONG-WORKFLOW-GAPS.md): octave shift, the chopper, the arpeggiator, copying a clip to another track
 * and giving each drum its own track. Each returns ops for one undo step.
 */

type Id = () => string;
const notesOf = (c: Clip) => Object.values(c.notes).sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
const replaceNotes = (trackId: string, clip: Clip, next: Omit<Note, "id">[], id: Id): OpBody[] => [
  ...Object.keys(clip.notes).map((noteId): OpBody => ({ type: "deleteNote", trackId, clipId: clip.id, noteId })),
  ...next.map((n): OpBody => ({ type: "addNote", trackId, clipId: clip.id, note: { id: id(), ...n } })),
];

/** Every note of the clip up or down by `semitones` (12 = one octave). Null when a note would leave the keyboard. */
export function shiftOps(trackId: string, clip: Clip, semitones: number): OpBody[] | null {
  const notes = Object.values(clip.notes);
  if (notes.some((n) => n.pitch + semitones < 0 || n.pitch + semitones > 127)) return null;
  return notes.map((n) => ({ type: "updateNote", trackId, clipId: clip.id, noteId: n.id, changes: { pitch: n.pitch + semitones } }));
}

/** The chopper: every note longer than `step` is cut into notes `step` long (the last piece keeps what is left). */
export function chopOps(trackId: string, clip: Clip, step: number, id: Id): OpBody[] {
  const next: Omit<Note, "id">[] = [];
  for (const n of notesOf(clip)) {
    if (n.durationTicks <= step) {
      next.push({ pitch: n.pitch, startTick: n.startTick, durationTicks: n.durationTicks, velocity: n.velocity });
      continue;
    }
    for (let t = 0; t < n.durationTicks; t += step) next.push({ pitch: n.pitch, startTick: n.startTick + t, durationTicks: Math.min(step, n.durationTicks - t), velocity: n.velocity });
  }
  return replaceNotes(trackId, clip, next, id);
}

export type ArpPattern = "up" | "down" | "updown";
/**
 * The arpeggiator: every chord (notes starting together) is played one note after another, `step` apart, for as long as
 * the chord lasted, going up, down or up and down through its notes.
 */
export function arpOps(trackId: string, clip: Clip, pattern: ArpPattern, step: number, id: Id): OpBody[] {
  const chords = new Map<number, Note[]>();
  for (const n of notesOf(clip)) chords.set(n.startTick, [...(chords.get(n.startTick) ?? []), n]);
  const next: Omit<Note, "id">[] = [];
  for (const [start, chord] of chords) {
    const up = [...chord].sort((a, b) => a.pitch - b.pitch).map((n) => n.pitch);
    const order = pattern === "up" ? up : pattern === "down" ? [...up].reverse() : [...up, ...up.slice(1, -1).reverse()];
    const length = Math.max(...chord.map((n) => n.durationTicks));
    const velocity = chord[0]!.velocity;
    for (let t = 0, i = 0; t < length; t += step, i++) next.push({ pitch: order[i % order.length]!, startTick: start + t, durationTicks: Math.min(step, length - t), velocity });
  }
  return replaceNotes(trackId, clip, next, id);
}

/** A copy of the clip (same place, same notes) on another track. Null when that track already has a clip there. */
export function copyClipToTrackOps(project: Project, clip: Clip, targetId: string, id: Id): OpBody[] | null {
  const target = project.tracks[targetId];
  if (!target) return null;
  const overlap = Object.values(target.clips).some((c) => c.startTick < clip.startTick + clip.lengthTicks && clip.startTick < c.startTick + c.lengthTicks);
  if (overlap) return null;
  const notes: Record<string, Note> = {};
  for (const n of Object.values(clip.notes)) {
    const nid = id();
    notes[nid] = { ...n, id: nid };
  }
  return [{ type: "addClip", trackId: targetId, clip: { id: id(), name: clip.name, startTick: clip.startTick, lengthTicks: clip.lengthTicks, notes } }];
}

const DRUM_NAMES: Record<number, string> = { 35: "Kick", 36: "Kick", 38: "Snare", 39: "Clap", 40: "Snare", 42: "Hats", 44: "Hats", 46: "Hats" };
const drumName = (pitch: number) => DRUM_NAMES[pitch] ?? `Drum ${pitch}`;

/** One drum track per drum sound (kick, hats, clap...), so each can be mixed on its own channel. */
export function separateDrumsOps(project: Project, trackId: string, newTrackId: Id, id: Id): OpBody[] | null {
  const t = project.tracks[trackId];
  if (!t || t.instrument !== "drums") return null;
  const groups = new Map<string, Note[]>();
  for (const c of Object.values(t.clips)) for (const n of Object.values(c.notes)) groups.set(drumName(n.pitch), [...(groups.get(drumName(n.pitch)) ?? []), { ...n, startTick: n.startTick + c.startTick }]);
  if (groups.size < 2) return null;
  const ops: OpBody[] = [{ type: "deleteTrack", trackId }];
  const colors = ["#f472b6", "#a3e635", "#facc15", "#fb923c", "#22d3ee"];
  let i = 0;
  for (const [name, notes] of groups) {
    const tid = newTrackId();
    const clips: Track["clips"] = {};
    for (const c of Object.values(t.clips)) {
      const inClip = notes.filter((n) => n.startTick >= c.startTick && n.startTick < c.startTick + c.lengthTicks);
      if (!inClip.length) continue;
      const cid = id();
      clips[cid] = { id: cid, name: c.name, startTick: c.startTick, lengthTicks: c.lengthTicks, notes: Object.fromEntries(inClip.map((n) => { const nid = id(); return [nid, { ...n, id: nid, startTick: n.startTick - c.startTick }]; })) };
    }
    const track = { ...createTrack(tid, name, "drums", colors[i++ % colors.length]!, "unused"), volume: t.volume, pan: t.pan, clips };
    ops.push({ type: "addTrack", track, index: project.trackOrder.indexOf(trackId) + i - 1 });
  }
  return ops;
}

/** A new empty synth or drum track for the lesson workspace, with one 4-bar clip at `bar`. */
export function newTrackOps(kind: "synth" | "drums", name: string, color: string, trackId: string, clipId: string, bar = 1): OpBody[] {
  const t = createTrack(trackId, name, kind, color, clipId);
  t.clips[clipId] = { ...t.clips[clipId]!, startTick: (bar - 1) * TICKS_PER_BAR, lengthTicks: 4 * TICKS_PER_BAR };
  return [{ type: "addTrack", track: t }];
}

/** Grid steps the chopper and arpeggiator offer. */
export const STEP_CHOICES = [
  { label: "1/4", ticks: PPQ },
  { label: "1/8", ticks: PPQ / 2 },
  { label: "1/16", ticks: PPQ / 4 },
] as const;
