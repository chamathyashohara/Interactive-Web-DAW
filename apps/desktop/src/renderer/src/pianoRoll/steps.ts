import { PPQ, TICKS_PER_BAR, type Note, type OpBody } from "@daw/shared";
import type { NewId, NoteClip } from "./editing";

/** The step sequencer's grid: sixteen steps (sixteenth notes) per bar. */
export const STEP_TICKS = PPQ / 4;
export const STEPS_PER_BAR = TICKS_PER_BAR / STEP_TICKS;
export const NORMAL_VELOCITY = 100;
export const ACCENT_VELOCITY = 127;

export const stepTick = (bar: number, step: number) => bar * TICKS_PER_BAR + step * STEP_TICKS;
export const barCount = (clipLengthTicks: number) => Math.max(1, Math.ceil(clipLengthTicks / TICKS_PER_BAR));
/** How many of the bar's sixteen steps lie inside the clip (a clip that ends mid-bar has fewer). */
export const stepsInBar = (clipLengthTicks: number, bar: number) => Math.max(0, Math.min(STEPS_PER_BAR, Math.floor((clipLengthTicks - bar * TICKS_PER_BAR) / STEP_TICKS)));

/** The notes of one drum on one step: anything starting inside that sixteenth counts, so hand-played notes show up too. */
export const notesAtStep = (notes: Note[], pitch: number, tick: number) => notes.filter((n) => n.pitch === pitch && n.startTick >= tick && n.startTick < tick + STEP_TICKS);

/** The loudness shown for a step (the loudest note on it), or null when the step is empty. */
export function stepVelocity(notes: Note[], pitch: number, tick: number): number | null {
  const at = notesAtStep(notes, pitch, tick).filter((n) => !n.muted);
  return at.length ? Math.max(...at.map((n) => n.velocity)) : null;
}

/** Turns a step on at a loudness, or off (velocity null). Several notes on one step collapse to one. */
export function setStepOps(clip: NoteClip, notes: Note[], pitch: number, tick: number, velocity: number | null, newId: NewId): OpBody[] {
  const at = notesAtStep(notes, pitch, tick);
  const del = (n: Note): OpBody => ({ type: "deleteNote", trackId: clip.trackId, clipId: clip.clipId, noteId: n.id });
  if (velocity === null) return at.map(del);
  if (at.length === 0) {
    const duration = Math.min(STEP_TICKS, clip.lengthTicks - tick);
    if (duration < 1) return [];
    return [{ type: "addNote", trackId: clip.trackId, clipId: clip.clipId, note: { id: newId(), pitch, startTick: tick, durationTicks: duration, velocity } }];
  }
  const [keep, ...extra] = at;
  const ops: OpBody[] = [];
  if (keep!.velocity !== velocity || keep!.muted) ops.push({ type: "updateNote", trackId: clip.trackId, clipId: clip.clipId, noteId: keep!.id, changes: { velocity, muted: false } });
  return [...ops, ...extra.map(del)];
}

/** Removes every note in one bar (of one drum, or all of them). */
export function clearBarOps(clip: NoteClip, notes: Note[], bar: number, pitch?: number): OpBody[] {
  const from = bar * TICKS_PER_BAR, to = from + TICKS_PER_BAR;
  return notes.filter((n) => n.startTick >= from && n.startTick < to && (pitch === undefined || n.pitch === pitch)).map((n): OpBody => ({ type: "deleteNote", trackId: clip.trackId, clipId: clip.clipId, noteId: n.id }));
}

/** Makes every other bar of the clip a copy of `bar`. */
export function copyBarToAllOps(clip: NoteClip, notes: Note[], bar: number, newId: NewId): OpBody[] {
  const ops: OpBody[] = [];
  const source = notes.filter((n) => n.startTick >= bar * TICKS_PER_BAR && n.startTick < (bar + 1) * TICKS_PER_BAR);
  for (let b = 0; b < barCount(clip.lengthTicks); b++) {
    if (b === bar) continue;
    ops.push(...clearBarOps(clip, notes, b));
    for (const n of source) {
      const start = n.startTick - bar * TICKS_PER_BAR + b * TICKS_PER_BAR;
      const duration = Math.min(n.durationTicks, clip.lengthTicks - start);
      if (duration < 1) continue;
      const note: Note = { id: newId(), pitch: n.pitch, startTick: start, durationTicks: duration, velocity: n.velocity };
      if (n.muted) note.muted = true;
      ops.push({ type: "addNote", trackId: clip.trackId, clipId: clip.clipId, note });
    }
  }
  return ops;
}
