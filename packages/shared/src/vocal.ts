import { MAX_SONG_BARS, MAX_TRACKS, PPQ, TICKS_PER_BAR, createTrack, type Project } from "./model";
import type { OpBody } from "./ops";

/** Name given to the tracks that hold a recorded vocal take. The backing track sent to the singer leaves these tracks out. */
export const VOCAL_TRACK_PREFIX = "Vocal take";
export const isVocalTrackName = (name: string): boolean => name.startsWith(VOCAL_TRACK_PREFIX);

const ticksPerSecond = (tempo: number, ppq: number): number => (tempo / 60) * ppq;
export const secondsToTicks = (sec: number, tempo: number, ppq = PPQ): number => sec * ticksPerSecond(tempo, ppq);
export const ticksToSeconds = (ticks: number, tempo: number, ppq = PPQ): number => ticks / ticksPerSecond(tempo, ppq);

export interface VocalPlacementInput {
  /** where the producer pressed Record (song position, ticks) */
  startTick: number;
  tempo: number;
  /** length of the recorded WAV, seconds */
  durationSec: number;
  /** the singer's speaker-to-microphone round trip (seconds): the vocal in the file is this much later than the music it answers */
  latencySec: number;
  /** how late the recording actually began compared with the music (seconds, 0 when it began on the same sample) */
  lateSec: number;
}
export interface VocalPlacement {
  startTick: number;
  lengthTicks: number;
  /** seconds cut from the start of the file */
  trimSec: number;
}

/**
 * Where a recorded vocal goes on the timeline. File sample i answers the music at (i / rate + late - latency) after the take's start, so the
 * file's first sample belongs at `late - latency` seconds from the start position: later if positive, and if negative the first
 * part of the file (the silence before the singer could hear anything) is trimmed away.
 */
export function planVocalClip(i: VocalPlacementInput, ppq = PPQ): VocalPlacement {
  const net = i.lateSec - i.latencySec;
  const tps = ticksPerSecond(i.tempo, ppq);
  const shiftTicks = net > 0 ? Math.round(net * tps) : 0;
  const trimSec = net < 0 ? Math.min(-net, Math.max(0, i.durationSec - 0.05)) : 0;
  const lengthTicks = Math.max(Math.round(ppq / 4), Math.ceil((i.durationSec - trimSec) * tps));
  return { startTick: Math.max(0, Math.round(i.startTick) + shiftTicks), lengthTicks, trimSec };
}

export interface VocalTakeIds {
  trackId: string;
  clipId: string;
  noteId: string;
}

export type VocalTakeResult = { ok: true; ops: OpBody[]; trackId: string; placement: VocalPlacement } | { ok: false; reason: string };

/**
 * Ops that put a recorded vocal on its own new track ("Vocal take N"), at the song position it was recorded from, trimmed for latency.
 * Each take gets a track of its own, so recording again never overwrites an earlier take. One batch = one undo step.
 * Unlike a dropped sample the clip is not limited to 32 bars: it is as long as the recording, and the song is lengthened if needed.
 */
export function vocalTakeOps(
  project: Project,
  sample: { id: string; name: string },
  input: VocalPlacementInput,
  takeNumber: number,
  ids: VocalTakeIds,
  color: string,
): VocalTakeResult {
  if (project.trackOrder.length >= MAX_TRACKS) return { ok: false, reason: `A song can have at most ${MAX_TRACKS} tracks. Delete an old vocal take to make room.` };
  const placement = planVocalClip(input, project.ppq);
  const end = placement.startTick + placement.lengthTicks;
  const ops: OpBody[] = [];
  const needBars = Math.ceil(end / TICKS_PER_BAR - 1e-9);
  if (needBars > project.songBars) {
    if (needBars > MAX_SONG_BARS) return { ok: false, reason: "That take would make the song longer than the maximum." };
    ops.push({ type: "setSongLength", bars: needBars });
  }
  const name = `${VOCAL_TRACK_PREFIX} ${takeNumber}`;
  const track = createTrack(ids.trackId, name, "sample", color, ids.clipId);
  track.sample = { id: sample.id, name: sample.name, gate: false };
  track.clips = {
    [ids.clipId]: {
      id: ids.clipId,
      name: name.slice(0, 40),
      startTick: placement.startTick,
      lengthTicks: placement.lengthTicks,
      notes: { [ids.noteId]: { id: ids.noteId, pitch: 60, startTick: 0, durationTicks: placement.lengthTicks, velocity: 100 } },
      ...(placement.trimSec > 0 ? { audio: { startSec: placement.trimSec, cut: true } } : { audio: { cut: true } }),
    },
  };
  ops.push({ type: "addTrack", track });
  return { ok: true, ops, trackId: ids.trackId, placement };
}
