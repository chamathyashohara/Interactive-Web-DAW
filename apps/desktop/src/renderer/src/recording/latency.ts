/**
 * Round-trip latency of the singer's PC: the time from the moment the DAW hands a sample of the backing track to the sound card until the same sound
 * has come back through the microphone and the DAW has the sample. A vocal recorded over the backing track is this much later than the music it
 * answers, so the producer's DAW trims that much off the start of the recording.
 */

/** The first sample (index) whose size is clearly above the background, or -1. `floor` is the background level measured before the click. */
export function findOnset(samples: Float32Array, floor: number, minLevel = 0.04, factor = 6): number {
  const threshold = Math.max(minLevel, floor * factor);
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]!) >= threshold) return i;
  return -1;
}

/** The middle value of the measurements that agree with each other (within 3 ms of the median), or null when they do not agree. */
export function robustLatencyFrames(measures: number[], rate: number): number | null {
  if (measures.length < 3) return null;
  const sorted = [...measures].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const agree = sorted.filter((m) => Math.abs(m - median) <= 0.003 * rate);
  if (agree.length < Math.ceil(measures.length * 0.6)) return null;
  return Math.round(agree.reduce((a, b) => a + b, 0) / agree.length);
}

/** A short, sharp click (a decaying 2 kHz burst), loud enough to be heard by a microphone next to the speakers. */
export function clickBuffer(ctx: BaseAudioContext, ms = 6): AudioBuffer {
  const n = Math.round((ms / 1000) * ctx.sampleRate);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.sin((2 * Math.PI * 2000 * i) / ctx.sampleRate) * Math.exp((-4 * i) / n) * 0.9;
  return b;
}

export const LATENCY_KEY = "rr.latency";
export interface LatencySetting {
  /** "auto": what the browser reports; "measured": from the click test; "manual": typed in */
  source: "auto" | "measured" | "manual";
  /** measured or manual value in microseconds */
  us: number;
}
export function loadLatencySetting(): LatencySetting {
  try {
    const v = JSON.parse(localStorage.getItem(LATENCY_KEY) ?? "null") as LatencySetting | null;
    if (v && (v.source === "measured" || v.source === "manual") && Number.isFinite(v.us) && v.us >= 0 && v.us <= 2_000_000) return v;
  } catch { /* private window or blocked storage: use the estimate */ }
  return { source: "auto", us: 0 };
}
export function saveLatencySetting(s: LatencySetting): void {
  try { localStorage.setItem(LATENCY_KEY, JSON.stringify(s)); } catch { /* the setting just is not remembered */ }
}
