import { SR } from "../src/dsp.ts";

/** Small analysis helpers for the sound tests (FFT, spectral centroid, pitch, decay time, loudness). */

export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a]! += tr;
        im[a]! += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Magnitude spectrum of `size` samples from `start` (Hann window, zero padded). */
export function spectrum(x: Float32Array, start = 0, size = 16384): { mag: Float64Array; binHz: number } {
  const re = new Float64Array(size), im = new Float64Array(size);
  const n = Math.min(size, Math.max(0, x.length - start));
  for (let i = 0; i < n; i++) re[i] = x[start + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1)));
  fft(re, im);
  const mag = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) mag[i] = Math.hypot(re[i]!, im[i]!);
  return { mag, binHz: SR / size };
}

export function centroid(x: Float32Array, start = 0, size = 16384): number {
  const { mag, binHz } = spectrum(x, start, size);
  let num = 0, den = 0;
  for (let i = 1; i < mag.length; i++) {
    num += i * binHz * mag[i]!;
    den += mag[i]!;
  }
  return den > 0 ? num / den : 0;
}

export const peakOf = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
export const rmsOf = (x: Float32Array, from = 0, to = x.length): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
};
export const meanOf = (x: Float32Array): number => x.reduce((s, v) => s + v, 0) / x.length;
export const dbOf = (v: number): number => 20 * Math.log10(Math.max(v, 1e-12));

/** Seconds until the short-term RMS envelope has fallen `db` below its maximum and stays there. */
export function decayTime(x: Float32Array, db = 50): number {
  const win = Math.round(0.005 * SR);
  const env: number[] = [];
  for (let i = 0; i + win <= x.length; i += win) env.push(rmsOf(x, i, i + win));
  const max = Math.max(...env);
  const floor = max * Math.pow(10, -db / 20);
  let last = 0;
  env.forEach((v, i) => {
    if (v > floor) last = i;
  });
  return ((last + 1) * win) / SR;
}

/** Frequency of the strongest spectral peak within [lo, hi] Hz, refined by parabolic interpolation. */
export function peakFrequency(x: Float32Array, lo: number, hi: number, start = 0, size = 32768): { hz: number; mag: number; globalMax: number } {
  const { mag, binHz } = spectrum(x, start, size);
  let best = Math.floor(lo / binHz), bestMag = 0;
  for (let i = Math.max(1, Math.floor(lo / binHz)); i <= Math.min(mag.length - 2, Math.ceil(hi / binHz)); i++) {
    if (mag[i]! > bestMag) {
      bestMag = mag[i]!;
      best = i;
    }
  }
  const a = mag[best - 1]!, b = mag[best]!, c = mag[best + 1]!;
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return { hz: (best + shift) * binHz, mag: bestMag, globalMax: Math.max(...mag) };
}

export const cents = (hz: number, ref: number): number => 1200 * Math.log2(hz / ref);
