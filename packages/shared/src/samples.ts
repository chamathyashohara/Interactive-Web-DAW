import { MAX_SONG_BARS, MAX_TRACKS, TICKS_PER_BAR, createTrack, type Project } from "./model";
import type { OpBody } from "./ops";
import { overlapsAny } from "./arrangement";

/** The part of a library entry the arrangement needs to place a sound. */
export interface DroppedSample {
  id: string;
  name: string;
  category: string;
  durationSec: number;
  meta: { bpm?: number; bars?: number; loop?: boolean };
}

/** MIDI note at which a sample plays at its original pitch. */
export const SAMPLE_ROOT_NOTE = 60;
const MAX_CLIP_BARS = 32;

/** Loops and other long sounds are cut by a note-off; one-shots (kicks, snares, hats...) always play to the end. */
export const isGateSample = (s: Pick<DroppedSample, "category" | "meta">): boolean => s.category === "Loop" || s.meta.loop === true;

/** How many bars a dropped sound covers: the loop's own bar count, else its length at the project tempo (at least one bar). */
export function sampleBars(s: DroppedSample, tempo: number): number {
  // A loop with a known tempo covers the same number of bars at any project tempo (it is stretched to fit); anything else is as long as it is.
  const loopBars = s.meta.loop ? (s.meta.bars ?? (s.meta.bpm ? Math.round((s.durationSec * s.meta.bpm) / 240) : undefined)) : undefined;
  const bars = loopBars ?? Math.ceil((s.durationSec * tempo) / 240 - 1e-9);
  return Math.max(1, Math.min(MAX_CLIP_BARS, bars));
}

export interface DropIds {
  trackId: string;
  clipId: string;
  noteId: string;
}
export type DropResult = { ok: true; ops: OpBody[]; trackId: string; clipId: string; newTrack: boolean } | { ok: false; reason: string };

/**
 * Ops for dropping a sound on the arrangement at `tick`.
 * - On a lane that already plays this same sound: a new clip on that track.
 * - Anywhere else: a new sample track named after the sound, with one clip.
 * The clip holds one note at the sample's original pitch, so the piano roll, mixer, mute and export all work unchanged.
 * Everything is one batch, so one undo step removes it all.
 */
export function dropSampleOps(project: Project, sample: DroppedSample, tick: number, laneTrackId: string | null, ids: DropIds, color: string): DropResult {
  const bars = sampleBars(sample, project.tempo);
  const length = bars * TICKS_PER_BAR;
  const start = Math.max(0, Math.floor(tick)); // the caller has already snapped it to the grid
  const ops: OpBody[] = [];
  const needBars = Math.ceil(start / TICKS_PER_BAR + bars - 1e-9);
  if (needBars > project.songBars) {
    if (needBars > MAX_SONG_BARS) return { ok: false, reason: "That would make the song longer than the maximum." };
    ops.push({ type: "setSongLength", bars: needBars });
  }
  const clip = {
    id: ids.clipId,
    name: sample.name.slice(0, 40),
    startTick: start,
    lengthTicks: length,
    notes: { [ids.noteId]: { id: ids.noteId, pitch: SAMPLE_ROOT_NOTE, startTick: 0, durationTicks: length, velocity: 100 } },
  };

  const lane = laneTrackId ? project.tracks[laneTrackId] : undefined;
  if (lane && lane.instrument === "sample" && lane.sample?.id === sample.id) {
    if (overlapsAny(lane, start, length)) return { ok: false, reason: "There is already a clip there. Drop it on a free bar, or on an empty area for a new track." };
    ops.push({ type: "addClip", trackId: lane.id, clip });
    return { ok: true, ops, trackId: lane.id, clipId: ids.clipId, newTrack: false };
  }

  if (project.trackOrder.length >= MAX_TRACKS) return { ok: false, reason: `A song can have at most ${MAX_TRACKS} tracks.` };
  const track = createTrack(ids.trackId, sample.name.slice(0, 40), "sample", color, ids.clipId);
  track.sample = { id: sample.id, name: sample.name, gate: isGateSample(sample) };
  if (sample.meta.bpm && isGateSample(sample)) {
    track.sample.bpm = sample.meta.bpm;
    track.sample.fit = true; // a loop made at 90 BPM drops into a 120 BPM song already stretched to 120
  }
  track.clips = { [ids.clipId]: clip };
  ops.push({ type: "addTrack", track });
  return { ok: true, ops, trackId: ids.trackId, clipId: ids.clipId, newTrack: true };
}
