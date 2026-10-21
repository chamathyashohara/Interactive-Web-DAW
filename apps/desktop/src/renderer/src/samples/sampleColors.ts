import type { Category } from "@daw/sounds";

/** One colour per category, used for the browser's dots and (later) for the tracks and clips made from a sample. */
export const CATEGORY_COLORS: Record<Category, string> = {
  Kick: "#f97316",
  Snare: "#facc15",
  Clap: "#fb7185",
  Hat: "#a3e635",
  Cymbal: "#2dd4bf",
  Tom: "#fb923c",
  Percussion: "#f472b6",
  Bass: "#a78bfa",
  Keys: "#38bdf8",
  Pad: "#818cf8",
  Synth: "#22d3ee",
  FX: "#94a3b8",
  Loop: "#34d399",
  Other: "#64748b",
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Short tag shown next to a sample: "120 BPM", "Am", "F#", or "" when there is nothing to show. */
export function sampleTag(meta: { bpm?: number; key?: { tonic: number; mode: "major" | "minor" }; rootPc?: number }): string {
  if (meta.bpm) return `${meta.bpm} BPM`;
  if (meta.key) return `${NOTE_NAMES[meta.key.tonic]}${meta.key.mode === "minor" ? "m" : ""}`;
  if (meta.rootPc !== undefined) return NOTE_NAMES[meta.rootPc]!;
  return "";
}

export const formatDuration = (sec: number): string => (sec < 10 ? `${sec.toFixed(2)}s` : sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`);
