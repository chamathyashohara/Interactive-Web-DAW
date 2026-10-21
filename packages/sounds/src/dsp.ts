/**
 * Tiny deterministic DSP toolkit used to synthesise the DAW's own sound library.
 * Everything is a pure function of its inputs (no Math.random, no clocks), so the same code always renders the same bits.
 * Written without enums or parameter properties so Node can run it directly (--experimental-strip-types).
 */

export const SR = 48000;
export const TAU = Math.PI * 2;

/** xorshift32: fast, seedable, deterministic. */
export class Rng {
  s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  /** White noise in [-1, 1). */
  noise(): number {
    return this.next() * 2 - 1;
  }
}

/** Stable 32-bit hash of a string, for seeding per-sound noise. */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const samples = (seconds: number): number => Math.max(1, Math.round(seconds * SR));
export const newBuf = (seconds: number): Float32Array => new Float32Array(samples(seconds));
export const midiToHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** RBJ biquad filter (second order). */
export class Biquad {
  b0 = 0;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;

  set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): this {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }
  static lowpass(f: number, q = 0.707): Biquad {
    const w = (TAU * Math.min(f, SR * 0.45)) / SR, c = Math.cos(w), a = Math.sin(w) / (2 * q);
    return new Biquad().set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + a, -2 * c, 1 - a);
  }
  static highpass(f: number, q = 0.707): Biquad {
    const w = (TAU * Math.min(f, SR * 0.45)) / SR, c = Math.cos(w), a = Math.sin(w) / (2 * q);
    return new Biquad().set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + a, -2 * c, 1 - a);
  }
  static bandpass(f: number, q = 1): Biquad {
    const w = (TAU * Math.min(f, SR * 0.45)) / SR, c = Math.cos(w), a = Math.sin(w) / (2 * q);
    return new Biquad().set(a, 0, -a, 1 + a, -2 * c, 1 - a);
  }
  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Runs a buffer through a chain of filters (in place copy). */
export function filter(input: Float32Array, ...chain: Biquad[]): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let v = input[i]!;
    for (const f of chain) v = f.process(v);
    out[i] = v;
  }
  return out;
}

export function noiseBuf(seconds: number, rng: Rng): Float32Array {
  const b = newBuf(seconds);
  for (let i = 0; i < b.length; i++) b[i] = rng.noise();
  return b;
}

/** Exponential decay envelope value at time t (seconds) with time constant tau. */
export const decay = (t: number, tau: number): number => Math.exp(-t / tau);

/** Smooth tanh saturation, normalised so a full-scale input stays near full scale. */
export const saturate = (x: number, drive: number): number => (drive <= 0.001 ? x : Math.tanh(drive * x) / Math.tanh(drive));

export function applyGain(b: Float32Array, g: number): Float32Array {
  for (let i = 0; i < b.length; i++) b[i]! *= g;
  return b;
}

/** Scale so the loudest sample is `peak` (default -1 dBFS). */
export function normalize(b: Float32Array | Float32Array[], peak = 0.891): void {
  const list = Array.isArray(b) ? b : [b];
  let m = 0;
  for (const c of list) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]!));
  if (m < 1e-9) return;
  const g = peak / m;
  for (const c of list) for (let i = 0; i < c.length; i++) c[i]! *= g;
}

export function fadeOut(b: Float32Array, ms = 5): void {
  const n = Math.min(b.length, samples(ms / 1000));
  for (let i = 0; i < n; i++) b[b.length - 1 - i]! *= i / n;
}
export function fadeIn(b: Float32Array, ms = 1): void {
  const n = Math.min(b.length, samples(ms / 1000));
  for (let i = 0; i < n; i++) b[i]! *= i / n;
}

/** Adds `src` into `dst` starting at sample `offset`, scaled by `gain`. Anything past the end of `dst` is dropped. */
export function addInto(dst: Float32Array, src: Float32Array, offset = 0, gain = 1): void {
  for (let i = 0; i < src.length; i++) {
    const j = offset + i;
    if (j >= dst.length) break;
    if (j >= 0) dst[j]! += src[i]! * gain;
  }
}

export function reversed(b: Float32Array): Float32Array {
  return Float32Array.from(b).reverse();
}

/** Mixes equal-or-different-length buffers into a new one as long as the longest. */
export function mix(...parts: Array<[Float32Array, number] | Float32Array>): Float32Array {
  let len = 0;
  for (const p of parts) len = Math.max(len, (Array.isArray(p) ? p[0] : p).length);
  const out = new Float32Array(len);
  for (const p of parts) {
    const [b, g] = Array.isArray(p) ? p : [p, 1];
    addInto(out, b, 0, g);
  }
  return out;
}

/** Removes inaudible DC / sub-sonic offset. */
export function removeDc(b: Float32Array): Float32Array {
  return filter(b, Biquad.highpass(12, 0.707));
}

/** Schroeder reverb (4 combs + 2 all-passes). `rt60` seconds; `wet` 0..1. Output is extended by `rt60` so the tail is not cut. */
export function reverb(input: Float32Array, rt60: number, wet: number): Float32Array {
  const tail = Math.round(rt60 * SR);
  const len = input.length + tail;
  const x = new Float32Array(len);
  x.set(input);
  const combDelays = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => Math.round(d * SR));
  let acc = new Float32Array(len);
  for (const d of combDelays) {
    const g = Math.pow(10, (-3 * (d / SR)) / rt60);
    const line = new Float32Array(d);
    let p = 0;
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const delayed = line[p]!;
      lp = delayed * 0.7 + lp * 0.3; // damping: highs die faster, like a real room
      const y = x[i]! + g * lp;
      line[p] = y;
      p = (p + 1) % d;
      acc[i]! += delayed * 0.25;
    }
  }
  for (const [dly, g] of [[0.005, 0.7], [0.0017, 0.7]] as const) {
    const d = Math.round(dly * SR);
    const line = new Float32Array(d);
    let p = 0;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const delayed = line[p]!;
      const v = acc[i]! + g * delayed;
      out[i] = delayed - g * v;
      line[p] = v;
      p = (p + 1) % d;
    }
    acc = out;
  }
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = (i < input.length ? input[i]! * (1 - wet) : 0) + acc[i]! * wet * 1.6;
  return out;
}

/** Band-limited sawtooth sample for phase in [0,1) using PolyBLEP, so pitched sounds do not alias harshly. */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}
export const sawBL = (phase: number, dt: number): number => 2 * phase - 1 - polyBlep(phase, dt);
export const squareBL = (phase: number, dt: number): number => {
  const v = phase < 0.5 ? 1 : -1;
  return v + polyBlep(phase, dt) - polyBlep((phase + 0.5) % 1, dt);
};

/** Short linear attack to avoid a click at the very start. */
export const attack = (t: number, secs: number): number => (t >= secs ? 1 : t / secs);

/** Simple stereo widening: returns [left, right] from a mono signal using a short Haas delay and opposite tilt filters. */
export function widen(mono: Float32Array, ms = 11): Float32Array[] {
  const d = Math.round((ms / 1000) * SR);
  const left = new Float32Array(mono.length);
  const right = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    left[i] = mono[i]!;
    right[i] = i >= d ? mono[i - d]! : 0;
  }
  return [left, right];
}
