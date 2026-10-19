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
}

export type EngineInstrument = "synth" | "drums";

export interface EngineTrack {
  /** Stable engine voice slot (0..15) for this track; keeps voices/meters stable across edits. */
  slot: number;
  instrument: EngineInstrument;
  /** Final linear gain: fader curve x audibility (mute/solo already resolved). */
  gain: number;
  /** -1 (left) .. 1 (right) */
  pan: number;
  notes: EngineNote[];
}

/** Flattened, playable view of the project. Sent in full on (re)start and after each project change. */
export interface EngineProjectSnapshot {
  ppq: number;
  tempo: number;
  loopTicks: number;
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
  | { t: "preview"; slot: number; pitch: number; velocity: number; on: boolean }
  /** Offline-render the current project to a 24-bit stereo 48 kHz WAV (song length + tail). Runs beside live playback. */
  | { t: "exportWav"; id: string; path: string; tailSeconds: number };

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

export type EngineEvent = EngineReady | EngineStatus | ExportEvent | { t: "error"; message: string };
