import { BEATS_PER_BAR, MAX_BPM, MIN_BPM, PPQ } from "./model";

export interface BarBeat {
  /** 1-based, like the ruler. */
  bar: number;
  beat: number;
  /** Which sixteenth inside the beat, 1-4. */
  sixteenth: number;
}

/** Where a tick is in the song, as bar, beat and sixteenth (all starting at 1). */
export function barBeat(tick: number, ppq: number = PPQ): BarBeat {
  const t = Math.max(0, Math.floor(tick));
  const bar = Math.floor(t / (ppq * BEATS_PER_BAR));
  const inBar = t - bar * ppq * BEATS_PER_BAR;
  const beat = Math.floor(inBar / ppq);
  const sixteenth = Math.floor((inBar - beat * ppq) / (ppq / 4));
  return { bar: bar + 1, beat: beat + 1, sixteenth: sixteenth + 1 };
}

/** "003 . 2 . 4": the readout shown in the toolbar. */
export function formatBarBeat(tick: number, ppq: number = PPQ): string {
  const { bar, beat, sixteenth } = barBeat(tick, ppq);
  return `${String(bar).padStart(3, "0")}.${beat}.${sixteenth}`;
}

/** A pause longer than this starts a new set of taps. */
export const TAP_RESET_MS = 2000;
const TAP_WINDOW = 8;

/**
 * Tap tempo: the BPM given the times (ms) of the most recent taps, oldest first, or null with fewer than two taps.
 * Only the taps since the last long pause count, and only the last few, so the number settles quickly and follows changes.
 */
export function tapTempo(times: number[]): number | null {
  let from = times.length - 1;
  while (from > 0 && times[from]! - times[from - 1]! <= TAP_RESET_MS) from--;
  const taps = times.slice(Math.max(from, times.length - TAP_WINDOW));
  if (taps.length < 2) return null;
  const avg = (taps[taps.length - 1]! - taps[0]!) / (taps.length - 1);
  if (avg <= 0) return null;
  const bpm = Math.round((60000 / avg) * 10) / 10;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}
