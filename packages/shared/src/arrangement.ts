import { DEFAULT_CLIP_BARS, MIN_CLIP_TICKS, TICKS_PER_BAR, type Clip, type ClipAudio, type Note, type Track } from "./model";
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

/**
 * Notes that no longer fit are trimmed or removed so the clip stays valid. On a sample track a note that ran to the clip's end
 * (the one made by dropping a sound) keeps running to the new end, so lengthening and shortening a clip trims or extends the sound.
 */
function fitNotesOps(trackId: string, track: Track, clip: Clip, newLength: number): OpBody[] {
  const ops: OpBody[] = [];
  const sample = track.instrument === "sample";
  for (const n of Object.values(clip.notes)) {
    const end = n.startTick + n.durationTicks;
    if (n.startTick >= newLength) ops.push({ type: "deleteNote", trackId, clipId: clip.id, noteId: n.id });
    else if (sample && end >= clip.lengthTicks && end !== newLength) ops.push({ type: "updateNote", trackId, clipId: clip.id, noteId: n.id, changes: { durationTicks: newLength - n.startTick } });
    else if (end > newLength) ops.push({ type: "updateNote", trackId, clipId: clip.id, noteId: n.id, changes: { durationTicks: newLength - n.startTick } });
  }
  return ops;
}

/** The clip's audio settings after its length changed: fades shrink to fit, and a shortened clip now cuts its sound. */
function audioForLength(track: Track, clip: Clip, newLength: number, extra: Partial<ClipAudio> = {}): ClipAudio | null | undefined {
  if (track.instrument !== "sample") return undefined;
  const audio: ClipAudio = { ...clip.audio, ...extra };
  if (newLength < clip.lengthTicks) audio.cut = true;
  let fadeIn = audio.fadeInTicks ?? 0, fadeOut = audio.fadeOutTicks ?? 0;
  if (fadeIn + fadeOut > newLength) {
    const scale = newLength / (fadeIn + fadeOut);
    fadeIn = Math.floor(fadeIn * scale);
    fadeOut = Math.floor(fadeOut * scale);
    audio.fadeInTicks = fadeIn;
    audio.fadeOutTicks = fadeOut;
  }
  return audio;
}

/** Resize from the right edge. */
export function resizeClipOps(trackId: string, track: Track, clip: Clip, newLength: number, songLen: number): OpBody[] | null {
  const length = Math.round(newLength);
  if (length === clip.lengthTicks) return [];
  if (length < MIN_CLIP_TICKS || clip.startTick + length > songLen) return null;
  if (overlapsAny(track, clip.startTick, length, clip.id)) return null;
  const notes = fitNotesOps(trackId, track, clip, length);
  const audio = audioForLength(track, clip, length);
  const clipOp: OpBody = { type: "updateClip", trackId, clipId: clip.id, changes: audio !== undefined ? { lengthTicks: length, audio } : { lengthTicks: length } };
  return length > clip.lengthTicks ? [clipOp, ...notes] : [...notes, clipOp]; // a note must never be longer than its clip, in either order
}

/**
 * Trim the start of a sample clip: the clip's left edge moves to `newStart` and the sound still lines up (the part before the new
 * edge is hidden, or, when the edge moves left, the sound's earlier part is revealed). `nativeSecPerTick` converts arrangement time
 * to the sample's own time (60 / (tempo * PPQ), times the stretch ratio when the loop is fitted to the tempo).
 */
export function trimClipStartOps(trackId: string, track: Track, clip: Clip, newStart: number, songLen: number, nativeSecPerTick: number): OpBody[] | null {
  if (track.instrument !== "sample") return null;
  const start = Math.round(newStart);
  const delta = start - clip.startTick;
  if (delta === 0) return [];
  const length = clip.lengthTicks - delta;
  const startSec = (clip.audio?.startSec ?? 0) + delta * nativeSecPerTick;
  if (start < 0 || length < MIN_CLIP_TICKS || start + length > songLen || startSec < -1e-9) return null;
  if (overlapsAny(track, start, length, clip.id)) return null;
  const notes = fitNotesOps(trackId, track, clip, length);
  const audio = audioForLength(track, clip, length, { startSec: Math.max(0, startSec) });
  const clipOp: OpBody = { type: "updateClip", trackId, clipId: clip.id, changes: { startTick: start, lengthTicks: length, audio: audio ?? null } };
  return length > clip.lengthTicks ? [clipOp, ...notes] : [...notes, clipOp];
}

/**
 * Split a clip in two at an absolute tick. Notes entirely after the cut move to the new clip; a note that crosses the cut
 * is shortened in the left clip and continues (as a new note) at the start of the right clip. Nothing is lost.
 */
export function splitClipOps(trackId: string, clip: Clip, atTick: number, newClipId: string, newNoteId: IdGen, nativeSecPerTick?: number): OpBody[] | null {
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
  const rightLength = clip.lengthTicks - cut;
  const right: Clip = { id: newClipId, startTick: clip.startTick + cut, lengthTicks: rightLength, notes: rightNotes };
  if (nativeSecPerTick !== undefined) {
    // sample clip: the left half keeps its fade-in and ends with a cut; the right half continues the sound where the left stopped and keeps the fade-out
    const a = clip.audio ?? {};
    const leftAudio: ClipAudio = { ...a, cut: true };
    delete leftAudio.fadeOutTicks;
    if ((leftAudio.fadeInTicks ?? 0) > cut) leftAudio.fadeInTicks = cut;
    const rightAudio: ClipAudio = { ...a, startSec: (a.startSec ?? 0) + cut * nativeSecPerTick };
    delete rightAudio.fadeInTicks;
    if ((rightAudio.fadeOutTicks ?? 0) > rightLength) rightAudio.fadeOutTicks = rightLength;
    ops.push({ type: "updateClip", trackId, clipId: clip.id, changes: { lengthTicks: cut, audio: leftAudio } });
    right.audio = rightAudio;
  } else ops.push({ type: "updateClip", trackId, clipId: clip.id, changes: { lengthTicks: cut } });
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
  if (clip.audio) copy.audio = { ...clip.audio };
  return [{ type: "addClip", trackId, clip: copy }];
}

export const deleteClipOps = (trackId: string, clipId: string): OpBody[] => [{ type: "deleteClip", trackId, clipId }];
