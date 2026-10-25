import { isInKey, nearestInKey, sliceBend, type Note, type OpBody, type ProjectKey } from "@daw/shared";

/** Pure builders for multi-note edits. Each returns ops that the main process applies as ONE undo step. */

export interface NoteClip {
  trackId: string;
  clipId: string;
  lengthTicks: number;
}
export type NewId = () => string;

const clampInt = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)));

/** Copy: positions relative to the earliest note, so the group can be pasted anywhere. */
export function copyNotes(notes: Note[]): Note[] {
  if (notes.length === 0) return [];
  const min = Math.min(...notes.map((n) => n.startTick));
  return notes.map((n) => ({ ...n, startTick: n.startTick - min }));
}

/** Paste a copied group so its earliest note starts at `atTick`. Notes that would start past the clip are dropped; others are trimmed to fit. */
export function pasteOps(clip: NoteClip, copied: Note[], atTick: number, newId: NewId): OpBody[] {
  const ops: OpBody[] = [];
  for (const n of copied) {
    const start = atTick + n.startTick;
    if (start >= clip.lengthTicks) continue;
    const duration = Math.min(n.durationTicks, clip.lengthTicks - start);
    if (duration < 1) continue;
    const note: Note = { id: newId(), pitch: n.pitch, startTick: start, durationTicks: duration, velocity: n.velocity };
    if (n.muted) note.muted = true;
    if (n.bend) note.bend = n.bend.map((p) => ({ ...p })); // a pasted note glides like the one it was copied from
    ops.push({ type: "addNote", trackId: clip.trackId, clipId: clip.clipId, note });
  }
  return ops;
}

/** Duplicate: paste the selection directly after itself, rounded up to a whole number of grid steps. */
export function duplicateOps(clip: NoteClip, selected: Note[], gridTicks: number, newId: NewId): OpBody[] {
  if (selected.length === 0) return [];
  const min = Math.min(...selected.map((n) => n.startTick));
  const max = Math.max(...selected.map((n) => n.startTick + n.durationTicks));
  const span = Math.max(gridTicks, Math.ceil((max - min) / gridTicks) * gridTicks);
  return pasteOps(clip, copyNotes(selected), min + span, newId);
}

/** Quantize: move each note's start to the nearest grid line (keeps length; keeps the note inside the clip). */
export function quantizeOps(clip: NoteClip, notes: Note[], gridTicks: number): OpBody[] {
  const ops: OpBody[] = [];
  for (const n of notes) {
    const snapped = clampInt(Math.round(n.startTick / gridTicks) * gridTicks, 0, clip.lengthTicks - n.durationTicks);
    if (snapped !== n.startTick) ops.push({ type: "updateNote", trackId: clip.trackId, clipId: clip.clipId, noteId: n.id, changes: { startTick: snapped } });
  }
  return ops;
}

/** Slice a note in two at `atTick`. Returns null unless the cut is strictly inside the note. */
export function sliceOps(clip: NoteClip, note: Note, atTick: number, newId: NewId): OpBody[] | null {
  if (atTick <= note.startTick || atTick >= note.startTick + note.durationTicks) return null;
  const right: Note = { id: newId(), pitch: note.pitch, startTick: atTick, durationTicks: note.startTick + note.durationTicks - atTick, velocity: note.velocity };
  if (note.muted) right.muted = true;
  const rightBend = sliceBend(note.bend, atTick - note.startTick, note.durationTicks); // the right part carries its share of the glide; the left keeps the original curve
  if (rightBend) right.bend = rightBend;
  return [
    { type: "updateNote", trackId: clip.trackId, clipId: clip.clipId, noteId: note.id, changes: { durationTicks: atTick - note.startTick } },
    { type: "addNote", trackId: clip.trackId, clipId: clip.clipId, note: right },
  ];
}

export function deleteOps(clip: NoteClip, ids: string[]): OpBody[] {
  return ids.map((noteId) => ({ type: "deleteNote", trackId: clip.trackId, clipId: clip.clipId, noteId }));
}

/** Toggle mute for the given notes: if any is audible they all become muted, otherwise all are unmuted. */
export function toggleMuteOps(clip: NoteClip, notes: Note[]): OpBody[] {
  if (notes.length === 0) return [];
  const mute = notes.some((n) => !n.muted);
  return notes.map((n) => ({ type: "updateNote", trackId: clip.trackId, clipId: clip.clipId, noteId: n.id, changes: { muted: mute } }));
}

/** Move/resize preview math for a selection: shared delta clamped so every note stays inside range. */
export function clampGroupMove(
  notes: Note[],
  dTick: number,
  dPitch: number,
  clipLen: number,
  pitchMin: number,
  pitchMax: number,
): { dTick: number; dPitch: number } {
  const minStart = Math.min(...notes.map((n) => n.startTick));
  const maxEnd = Math.max(...notes.map((n) => n.startTick + n.durationTicks));
  const minPitch = Math.min(...notes.map((n) => n.pitch));
  const maxPitch = Math.max(...notes.map((n) => n.pitch));
  return {
    dTick: Math.round(Math.min(clipLen - maxEnd, Math.max(-minStart, dTick))),
    dPitch: Math.min(pitchMax - maxPitch, Math.max(pitchMin - minPitch, dPitch)),
  };
}

/** Move every note that is outside the key to the nearest note that is in it (lower on a tie). One undo step. */
export function fixOutOfKeyOps(clip: NoteClip, notes: Note[], key: ProjectKey): OpBody[] {
  const ops: OpBody[] = [];
  for (const n of notes) {
    if (isInKey(n.pitch, key)) continue;
    ops.push({ type: "updateNote", trackId: clip.trackId, clipId: clip.clipId, noteId: n.id, changes: { pitch: nearestInKey(n.pitch, key) } });
  }
  return ops;
}

/**
 * Transpose: shift every given note by `semitones` (negative = down). Moves as a group so chords stay intact: the shift
 * is clamped so no note leaves 0-127, and nothing moves if the group cannot shift that way at all. One undo step.
 */
export function transposeOps(clip: NoteClip, notes: Note[], semitones: number): OpBody[] {
  if (notes.length === 0 || semitones === 0) return [];
  const minPitch = Math.min(...notes.map((n) => n.pitch));
  const maxPitch = Math.max(...notes.map((n) => n.pitch));
  const d = Math.min(127 - maxPitch, Math.max(-minPitch, semitones));
  if (d === 0) return [];
  return notes.map((n) => ({ type: "updateNote", trackId: clip.trackId, clipId: clip.clipId, noteId: n.id, changes: { pitch: n.pitch + d } }));
}
