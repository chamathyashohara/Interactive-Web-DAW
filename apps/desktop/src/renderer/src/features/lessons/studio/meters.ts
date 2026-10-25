import { useSyncExternalStore } from "react";
import { projectStore, statusStore } from "../../../store";

/**
 * Peak levels measured while the song plays, for the gain staging and headroom lessons (10.2, 10.5): the loudest value of
 * each track's meter and of the master since playback started. A new Play, or changing a level, pan or mute, starts the
 * measurement again, so a check never reads levels from before the learner's last change.
 */

export interface Peaks {
  /** Linear peak per track id (post-fader). */
  tracks: Record<string, number>;
  /** Linear master peak (left or right, whichever is louder). */
  master: number;
  /** How long it has been measuring, in status messages (about 30 per second). */
  samples: number;
}
let peaks: Peaks = { tracks: {}, master: 0, samples: 0 };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const reset = () => {
  peaks = { tracks: {}, master: 0, samples: 0 };
  emit();
};

let wasPlaying = false;
statusStore.subscribe(() => {
  const s = statusStore.get();
  if (!s) return;
  if (s.playing && !wasPlaying) reset();
  wasPlaying = s.playing;
  if (!s.playing) return;
  const tracks = { ...peaks.tracks };
  for (const [id, v] of Object.entries(s.levels ?? {})) tracks[id] = Math.max(tracks[id] ?? 0, v);
  peaks = { tracks, master: Math.max(peaks.master, s.masterL ?? 0, s.masterR ?? 0), samples: peaks.samples + 1 };
  emit();
});

let mixSignature = "";
projectStore.subscribe(() => {
  const p = projectStore.get().project;
  if (!p) return;
  const sig = `${p.masterVolume}|${p.trackOrder.map((id) => `${id}:${p.tracks[id]!.volume}:${p.tracks[id]!.pan}:${p.tracks[id]!.mute}:${p.tracks[id]!.solo}`).join(",")}`;
  if (sig !== mixSignature) {
    if (mixSignature) reset();
    mixSignature = sig;
  }
});

export const currentPeaks = () => peaks;
export const usePeaks = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => peaks,
  );
/** dBFS of a linear level (-inf shown as -99). */
export const toDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : -99);
