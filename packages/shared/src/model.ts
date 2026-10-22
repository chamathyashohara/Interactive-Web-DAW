import type { ProjectKey } from "./theory";

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
export const MAX_SONG_BARS = 128;
export const DEFAULT_SONG_BARS = 8;
/** A clip is at least one beat long. */
export const MIN_CLIP_TICKS = PPQ;
export const DEFAULT_CLIP_BARS = 4;

export type InstrumentKind = "synth" | "drums" | "sample" | "plugin";
/** The instruments offered by "+ Add track". Sample tracks are created by dropping a sound from the browser. */
export const INSTRUMENTS: InstrumentKind[] = ["synth", "drums"];
export const ALL_INSTRUMENTS: InstrumentKind[] = ["synth", "drums", "sample", "plugin"];

/** The sound a sample track plays. The audio itself is never stored in the project, only its library id. */
/** The VST3 instrument a plugin track plays. The plugin binary and its audio are never in the project, only the path and the plugin's own saved settings. */
export interface PluginRef {
  /** The plugin's .vst3 path on this computer (what the engine is told to load). */
  id: string;
  /** Display name, shown if the plugin is missing from this computer. */
  name: string;
  /** Base64 of the plugin's own saved state (its patch/settings); omitted until the plugin has been opened and saved. */
  state?: string;
}
export const MAX_PLUGIN_ID = 1024;
export const MAX_PLUGIN_NAME = 200;
export const MAX_PLUGIN_STATE = 8_000_000; // a plugin's saved patch, base64; generous but bounded so a project cannot grow without limit

export interface SampleRef {
  /** Library id, e.g. "starter/kick/punch-kick" or "imported/<hash>". */
  id: string;
  /** Name when it was added, shown if the sound is missing from this computer's library. */
  name: string;
  /** true: a note-off cuts the sound (loops, long sounds). false: it always plays to its end (kicks, snares, one-shots). */
  gate: boolean;
  /** The tempo the sound was recorded at (loops). Needed to fit it to the project tempo. */
  bpm?: number;
  /** true: the sound is time-stretched (pitch unchanged) to follow the project tempo. Only has an effect when `bpm` is known. */
  fit?: boolean;
}

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

/**
 * How a clip on a sample track sounds. Everything is optional; absent means "as recorded".
 * Times that depend on the sample (`startSec`) are in the sample's own seconds, so they survive tempo changes;
 * fades are in ticks, so they follow the arrangement.
 */
export interface ClipAudio {
  /** Level change in dB (-60 .. +12). */
  gainDb?: number;
  /** Fade-in / fade-out lengths in ticks (their sum never exceeds the clip length). */
  fadeInTicks?: number;
  fadeOutTicks?: number;
  /** Where in the sample the clip starts playing (seconds from its beginning): trimming the start. */
  startSec?: number;
  /** true: the sound is cut where the clip ends (instead of ringing out to its own end). Set when the clip is shortened. */
  cut?: boolean;
}
export const MIN_GAIN_DB = -60;
export const MAX_GAIN_DB = 12;

export interface Clip {
  id: string;
  /** Display name, 1-40 characters. Optional. */
  name?: string;
  /** Position on the arrangement timeline. */
  startTick: number;
  lengthTicks: number;
  /** Notes are relative to the clip start and always lie inside [0, lengthTicks]. */
  notes: Record<string, Note>;
  /** Only on sample tracks. */
  audio?: ClipAudio;
}

/** What an automation lane controls. */
export type AutoParam = "volume" | "filter";
export const AUTO_PARAMS: AutoParam[] = ["volume", "filter"];
export const MAX_AUTO_POINTS = 64;

/** One point of an automation curve: an arrangement tick and a value from 0 to 1. */
export interface AutoPoint {
  tick: number;
  value: number;
}

/** Lowest and highest cutoff of the filter lane; value 0..1 runs between them on a logarithmic scale, 1 = wide open (no filtering). */
export const FILTER_MIN_HZ = 20;
export const FILTER_MAX_HZ = 20000;
export const filterHz = (value: number): number => FILTER_MIN_HZ * (FILTER_MAX_HZ / FILTER_MIN_HZ) ** value;

/** The value of a curve at `tick`: before the first point and after the last it holds that point's value; between points it is a straight line. */
export function autoValueAt(points: readonly AutoPoint[], tick: number): number {
  if (points.length === 0) return 1;
  if (tick <= points[0]!.tick) return points[0]!.value;
  const last = points[points.length - 1]!;
  if (tick >= last.tick) return last.value;
  let i = 1;
  while (points[i]!.tick < tick) i++;
  const a = points[i - 1]!, b = points[i]!;
  return a.value + ((b.value - a.value) * (tick - a.tick)) / (b.tick - a.tick);
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
  /** Only for instrument "sample". */
  sample?: SampleRef;
  /** Only for instrument "plugin": the VST3 instrument this track plays (absent until one is chosen). */
  plugin?: PluginRef;
  /** Curves that move a control over the song. A parameter without a curve is not automated. */
  automation?: Partial<Record<AutoParam, AutoPoint[]>>;
  /** Clips on one track never overlap. */
  clips: Record<string, Clip>;
}

/** Playback repeats between these two ticks instead of over the whole song. */
export interface LoopRegion {
  startTick: number;
  endTick: number;
}

/** A named point in the song ("Verse", "Drop"), shown on the ruler. */
export interface Marker {
  id: string;
  tick: number;
  name: string;
  /** "#rrggbb" */
  color?: string;
}
export const MAX_MARKERS = 64;
export const MAX_MARKER_NAME = 24;

/** Synced and saved project state. UI state (selection, zoom, playhead) never lives here. */
export interface Project {
  id: string;
  name: string;
  tempo: number;
  ppq: number;
  /** Song length in bars; playback loops here and export renders exactly this long (plus a tail). */
  songBars: number;
  /** The song's key, used for scale highlighting and out-of-key help. null = no key chosen. */
  key: ProjectKey | null;
  /** The part of the song that plays over and over. Absent = the whole song. */
  loop?: LoopRegion;
  /** Section markers in time order. */
  markers?: Marker[];
  /** 0..100 */
  masterVolume: number;
  tracks: Record<string, Track>;
  trackOrder: string[];
  /** Bounded list of recently applied opIds, used to make re-delivery idempotent. */
  recentOps: string[];
}

export const RECENT_OPS_LIMIT = 2000;
export const songTicks = (project: Pick<Project, "songBars">) => project.songBars * TICKS_PER_BAR;

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
    clips: { [clipId]: { id: clipId, name: "Clip 1", startTick: 0, lengthTicks: DEFAULT_CLIP_BARS * TICKS_PER_BAR, notes: {} } },
  };
}

export function createProject(id: string, name = "Untitled"): Project {
  const trackId = "track-1";
  return {
    id,
    name,
    tempo: 120,
    ppq: PPQ,
    songBars: DEFAULT_SONG_BARS,
    key: null,
    masterVolume: DEFAULT_VOLUME,
    trackOrder: [trackId],
    tracks: { [trackId]: createTrack(trackId, "Synth", "synth", TRACK_COLORS[0]!, "clip-1") },
    recentOps: [],
  };
}

/** Fills defaults for projects saved by older versions (M1: no mixer fields; M2: no song length; M3: no key). */
export function migrateProject(raw: Project): Project {
  const tracks: Record<string, Track> = {};
  let i = 0;
  let maxEnd = 0;
  for (const [id, t] of Object.entries(raw.tracks)) {
    tracks[id] = {
      ...t,
      color: t.color ?? TRACK_COLORS[i % TRACK_COLORS.length]!,
      volume: t.volume ?? DEFAULT_VOLUME,
      pan: t.pan ?? 0,
      mute: t.mute ?? false,
      solo: t.solo ?? false,
    };
    for (const c of Object.values(t.clips ?? {})) maxEnd = Math.max(maxEnd, c.startTick + c.lengthTicks);
    i++;
  }
  // Older projects looped over their longest clip; keep that length so they play exactly as before.
  const songBars = raw.songBars ?? Math.min(MAX_SONG_BARS, Math.max(1, Math.ceil(maxEnd / TICKS_PER_BAR)));
  return { ...raw, tracks, masterVolume: raw.masterVolume ?? DEFAULT_VOLUME, songBars, key: raw.key ?? null };
}
