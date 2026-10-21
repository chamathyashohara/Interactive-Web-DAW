import { Biquad, Rng, SR, TAU, attack, decay, fadeIn, fadeOut, filter, hashSeed, mix, newBuf, noiseBuf, normalize, removeDc, reversed, reverb, samples, saturate } from "./dsp.ts";
import { crash } from "./drums.ts";

/** Transitions and effects: risers, impacts, sweeps, zaps. Mono, normalised to -1 dBFS (a little lower for noisy ambience). */

const finish = (b: Float32Array, fade = 10, peak = 0.891): Float32Array => {
  fadeIn(b, 0.3);
  fadeOut(b, fade);
  normalize(b, peak);
  return b;
};

/** Noise through a band-pass whose centre moves exponentially from `f0` to `f1`; amplitude follows `env(t/secs)`. */
function noiseSweep(seed: string, secs: number, f0: number, f1: number, q: number, env: (x: number) => number): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const n = samples(secs);
  const src = noiseBuf(secs, rng);
  const out = new Float32Array(n);
  const f = Biquad.bandpass(f0, q);
  for (let i = 0; i < n; i++) {
    if (i % 24 === 0) {
      const x = i / n;
      Object.assign(f, Biquad.bandpass(f0 * Math.pow(f1 / f0, x), q), { x1: f.x1, x2: f.x2, y1: f.y1, y2: f.y2 });
    }
    out[i] = f.process(src[i]!) * env(i / n);
  }
  return out;
}

export function riser(seed: string, secs: number): Float32Array {
  const noise = noiseSweep(seed, secs, 250, 9000, 1.6, (x) => 0.06 + 0.94 * x * x);
  const tone = new Float32Array(noise.length);
  let ph = 0;
  for (let i = 0; i < tone.length; i++) {
    const x = i / tone.length;
    ph += (180 * Math.pow(9, x)) / SR;
    tone[i] = Math.sin(TAU * ph) * (0.05 + 0.4 * x * x);
  }
  const out = mix([noise, 1], [tone, 0.5]);
  fadeIn(out, 20);
  return finish(out, 30);
}

export function downlifter(seed: string, secs: number): Float32Array {
  const noise = noiseSweep(seed, secs, 8000, 200, 1.4, (x) => Math.pow(1 - x, 1.4));
  fadeIn(noise, 3);
  return finish(noise, 40);
}

export function sweep(seed: string, secs: number, up: boolean): Float32Array {
  const out = noiseSweep(seed, secs, up ? 400 : 6000, up ? 6000 : 400, 2.4, (x) => Math.sin(Math.PI * x) ** 1.3);
  return finish(out, 20);
}

export function whoosh(seed: string): Float32Array {
  const out = noiseSweep(seed, 1.2, 300, 3500, 1.2, (x) => Math.sin(Math.PI * Math.min(1, x * 1.1)) ** 2);
  return finish(out, 40);
}

export function impact(seed: string): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const n = samples(2.4);
  const sub = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (28 + 80 * Math.exp(-t / 0.18)) / SR;
    sub[i] = Math.sin(TAU * ph) * decay(t, 0.9) * attack(t, 0.002);
  }
  const hit = filter(noiseBuf(1.2, rng), Biquad.lowpass(3000));
  for (let i = 0; i < hit.length; i++) hit[i]! *= decay(i / SR, 0.25) * attack(i / SR, 0.001);
  const body = reverb(mix([sub, 1], [hit, 0.8]), 1.6, 0.35);
  return finish(removeDc(saturate1(body, 1.4)), 80);
}

function saturate1(b: Float32Array, drive: number): Float32Array {
  for (let i = 0; i < b.length; i++) b[i] = saturate(b[i]!, drive);
  return b;
}

export function subDrop(seed: string): Float32Array {
  const n = samples(2.0);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (30 + 110 * Math.exp(-t / 0.55)) / SR;
    out[i] = saturate(Math.sin(TAU * ph) * decay(t, 0.9) * attack(t, 0.004), 1.8);
  }
  return finish(removeDc(out), 60);
}

export function reverseCrash(seed: string): Float32Array {
  const c = crash(seed, 0.8, 1.4, 3000);
  const r = reversed(c);
  fadeIn(r, 30);
  return finish(r, 4);
}

export function zap(seed: string, f0: number, f1: number, secs: number): Float32Array {
  const n = samples(secs);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (f1 + (f0 - f1) * Math.exp(-t / (secs / 4))) / SR;
    out[i] = Math.sin(TAU * ph) * decay(t, secs / 2.5) * attack(t, 0.001);
  }
  return finish(saturate1(out, 1.5), 10);
}

export function noiseHit(seed: string): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const n = samples(0.6);
  const out = filter(noiseBuf(0.6, rng), Biquad.highpass(1200));
  for (let i = 0; i < n; i++) out[i]! *= decay(i / SR, 0.12) * attack(i / SR, 0.0005);
  return finish(out, 12);
}

/** Sparse random clicks plus a faint hiss: old-record texture. Loopable length (4 s). */
export function vinylCrackle(seed: string): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const n = samples(4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) if (rng.next() < 22 / SR) out[i] = (rng.noise() > 0 ? 1 : -1) * (0.2 + 0.8 * rng.next());
  const clicks = filter(out, Biquad.highpass(900), Biquad.lowpass(9000));
  const hiss = filter(noiseBuf(4, rng), Biquad.highpass(3500), Biquad.lowpass(11000));
  const mixed = mix([clicks, 1], [hiss, 0.025]);
  normalize(mixed, 0.5);
  return mixed;
}
