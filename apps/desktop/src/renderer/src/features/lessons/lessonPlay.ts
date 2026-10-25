import type { OpBody } from "@daw/shared";

/**
 * Play in the lessons: only the lesson's own tracks are heard, not the learner's song in the Studio. The engine plays
 * the whole project, so Play solos the lesson tracks (ids "lesson-...") for as long as it plays; the solo is taken off
 * again when playback stops or the lessons close (`releaseLessonSolo`). The learner's own tracks are never changed.
 */

const isLessonTrackId = (id: string) => id.startsWith("lesson-");
/** Lesson tracks this module soloed (and so must un-solo). */
let soloed: string[] = [];

const project = async () => (await window.daw.getInitial()).project;

/** Ops that solo the lesson tracks, when the project also has tracks of the learner's own (otherwise nothing to hide). */
export function lessonSoloOps(p: { trackOrder: string[]; tracks: Record<string, { solo?: boolean }> }): OpBody[] {
  const lesson = p.trackOrder.filter(isLessonTrackId);
  if (!lesson.length || lesson.length === p.trackOrder.length) return [];
  return lesson.filter((id) => !p.tracks[id]!.solo).map((trackId) => ({ type: "updateTrack", trackId, changes: { solo: true } }));
}

/** Starts playback with only the lesson's tracks audible. */
export async function playLesson(): Promise<void> {
  const ops = lessonSoloOps(await project());
  if (ops.length && (await window.daw.dispatchBatch(ops, "lesson-play")).ok) soloed = [...new Set([...soloed, ...ops.map((o) => (o as { trackId: string }).trackId)])];
  window.daw.play();
}

/** Takes off the solo Play put on (after playback stops, or when the lessons close). */
export async function releaseLessonSolo(): Promise<void> {
  if (!soloed.length) return;
  const p = await project();
  const ops: OpBody[] = soloed.filter((id) => p.tracks[id]?.solo).map((trackId) => ({ type: "updateTrack", trackId, changes: { solo: false } }));
  soloed = [];
  if (ops.length) await window.daw.dispatchBatch(ops, "lesson-play");
}
