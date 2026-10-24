import { MAX_SONG_BARS, TICKS_PER_BAR, type OpBody, type Project, type Track } from "@daw/shared";
import { isLessonTrack } from "./checks";

/**
 * Every Kick lesson has its own workspace: the tracks made in it. Only the open lesson's tracks are in the project (a
 * song holds at most 16 tracks); the others are saved and come back when their lesson opens again.
 */

/** The open lesson's tracks, as they are now (to save when another lesson opens). */
export const lessonTracksOf = (p: Project): Track[] => p.trackOrder.filter(isLessonTrack).map((id) => structuredClone(p.tracks[id]!));

/**
 * Ops (one undo step) that swap the workspace: remove the lesson tracks in the project and put `saved` back (nothing
 * for a lesson opened for the first time). The learner's own tracks are never touched, and the project always keeps at
 * least one track.
 */
export function spaceSwitchOps(p: Project, saved: Track[] | undefined): OpBody[] {
  const current = p.trackOrder.filter(isLessonTrack);
  const removable = current.length >= p.trackOrder.length ? current.slice(0, p.trackOrder.length - 1) : current;
  const ops: OpBody[] = removable.map((trackId) => ({ type: "deleteTrack", trackId }));
  const kept = new Set(p.trackOrder.filter((id) => !removable.includes(id)));
  const tracks = (saved ?? []).filter((t) => !kept.has(t.id));
  const end = Math.max(0, ...tracks.flatMap((t) => Object.values(t.clips).map((c) => c.startTick + c.lengthTicks)));
  const bars = Math.min(MAX_SONG_BARS, Math.ceil(end / TICKS_PER_BAR));
  if (bars > p.songBars) ops.push({ type: "setSongLength", bars });
  for (const t of tracks) ops.push({ type: "addTrack", track: t });
  return ops;
}
