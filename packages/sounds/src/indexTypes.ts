import type { Category, SampleMeta } from "./library.ts";

/** One entry of the library's index.json: everything the browser needs without opening the audio file. */
export interface IndexEntry {
  id: string;
  name: string;
  category: Category;
  sub: string;
  pack: string;
  tags: string[];
  meta: SampleMeta;
  /** Path relative to the library folder, with forward slashes. */
  file: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  /** 96 loudness buckets 0-255 for the little waveform picture. */
  peaks: number[];
  origin: "starter" | "imported";
}

export interface LibraryIndex {
  version: number;
  entries: IndexEntry[];
}

export const PEAK_BUCKETS = 96;

export function computePeaks(channels: Float32Array[], buckets = PEAK_BUCKETS): number[] {
  const n = channels[0]!.length;
  const out: number[] = [];
  let global = 0;
  const raw: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * n) / buckets), to = Math.max(from + 1, Math.floor(((b + 1) * n) / buckets));
    let m = 0;
    for (const c of channels) for (let i = from; i < to && i < n; i++) m = Math.max(m, Math.abs(c[i]!));
    raw.push(m);
    global = Math.max(global, m);
  }
  for (const m of raw) out.push(global > 0 ? Math.round((m / global) * 255) : 0);
  return out;
}

