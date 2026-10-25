import type { Note, OpBody } from "@daw/shared";
import type { NewId, NoteClip } from "./editing";

export type ArpMode = "up" | "down" | "updown";

/**
 * Arpeggiator (Lesson 6.1): turns chords into an arpeggio. Notes that start on the same tick are treated as one chord
 * and spread into a sequence of `stepTicks`-long notes that cycle through the chord's pitches for the chord's own
 * length. A single note (not a chord) is left as it is. One undo step.
 */
export function arpOps(clip: NoteClip, notes: Note[], stepTicks: number, mode: ArpMode, newId: NewId): OpBody[] {
  if (stepTicks < 1) return [];
  const groups = new Map<number, Note[]>();
  for (const n of notes) (groups.get(n.startTick) ?? groups.set(n.startTick, []).get(n.startTick)!).push(n);

  const ops: OpBody[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue; // not a chord
    const start = group[0]!.startTick;
    const pitches = [...new Set(group.map((n) => n.pitch))].sort((a, b) => a - b);
    const seq = mode === "down" ? [...pitches].reverse() : mode === "updown" ? [...pitches, ...pitches.slice(1, -1).reverse()] : pitches;
    const span = Math.max(...group.map((n) => n.startTick + n.durationTicks)) - start;
    const steps = Math.max(pitches.length, Math.round(span / stepTicks));
    const velocity = Math.round(group.reduce((s, n) => s + n.velocity, 0) / group.length);
    for (const n of group) ops.push({ type: "deleteNote", trackId: clip.trackId, clipId: clip.clipId, noteId: n.id });
    for (let i = 0; i < steps; i++) {
      const s = start + Math.round((i * span) / steps);
      const e = start + Math.round(((i + 1) * span) / steps);
      if (e - s < 1) continue;
      ops.push({ type: "addNote", trackId: clip.trackId, clipId: clip.clipId, note: { id: newId(), pitch: seq[i % seq.length]!, startTick: s, durationTicks: e - s, velocity } });
    }
  }
  return ops;
}
