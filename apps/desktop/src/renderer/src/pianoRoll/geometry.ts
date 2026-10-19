import { PPQ } from "@daw/shared";

export const PITCH_MIN = 36; // C2
export const PITCH_MAX = 83; // B5
export const DEFAULT_ROW_H = 18;
export const MIN_ROW_H = 12;
export const MAX_ROW_H = 32;
export const KEYS_W = 76;

export const GRID_OPTIONS = [
  { label: "1/4", ticks: PPQ },
  { label: "1/8", ticks: PPQ / 2 },
  { label: "1/16", ticks: PPQ / 4 },
  { label: "1/32", ticks: PPQ / 8 },
] as const;

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const isBlackKey = (pitch: number) => NOTE_NAMES[pitch % 12]!.includes("#");
export const pitchLabel = (pitch: number) => `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;

export const DRUM_NAMES: Record<number, string> = {
  35: "Kick 2",
  36: "Kick",
  37: "Rim",
  38: "Snare",
  39: "Clap",
  40: "Snare 2",
  41: "Low Tom",
  42: "Closed Hat",
  43: "Tom",
  44: "Pedal Hat",
  45: "Mid Tom",
  46: "Open Hat",
  47: "Hi Tom",
};

/** Horizontal zoom is expressed in pixels per beat. Stored note positions never depend on it. */
export const tickToPx = (tick: number, pxPerBeat: number) => (tick / PPQ) * pxPerBeat;
export const pxToTick = (px: number, pxPerBeat: number) => (px / pxPerBeat) * PPQ;

export function snapTick(tick: number, gridTicks: number, enabled: boolean, mode: "floor" | "round" = "round"): number {
  const t = Math.max(0, tick);
  if (!enabled) return Math.round(t);
  const q = t / gridTicks;
  return (mode === "floor" ? Math.floor(q) : Math.round(q)) * gridTicks;
}

export const pitchToY = (pitch: number, rowH: number = DEFAULT_ROW_H) => (PITCH_MAX - pitch) * rowH;
export const yToPitch = (y: number, rowH: number = DEFAULT_ROW_H) => Math.min(PITCH_MAX, Math.max(PITCH_MIN, PITCH_MAX - Math.floor(y / rowH)));
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
