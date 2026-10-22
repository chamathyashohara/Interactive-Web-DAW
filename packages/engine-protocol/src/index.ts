/**
 * Messages between the Electron main process and the audio engine.
 * Transport: newline-delimited JSON over the engine's stdin (commands) and stdout (events).
 * The engine writes logs to stderr only. The engine never needs a network message to render audio.
 */

export const ENGINE_MAX_SLOTS = 16;

export interface EngineNote {
  pitch: number;
  /** Absolute position on the timeline, in ticks (clip start + note start). */
  startTick: number;
  durationTicks: number;
  velocity: number;
  /** Sample tracks only (all optional; absent = as recorded). */
  /** Linear gain of the clip. */
  gain?: number;
  /** Seconds into the (already tempo-fitted) sound where playback starts. */
  offsetSec?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  /** The sound is cut at the note's end. */
  cut?: boolean;
}

export type EngineInstrument = "synth" | "drums" | "sample" | "plugin";

export interface EngineTrack {
  /** Stable engine voice slot (0..15) for this track; keeps voices/meters stable across edits. */
  slot: number;
  instrument: EngineInstrument;
  /** Final linear gain: fader curve x audibility (mute/solo already resolved). */
  gain: number;
  /** -1 (left) .. 1 (right) */
  pan: number;
  notes: EngineNote[];
  /** instrument "sample": absolute path of the audio file (omitted when the sound is not in this computer's library: the track is silent). */
  samplePath?: string;
  /** instrument "sample": a note-off cuts the sound (loops) instead of letting it play to its end. */
  gate?: boolean;
  /** instrument "sample": speed factor for time-stretching without changing pitch (project tempo / the sound's own tempo). Omitted = play as recorded. */
  stretchRatio?: number;
  /** instrument "plugin": absolute path of the .vst3 to load (omitted when none is chosen; the engine plays silence or, until the host is built, the built-in synth). */
  pluginPath?: string;
  /** instrument "plugin": base64 of the plugin's saved state, restored after loading. */
  pluginState?: string;
  /** Automation curves as [tick, value 0..1] pairs in time order (see Track.automation in the shared package). */
  automation?: { volume?: [number, number][]; filter?: [number, number][] };
}

/** Flattened, playable view of the project. Sent in full on (re)start and after each project change. */
export interface EngineProjectSnapshot {
  ppq: number;
  tempo: number;
  loopTicks: number;
  /** Playback repeats between these ticks (live playback only; export ignores it). Omitted or end <= start = the whole song. */
  loopStartTick?: number;
  loopEndTick?: number;
  masterGain: number;
  tracks: EngineTrack[];
}

export type EngineCommand =
  | { t: "hello" }
  | { t: "loadProject"; project: EngineProjectSnapshot }
  | { t: "play" }
  | { t: "stop" }
  | { t: "seek"; tick: number }
  | { t: "setTempo"; bpm: number }
  /** Click on every quarter note while playing (louder on the first beat of a bar). Not part of the project; never in the export. */
  | { t: "setMetronome"; on: boolean }
  | { t: "preview"; slot: number; pitch: number; velocity: number; on: boolean }
  /** Offline-render the current project to a 24-bit stereo 48 kHz WAV (song length + tail). Runs beside live playback. */
  | { t: "exportWav"; id: string; path: string; tailSeconds: number }
  /** Decode a sample file and report its length and waveform. Runs on a worker thread; answered by a `sampleInfo` event. */
  | { t: "analyzeSample"; id: string; path: string }
  /** Audition a sample from the browser (replaces the one playing). Not part of any track. */
  | { t: "previewSample"; path: string; gain: number }
  | { t: "stopPreview" };

export interface EngineStatus {
  t: "status";
  playing: boolean;
  tick: number;
  callbacks: number;
  /** Callbacks whose processing time exceeded the buffer duration. */
  overruns: number;
  /** Worst callback time as a fraction of buffer duration since start. */
  peakLoad: number;
  xruns: number;
  /** Peak level (linear, post-fader) since the previous status message. */
  masterL: number;
  masterR: number;
  /** How far through the browser preview is (0..1), or -1 when none is playing. */
  preview: number;
  slots: number[];
}

export interface EngineReady {
  t: "ready";
  device: string;
  deviceType: string;
  sampleRate: number;
  bufferSize: number;
  version: string;
}

export interface ExportProgress {
  t: "exportProgress";
  id: string;
  fraction: number;
}
export interface ExportDone {
  t: "exportDone";
  id: string;
  path: string;
  frames: number;
  sampleRate: number;
  seconds: number;
  peak: number;
}
export interface ExportError {
  t: "exportError";
  id: string;
  message: string;
}
export type ExportEvent = ExportProgress | ExportDone | ExportError;

export type SampleInfo =
  | { t: "sampleInfo"; id: string; ok: true; durationSec: number; sampleRate: number; channels: number; frames: number; peak: number; /** 96 values, 0..255 */ peaks: number[] }
  | { t: "sampleInfo"; id: string; ok: false; message: string };

export type EngineEvent = EngineReady | EngineStatus | ExportEvent | SampleInfo | { t: "error"; message: string };
