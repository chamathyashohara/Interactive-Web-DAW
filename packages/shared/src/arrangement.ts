import { DEFAULT_CLIP_BARS, MIN_CLIP_TICKS, TICKS_PER_BAR, type Clip, type Note, type Track } from "./model";
import type { OpBody } from "./ops";

/** Pure builders for arrangement edits. Each returns ops that the main process applies as ONE undo step (or null if impossible). */

export type IdGen = () => string;

export const sortedClips = (track: Track): Clip[] => Object.values(track.clips).sort((a, b) => a.startTick - b.startTick);

export function overlapsAny(track: Track, start: number, length: number, ignoreId?: string): boolean {
  return Object.values(track.clips).some((c) => c.id !== ignoreId && start < c.startTick + c.lengthTicks && c.startTick < start + length);
}

/** Room available from `start` until the next clip (or the end of the song). 0 if `start` is inside a clip. */
export function freeLengthFrom(track: Track, start: number, songLen: number, ignoreId?: string): number {
  let limit = songLen;
  for (const c of Object.values(track.clips)) {
    if (c.id === ignoreId) continue;
    if (start >= c.startTick && start < c.startTick + c.lengthTicks) return 0;
    if (c.startTick >= start) limit = Math.min(limit, c.startTick);
  }
  return Math.max(0, limit - start);
}

/** First bar-aligned start at or after `from` where `length` ticks fit; wraps to the beginning; null if the track is full. */
export function findFreeStart(track: Track, length: number, songLen: number, from = 0): number | null {
  const first = Math.ceil(Math.max(0, from) / TICKS_PER_BAR) * TICKS_PER_BAR;
  const candidates: number[] = [];
  for (let s = first; s + length <= songLen; s += TICKS_PER_BAR) candidates.push(s);
  for (let s = 0; s < first && s + length <= songLen; s += TICKS_PER_BAR) candidates.push(s);
  return candidates.find((s) => !overlapsAny(track, s, length)) ?? null;
}

export function nextClipName(track: Track): string {
  const used = new Set(Object.values(track.clips).map((c) => c.name));
  let n = Object.keys(track.clips).length + 1;
  while (used.has(`Clip ${n}`)) n++;
  return `Clip ${n}`;
}

/** New empty clip of up to DEFAULT_CLIP_BARS bars at `start` (shortened to fit before the next clip / song end). */
export function newClipOps(trackId: string, track: Track, newClipId: string, start: number, songLen: number): OpBody[] | null {
  const room = freeLengthFrom(track, start, songLen);
  const length = Math.min(DEFAULT_CLIP_BARS * TICKS_PER_BAR, Math.floor(room / TICKS_PER_BAR) * TICKS_PER_BAR || room);
  if (length < MIN_CLIP_TICKS) return null;
  return [{ type: "addClip", trackId, clip: { id: newClipId, name: nextClipName(track), startTick: start, lengthTicks: length, notes: {} } }];
}

export function moveClipOps(trackId: string, track: Track, clip: Clip, newStart: number, songLen: number): OpBody[] | null {
  const start = Math.max(0, Math.min(songLen - clip.lengthTicks, Math.round(newStart)));
  if (start === clip.startTick) return [];
  if (overlapsAny(track, start, clip.lengthTicks, clip.id)) return null;
  return [{ type: "updateClip", trackId, clipId: clip.id, changes: { startTick: start } }];
}

/** Resize from the right edge. Notes that no longer fit are trimmed or removed first so the clip stays valid. */
export function resizeClipOps(trackId: string, track: Track, clip: Clip, newLength: number, songLen: number): OpBody[] | null {
  const length = Math.round(newLength);
  if (length === clip.lengthTicks) return [];
  if (length < MIN_CLIP_TICKS || clip.startTick + length > songLen) return null;
  if (overlapsAny(track, clip.startTick, length, clip.id)) return null;
  const ops: OpBody[] = [];
  if (length < clip.lengthTicks) {
    for (const n of Object.values(clip.notes)) {
      if (n.startTick >= length) ops.push({ type: "deleteNote", trackId, clipId: clip.id, noteId: n.id });
      else if (n.startTick + n.durationTicks > length) ops.push({ type: "updateNote", trackId, clipId: clip.id, noteId: n.id, changes: { durationTicks: length - n.startTick } });
    }
  }
  ops.push({ type: "updateClip", trackId, clipId: clip.id, changes: { lengthTicks: length } });
  return ops;
}

/**
 * Split a clip in two at an absolute tick. Notes entirely after the cut move to the new clip; a note that crosses the cut
 * is shortened in the left clip and continues (as a new note) at the start of the right clip. Nothing is lost.
 */
export function splitClipOps(trackId: string, clip: Clip, atTick: number, newClipId: string, newNoteId: IdGen): OpBody[] | null {
  const cut = Math.round(atTick) - clip.startTick; // relative to the clip
  if (cut < MIN_CLIP_TICKS || clip.lengthTicks - cut < MIN_CLIP_TICKS) return null;
  const ops: OpBody[] = [];
  const rightNotes: Record<string, Note> = {};
  for (const n of Object.values(clip.notes)) {
    const end = n.startTick + n.durationTicks;
    if (end <= cut) continue; // stays
    const moved = (start: number, duration: number): Note => {
      const copy: Note = { id: newNoteId(), pitch: n.pitch, startTick: start, durationTicks: duration, velocity: n.velocity };
      if (n.muted) copy.muted = true;
      return copy;
    };
    if (n.startTick >= cut) {
      ops.push({ type: "deleteNote", trackId, clipId: clip.id, noteId: n.id });
      const m = moved(n.startTick - cut, n.durationTicks);
      rightNotes[m.id] = m;
    } else {
      ops.push({ type: "updateNote", trackId, clipId: clip.id, noteId: n.id, changes: { durationTicks: cut - n.startTick } });
      const m = moved(0, end - cut);
      rightNotes[m.id] = m;
    }
  }
  ops.push({ type: "updateClip", trackId, clipId: clip.id, changes: { lengthTicks: cut } });
  const right: Clip = { id: newClipId, startTick: clip.startTick + cut, lengthTicks: clip.lengthTicks - cut, notes: rightNotes };
  if (clip.name) right.name = clip.name;
  ops.push({ type: "addClip", trackId, clip: right });
  return ops;
}

/** Copy of a clip placed right after it (or in the next free bar-aligned slot). Notes get fresh ids. */
export function duplicateClipOps(trackId: string, track: Track, clip: Clip, newClipId: string, newNoteId: IdGen, songLen: number): OpBody[] | null {
  const end = clip.startTick + clip.lengthTicks;
  const start = !overlapsAny(track, end, clip.lengthTicks) && end + clip.lengthTicks <= songLen ? end : findFreeStart(track, clip.lengthTicks, songLen, end);
  if (start === null) return null;
  const notes: Record<string, Note> = {};
  for (const n of Object.values(clip.notes)) {
    const id = newNoteId();
    notes[id] = { ...n, id };
  }
  const copy: Clip = { id: newClipId, startTick: start, lengthTicks: clip.lengthTicks, notes };
  if (clip.name) copy.name = clip.name;
  return [{ type: "addClip", trackId, clip: copy }];
}

export const deleteClipOps = (trackId: string, clipId: string): OpBody[] => [{ type: "deleteClip", trackId, clipId }];
