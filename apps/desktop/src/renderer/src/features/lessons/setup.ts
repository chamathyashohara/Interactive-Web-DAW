import {
  MAX_TRACKS,
  TICKS_PER_BAR,
  TRACK_COLORS,
  createTrack,
  findFreeStart,
  songTicks,
  type Clip,
  type IdGen,
  type Note,
  type OpBody,
  type Project,
  type Track,
} from "@daw/shared";
import type { Exercise, Lesson } from "./types";

/** Matches the piano roll's drawing velocity. */
export const DEFAULT_VELOCITY = 96;

/** One lesson track per lesson, so coming back to a lesson continues the same work. */
export const lessonTrackId = (lessonId: string) => `lesson-${lessonId}`;
export const lessonClipId = (lessonId: string) => `lesson-${lessonId}-clip`;

export interface ExerciseLocation {
  trackId: string;
  clipId: string;
}

export type SetupResult = ({ ok: true; ops: OpBody[] } & ExerciseLocation) | { ok: false; reason: string };

function starterNotes(exercise: Exercise, newNoteId: IdGen): Record<string, Note> {
  const notes: Record<string, Note> = {};
  for (const s of exercise.starterNotes) {
    const id = newNoteId();
    notes[id] = { id, pitch: s.pitch, startTick: s.startTick, durationTicks: s.durationTicks, velocity: s.velocity ?? DEFAULT_VELOCITY };
  }
  return notes;
}

/** Where the exercise lives in the project right now, or null if it has not been started (or was undone/deleted). */
export function findExercise(project: Project, lessonId: string): (ExerciseLocation & { track: Track; clip: Clip }) | null {
  const track = project.tracks[lessonTrackId(lessonId)];
  const clip = track?.clips[lessonClipId(lessonId)];
  return track && clip ? { trackId: track.id, clipId: clip.id, track, clip } : null;
}

/**
 * Ops that put the exercise into the project as ONE batch (one undo step). Reuses the lesson's track and clip when
 * they already exist (the learner keeps their work); otherwise adds the missing parts, lengthening the song first
 * if it is shorter than the exercise.
 */
export function startExerciseOps(project: Project, lesson: Pick<Lesson, "id" | "title">, exercise: Exercise, newNoteId: IdGen): SetupResult {
  const trackId = lessonTrackId(lesson.id);
  const clipId = lessonClipId(lesson.id);
  const length = exercise.bars * TICKS_PER_BAR;
  const existing = project.tracks[trackId];
  if (existing?.clips[clipId]) return { ok: true, ops: [], trackId, clipId };

  const ops: OpBody[] = [];
  const songLen = Math.max(songTicks(project), length);
  if (songLen > songTicks(project)) ops.push({ type: "setSongLength", bars: exercise.bars });

  if (existing) {
    const start = findFreeStart(existing, length, songLen, 0);
    if (start === null) return { ok: false, reason: `The track "${existing.name}" has no free ${exercise.bars} bars. Delete a clip on it, or lengthen the song.` };
    ops.push({ type: "addClip", trackId, clip: { id: clipId, name: "Exercise", startTick: start, lengthTicks: length, notes: starterNotes(exercise, newNoteId) } });
    return { ok: true, ops, trackId, clipId };
  }

  if (project.trackOrder.length >= MAX_TRACKS) {
    return { ok: false, reason: `The project already has ${MAX_TRACKS} tracks, the most it can hold. Delete a track to make room for the exercise.` };
  }
  const color = TRACK_COLORS[project.trackOrder.length % TRACK_COLORS.length]!;
  const track: Track = {
    ...createTrack(trackId, `Lesson: ${lesson.title}`.slice(0, 40), exercise.instrument, color, clipId),
    clips: { [clipId]: { id: clipId, name: "Exercise", startTick: 0, lengthTicks: length, notes: starterNotes(exercise, newNoteId) } },
  };
  ops.push({ type: "addTrack", track });
  return { ok: true, ops, trackId, clipId };
}

/** Puts the clip back to its starting state as one batch: removes every note, restores the length, adds the starter notes. */
export function resetExerciseOps(location: ExerciseLocation, clip: Clip, exercise: Exercise, newNoteId: IdGen): OpBody[] {
  const { trackId, clipId } = location;
  const ops: OpBody[] = Object.keys(clip.notes).map((noteId) => ({ type: "deleteNote", trackId, clipId, noteId }));
  const length = exercise.bars * TICKS_PER_BAR;
  if (clip.lengthTicks !== length) ops.push({ type: "updateClip", trackId, clipId, changes: { lengthTicks: length } });
  for (const note of Object.values(starterNotes(exercise, newNoteId))) ops.push({ type: "addNote", trackId, clipId, note });
  return ops;
}
