import type { Note, OpBody } from "@daw/shared";
import type { NoteClip } from "./editing";

export type RampCurve = "linear" | "ease-in" | "ease-out";

/**
 * Velocity ramp: the loudness of each note goes from `from` at the earliest note to `to` at the latest, by time (so notes that
 * sound together get the same loudness). "ease-in" starts slowly and speeds up (a build), "ease-out" is the opposite.
 * Only notes whose velocity actually changes produce an op.
 */
export function velocityRampOps(clip: NoteClip, notes: Note[], from: number, to: number, curve: RampCurve = "linear"): OpBody[] {
  if (notes.length === 0) return [];
  const first = Math.min(...notes.map((n) => n.startTick));
  const last = Math.max(...notes.map((n) => n.startTick));
  const ops: OpBody[] = [];
  for (const n of notes) {
    const f = last === first ? 0 : (n.startTick - first) / (last - first);
    const shaped = curve === "ease-in" ? f * f : curve === "ease-out" ? 1 - (1 - f) * (1 - f) : f;
    const velocity = Math.round(Math.min(127, Math.max(1, from + (to - from) * shaped)));
    if (velocity !== n.velocity) ops.push({ type: "updateNote", trackId: clip.trackId, clipId: clip.clipId, noteId: n.id, changes: { velocity } });
  }
  return ops;
}
