import type { OpBody, Project, Track } from "@daw/shared";
import { isLessonTrack } from "./checks";
import { lessonTracksOf, spaceSwitchOps } from "./space";
import { studioState } from "./studioState";

/**
 * Lesson work never shows up in the Studio by itself: when the lessons close, the open lesson's tracks are taken out of
 * the song and saved with the lesson (they come back when it opens again). "Apply it in the studio" is the only way
 * lesson work reaches the song, as copies.
 */
export async function parkLessonWork(extra: OpBody[] = []): Promise<boolean> {
  const project = (await window.daw.getInitial()).project;
  // Only tracks that belong to an open lesson are taken out (they are saved under it); `extra` runs in the same step.
  const tracks = studioState.active() ? lessonTracksOf(project) : [];
  const ops = [...(tracks.length ? spaceSwitchOps(project, undefined) : []), ...extra];
  if (ops.length) {
    const res = await window.daw.dispatchBatch(ops);
    if (!res.ok) return false;
  }
  studioState.park(tracks);
  return true;
}

export const SONG_PART_PREFIX = "Song · ";
/**
 * A Special task's part, applied to the Studio: copies of the workspace tracks (reference tracks left out) named
 * "Song · Piano", "Song · Bass"... A part applied again replaces its earlier copy, so the song never has it twice. With
 * `tempo`, the song is set to the tempo the part was made at.
 */
export function applyPartOps(project: Project, uuid: () => string, tempo?: number): { ops: OpBody[]; open: { trackId: string; clipId: string } | null } {
  const lessonTracks = lessonTracksOf(project).filter((t) => !t.id.startsWith("lesson-song-ref-"));
  const names = lessonTracks.map((t) => SONG_PART_PREFIX + t.name.replace(/^Song: /, ""));
  const old = project.trackOrder.filter((id) => !isLessonTrack(id) && names.includes(project.tracks[id]!.name));
  const copies = applyCopiesOps({ ...project, trackOrder: lessonTracks.map((t) => t.id) }, uuid);
  const ops: OpBody[] = old.map((trackId): OpBody => ({ type: "deleteTrack", trackId }));
  let i = 0;
  for (const op of copies.ops) if (op.type === "addTrack") ops.push({ ...op, track: { ...op.track, name: names[i++]! } });
  // The part was made at its song's tempo: the song takes it too.
  if (tempo !== undefined && project.tempo !== tempo) ops.push({ type: "setTempo", bpm: tempo });
  return { ops, open: copies.open };
}

/**
 * Copies of the lesson's tracks as ordinary tracks of the song (new ids, so they are the learner's own from now on).
 * Returns the ops and the first copied clip, to open in the Studio.
 */
export function applyCopiesOps(project: Project, uuid: () => string): { ops: OpBody[]; open: { trackId: string; clipId: string } | null } {
  const ops: OpBody[] = [];
  let open: { trackId: string; clipId: string } | null = null;
  for (const t of lessonTracksOf(project)) {
    const id = `track-${uuid()}`;
    const clips: Track["clips"] = {};
    for (const c of Object.values(t.clips)) {
      const cid = uuid();
      clips[cid] = { ...c, id: cid, notes: Object.fromEntries(Object.values(c.notes).map((n) => { const nid = uuid(); return [nid, { ...n, id: nid }]; })) };
      open ??= { trackId: id, clipId: cid };
    }
    ops.push({ type: "addTrack", track: { ...t, id, name: t.name.replace(/^Song: /, ""), clips } });
  }
  return { ops, open };
}
