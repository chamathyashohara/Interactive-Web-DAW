import { sliceBend, type Note, type OpBody } from "@daw/shared";
import type { NewId, NoteClip } from "./editing";

/**
 * The piano-roll chopper (Lesson 5.2 · Alt+U): slices each note into equal pieces of about `pieceTicks` each, back to
 * back over the note's own length, so a held note becomes a repeated rhythm (e.g. a bass root chopped into 1/8 notes).
 * A note too short to make two pieces is left alone. One undo step.
 */
export function chopOps(clip: NoteClip, notes: Note[], pieceTicks: number, newId: NewId): OpBody[] {
  if (pieceTicks < 1) return [];
  const ops: OpBody[] = [];
  for (const n of notes) {
    const pieces = Math.round(n.durationTicks / pieceTicks);
    if (pieces < 2) continue;
    ops.push({ type: "deleteNote", trackId: clip.trackId, clipId: clip.clipId, noteId: n.id });
    for (let i = 0; i < pieces; i++) {
      const start = n.startTick + Math.round((i * n.durationTicks) / pieces);
      const end = n.startTick + Math.round(((i + 1) * n.durationTicks) / pieces);
      if (end - start < 1) continue;
      const note: Note = { id: newId(), pitch: n.pitch, startTick: start, durationTicks: end - start, velocity: n.velocity };
      if (n.muted) note.muted = true;
      const bend = sliceBend(n.bend, start - n.startTick, end - n.startTick); // each piece glides along its own part of the curve
      if (bend) note.bend = bend;
      ops.push({ type: "addNote", trackId: clip.trackId, clipId: clip.clipId, note });
    }
  }
  return ops;
}
