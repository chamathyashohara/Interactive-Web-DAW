import type { OpBody, Project } from "@daw/shared";

/**
 * Why a lesson track cannot be heard, and the ops that fix it. The engine stays silent for a muted track, for every
 * non-soloed track while another track is soloed, and when a fader is at 0 (previews included), so a learner who
 * muted the track in the studio would otherwise hear nothing in the lessons and not know why.
 */
export type Silence = { reason: "muted" | "soloElsewhere" | "trackVolume" | "masterVolume"; message: string; action: string; fix: OpBody[] };

export function whySilent(project: Project, trackId: string): Silence | null {
  const track = project.tracks[trackId];
  if (!track) return null;
  if (track.mute) {
    return { reason: "muted", message: "This lesson track is muted, so you can't hear it.", action: "Unmute", fix: [{ type: "updateTrack", trackId, changes: { mute: false } }] };
  }
  const soloed = project.trackOrder.filter((id) => project.tracks[id]?.solo);
  if (soloed.length && !track.solo) {
    return {
      reason: "soloElsewhere",
      message: `Another track (${project.tracks[soloed[0]!]!.name}) is soloed, so only soloed tracks can be heard.`,
      action: "Clear solo",
      fix: soloed.map((id) => ({ type: "updateTrack", trackId: id, changes: { solo: false } })),
    };
  }
  if (track.volume === 0) {
    return { reason: "trackVolume", message: "This lesson track's volume is at 0.", action: "Turn it up", fix: [{ type: "updateTrack", trackId, changes: { volume: 80 } }] };
  }
  if (project.masterVolume === 0) {
    return { reason: "masterVolume", message: "The master volume is at 0.", action: "Turn it up", fix: [{ type: "setMasterVolume", volume: 80 }] };
  }
  return null;
}
