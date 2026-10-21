/** Pulses per quarter note. All musical time is stored as integer ticks. */
export const PPQ = 960;
export const BEATS_PER_BAR = 4;
export const TICKS_PER_BAR = PPQ * BEATS_PER_BAR;

export const MIN_PITCH = 0;
export const MAX_PITCH = 127;
export const MIN_BPM = 20;
export const MAX_BPM = 300;
export const MAX_TRACKS = 16;
export const DEFAULT_VOLUME = 80;

export type InstrumentKind = "synth" | "drums";
export const INSTRUMENTS: InstrumentKind[] = ["synth", "drums"];

export const TRACK_COLORS = ["#22d3ee", "#f472b6", "#a3e635", "#fb923c", "#a78bfa", "#facc15", "#34d399", "#f87171"];

export interface Note {
  id: string;
  pitch: number;
  /** Relative to the owning clip's start. */
  startTick: number;
  durationTicks: number;
  velocity: number;
  /** Muted notes stay in the project but are not played. Absent means not muted. */
  muted?: boolean;
}

export interface Clip {
  id: string;
  /** Position on the arrangement timeline. */
  startTick: number;
  lengthTicks: number;
  notes: Record<string, Note>;
}

export interface Track {
  id: string;
  name: string;
  instrument: InstrumentKind;
  /** "#rrggbb" */
  color: string;
  /** 0..100 */
  volume: number;
  /** -100 (left) .. 100 (right) */
  pan: number;
  mute: boolean;
  solo: boolean;
  clips: Record<string, Clip>;
}

/** Synced and saved project state. UI state (selection, zoom, playhead) never lives here. */
export interface Project {
  id: string;
  name: string;
  tempo: number;
  ppq: number;
  /** 0..100 */
  masterVolume: number;
  tracks: Record<string, Track>;
  trackOrder: string[];
  /** Bounded list of recently applied opIds, used to make re-delivery idempotent. */
  recentOps: string[];
}

export const RECENT_OPS_LIMIT = 2000;

export function createTrack(id: string, name: string, instrument: InstrumentKind, color: string, clipId: string): Track {
  return {
    id,
    name,
    instrument,
    color,
    volume: DEFAULT_VOLUME,
    pan: 0,
    mute: false,
    solo: false,
    clips: { [clipId]: { id: clipId, startTick: 0, lengthTicks: 4 * TICKS_PER_BAR, notes: {} } },
  };
}

export function createProject(id: string, name = "Untitled"): Project {
  const trackId = "track-1";
  return {
    id,
    name,
    tempo: 120,
    ppq: PPQ,
    masterVolume: DEFAULT_VOLUME,
    trackOrder: [trackId],
    tracks: { [trackId]: createTrack(trackId, "Synth", "synth", TRACK_COLORS[0]!, "clip-1") },
    recentOps: [],
  };
}

/** Fills defaults for projects saved by older versions (M1 had no mixer fields). */
export function migrateProject(raw: Project): Project {
  const tracks: Record<string, Track> = {};
  let i = 0;
  for (const [id, t] of Object.entries(raw.tracks)) {
    tracks[id] = {
      ...t,
      color: t.color ?? TRACK_COLORS[i % TRACK_COLORS.length]!,
      volume: t.volume ?? DEFAULT_VOLUME,
      pan: t.pan ?? 0,
      mute: t.mute ?? false,
      solo: t.solo ?? false,
    };
    i++;
  }
  return { ...raw, tracks, masterVolume: raw.masterVolume ?? DEFAULT_VOLUME };
}
