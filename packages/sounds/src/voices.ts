import {
  Biquad, Rng, SR, TAU, attack, decay, filter, hashSeed, midiToHz, noiseBuf, removeDc, samples, saturate, sawBL, squareBL,
} from "./dsp.ts";

/**
 * Pitched instruments. Every voice renders ONE note: `voice(freqHz, seconds, seed)` returns a mono buffer of
 * `seconds` plus its natural release tail, at a moderate level (peak about 0.4) so notes can be mixed into chords and loops.
 * The same functions make the single "Starter" samples and the chords/basslines inside the loops, so they always agree.
 */
export type Voice = (freq: number, seconds: number, seed: string) => Float32Array;

/** Gain over time for a held note: short attack, flat while held, then an exponential-ish release. */
const held = (t: number, secs: number, a: number, rel: number): number => {
  const up = attack(t, a);
  if (t <= secs) return up;
  return up * Math.max(0, 1 - (t - secs) / rel) ** 2;
};

const length = (secs: number, rel: number): number => samples(secs + rel);

// ------------------------------------------------------------------ bass
export const sub808: Voice = (freq, secs) => {
  const n = length(secs, 0.05);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (freq * (1 + 0.9 * Math.exp(-t / 0.03))) / SR;
    out[i] = saturate(Math.sin(TAU * ph) * attack(t, 0.002) * decay(t, Math.max(0.25, secs * 0.45)) * held(t, secs, 0.001, 0.05), 1.6) * 0.8;
  }
  return removeDc(out);
};

export const synthBass: Voice = (freq, secs) => {
  const n = length(secs, 0.08);
  const saw = new Float32Array(n);
  const dt = freq / SR;
  let ph = 0, sph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    saw[i] = (sawBL(ph, dt) * 0.7 + Math.sin(TAU * sph) * 0.5) * held(t, secs, 0.003, 0.08);
    ph = (ph + dt) % 1;
    sph += freq / SR; // the sub sine is in unison with the note (an octave below would be inaudible on small speakers)
  }
  // low-pass whose cutoff drops quickly after the note starts: the classic "wow" of a synth bass
  const out = new Float32Array(n);
  const f = Biquad.lowpass(1800, 1.8);
  for (let i = 0; i < n; i++) {
    if (i % 32 === 0) {
      const cut = 250 + 1700 * Math.exp(-(i / SR) / 0.14);
      Object.assign(f, Biquad.lowpass(cut, 1.8), { x1: f.x1, x2: f.x2, y1: f.y1, y2: f.y2 });
    }
    out[i] = f.process(saw[i]!) * 0.6;
  }
  return out;
};

export const reese: Voice = (freq, secs) => {
  const n = length(secs, 0.15);
  const out = new Float32Array(n);
  const cents = [-14, -5, 5, 14];
  for (const c of cents) {
    const dt = (freq * Math.pow(2, c / 1200)) / SR;
    let ph = (c + 20) / 60;
    for (let i = 0; i < n; i++) {
      out[i]! += sawBL(ph % 1, dt) * 0.18 * held(i / SR, secs, 0.01, 0.15);
      ph += dt;
    }
  }
  return filter(out, Biquad.lowpass(700, 1.1));
};

/** Karplus-Strong plucked string with a fractional delay so it is in tune. */
export function karplus(freq: number, secs: number, seed: string, damping: number, brightness: number): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const n = samples(secs);
  const d = SR / freq - 0.5;
  let L = Math.floor(d);
  let frac = d - L;
  if (frac < 0.1) {
    L -= 1;
    frac += 1;
  }
  L = Math.max(2, L);
  const a = (1 - frac) / (1 + frac);
  const line = new Float32Array(L);
  let lp = 0;
  for (let i = 0; i < L; i++) {
    const w = rng.noise();
    lp = lp * (1 - brightness) + w * brightness; // excitation colour: less bright = softer pluck
    line[i] = lp;
  }
  let mean = 0;
  for (let i = 0; i < L; i++) mean += line[i]!;
  mean /= L;
  for (let i = 0; i < L; i++) line[i]! -= mean; // a string excited with a zero-mean burst has no DC offset
  const out = new Float32Array(n);
  let p = 0, prev = 0, x1 = 0, y1 = 0;
  for (let i = 0; i < n; i++) {
    const outSample = line[p]!;
    const avg = 0.5 * (outSample + prev) * damping;
    prev = outSample;
    const ap = a * avg + x1 - a * y1;
    x1 = avg;
    y1 = ap;
    line[p] = ap;
    p = (p + 1) % L;
    out[i] = outSample;
  }
  return out;
}

export const pluckBass: Voice = (freq, secs, seed) => {
  const out = karplus(freq, secs + 0.1, seed, 0.9965, 0.35);
  for (let i = 0; i < out.length; i++) out[i]! *= 0.9 * held(i / SR, secs, 0.001, 0.1);
  return filter(out, Biquad.lowpass(1400, 0.8));
};

// ------------------------------------------------------------------ keys
export const electricPiano: Voice = (freq, secs) => {
  const n = length(secs, 0.4);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += freq / SR;
    const index = 1.1 + 2.4 * Math.exp(-t / 0.45);
    const tine = Math.sin(TAU * ph * 14) * decay(t, 0.035) * 0.1;
    const body = Math.sin(TAU * ph + index * Math.sin(TAU * ph)) * decay(t, 1.3);
    out[i] = (body * 0.5 + tine) * attack(t, 0.002) * held(t, secs, 0.001, 0.4);
  }
  return out;
};

export const piano: Voice = (freq, secs, seed) => {
  const rng = new Rng(hashSeed(seed));
  const n = length(secs, 0.5);
  const out = new Float32Array(n);
  const partials = 10;
  for (let k = 1; k <= partials; k++) {
    const f = freq * k * Math.sqrt(1 + 0.00025 * k * k); // slight string stiffness
    if (f > SR * 0.45) break;
    const amp = 0.55 / Math.pow(k, 1.15);
    const tau = 1.8 / (1 + 0.45 * (k - 1));
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += f / SR;
      out[i]! += Math.sin(TAU * ph) * amp * decay(t, tau) * attack(t, 0.002) * held(t, secs, 0.001, 0.5);
    }
  }
  const thump = filter(noiseBuf(0.03, rng), Biquad.lowpass(1800));
  for (let i = 0; i < thump.length; i++) out[i]! += thump[i]! * 0.15 * decay(i / SR, 0.006);
  return out;
};

export const organ: Voice = (freq, secs) => {
  const n = length(secs, 0.06);
  const out = new Float32Array(n);
  const bars: Array<[number, number]> = [[0.5, 0.5], [1, 0.9], [2, 0.7], [3, 0.5], [4, 0.45], [6, 0.25], [8, 0.2]];
  for (const [ratio, level] of bars) {
    const f = freq * ratio;
    if (f > SR * 0.45) continue;
    let ph = 0;
    for (let i = 0; i < n; i++) {
      ph += f / SR;
      out[i]! += Math.sin(TAU * ph) * level * 0.14 * held(i / SR, secs, 0.008, 0.06);
    }
  }
  return out;
};

export const bell: Voice = (freq, secs) => {
  const n = length(secs, 0.6);
  const out = new Float32Array(n);
  let ph = 0, mph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += freq / SR;
    mph += (freq * 3.5) / SR;
    const idx = 3.2 * Math.exp(-t / 0.7);
    out[i] = Math.sin(TAU * ph + idx * Math.sin(TAU * mph)) * decay(t, 1.6) * 0.5 * attack(t, 0.001) * held(t, secs, 0.001, 0.6);
  }
  return out;
};

export const marimba: Voice = (freq, secs) => {
  const n = length(secs, 0.3);
  const out = new Float32Array(n);
  const parts: Array<[number, number, number]> = [[1, 1, 0.45], [3.93, 0.35, 0.1], [9.9, 0.12, 0.04]];
  for (const [ratio, amp, tau] of parts) {
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (freq * ratio) / SR;
      out[i]! += Math.sin(TAU * ph) * amp * decay(t, tau) * 0.6 * attack(t, 0.001) * held(t, secs, 0.001, 0.3);
    }
  }
  return out;
};

export const guitar: Voice = (freq, secs, seed) => {
  const out = karplus(freq, secs + 0.3, seed, 0.9975, 0.55);
  for (let i = 0; i < out.length; i++) out[i]! *= 0.85 * held(i / SR, secs + 0.1, 0.001, 0.25);
  return filter(out, Biquad.lowpass(3500, 0.7));
};

export const harp: Voice = (freq, secs, seed) => {
  const out = karplus(freq, secs + 0.5, seed, 0.9985, 0.8);
  for (let i = 0; i < out.length; i++) out[i]! *= 0.8 * held(i / SR, secs + 0.3, 0.001, 0.4);
  return out;
};

// ------------------------------------------------------------------ pads and strings
function detunedSaws(freq: number, n: number, cents: number[], level: number, vibratoCents: number): Float32Array {
  const out = new Float32Array(n);
  cents.forEach((c, k) => {
    let ph = ((k + 1) * 0.173) % 1;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const vib = vibratoCents ? vibratoCents * Math.sin(TAU * 5.1 * t + k) * Math.min(1, t / 0.6) : 0;
      const dt = (freq * Math.pow(2, (c + vib) / 1200)) / SR;
      out[i]! += sawBL(ph, dt) * level;
      ph += dt;
      if (ph >= 1) ph -= 1;
    }
  });
  return out;
}

export const padWarm: Voice = (freq, secs) => {
  const n = length(secs, 1.2);
  const raw = detunedSaws(freq, n, [-12, -5, 0, 6, 13], 0.13, 0);
  const out = filter(raw, Biquad.lowpass(Math.min(1400 + freq * 1.5, 4000), 0.6));
  for (let i = 0; i < n; i++) out[i]! *= held(i / SR, secs, 0.7, 1.2);
  return out;
};

export const padGlass: Voice = (freq, secs) => {
  const n = length(secs, 1.4);
  const out = new Float32Array(n);
  const stack: Array<[number, number]> = [[1, 0.5], [2, 0.3], [3, 0.2], [4.01, 0.14], [5.98, 0.08]];
  for (const [ratio, amp] of stack) {
    const f = freq * ratio;
    if (f > SR * 0.45) continue;
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (f * (1 + 0.0015 * Math.sin(TAU * 0.4 * t))) / SR;
      out[i]! += Math.sin(TAU * ph) * amp * 0.4 * held(t, secs, 0.9, 1.4);
    }
  }
  return out;
};

export const strings: Voice = (freq, secs) => {
  const n = length(secs, 0.9);
  const raw = detunedSaws(freq, n, [-14, -7, 0, 7, 14, 21], 0.1, 4);
  const out = filter(raw, Biquad.lowpass(Math.min(2600 + freq, 6000), 0.5));
  for (let i = 0; i < n; i++) out[i]! *= held(i / SR, secs, 0.35, 0.9);
  return out;
};

export const choir: Voice = (freq, secs) => {
  const n = length(secs, 0.8);
  const raw = detunedSaws(freq, n, [-8, 0, 8], 0.2, 5);
  // formants of an open "Ah" vowel
  const a = filter(raw, Biquad.bandpass(800, 6)), b = filter(raw, Biquad.bandpass(1150, 7)), c = filter(raw, Biquad.bandpass(2900, 8));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (a[i]! * 1 + b[i]! * 0.7 + c[i]! * 0.35) * 2.2 * held(i / SR, secs, 0.3, 0.8);
  return out;
};

// ------------------------------------------------------------------ leads and brass
export const brass: Voice = (freq, secs) => {
  const n = length(secs, 0.1);
  const raw = detunedSaws(freq, n, [-6, 0, 6], 0.2, 0);
  const out = new Float32Array(n);
  const f = Biquad.lowpass(500, 0.9);
  for (let i = 0; i < n; i++) {
    if (i % 32 === 0) {
      const cut = 500 + 3000 * (1 - Math.exp(-(i / SR) / 0.07));
      Object.assign(f, Biquad.lowpass(cut, 0.9), { x1: f.x1, x2: f.x2, y1: f.y1, y2: f.y2 });
    }
    out[i] = f.process(raw[i]!) * held(i / SR, secs, 0.025, 0.1);
  }
  return out;
};

export const leadSaw: Voice = (freq, secs) => {
  const n = length(secs, 0.15);
  const raw = detunedSaws(freq, n, [-9, 0, 9], 0.2, 6);
  const out = filter(raw, Biquad.lowpass(Math.min(5200, freq * 8 + 1500), 0.9));
  for (let i = 0; i < n; i++) out[i]! *= held(i / SR, secs, 0.01, 0.15);
  return out;
};

export const leadSquare: Voice = (freq, secs) => {
  const n = length(secs, 0.12);
  const out = new Float32Array(n);
  const dt = freq / SR;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = squareBL(ph, dt) * 0.35 * held(t, secs, 0.006, 0.12);
    ph = (ph + dt * (1 + 0.003 * Math.sin(TAU * 5.4 * t))) % 1;
  }
  return filter(out, Biquad.lowpass(Math.min(4200, freq * 6 + 1200), 0.8));
};

export const leadPluck: Voice = (freq, secs) => {
  const n = length(Math.min(secs, 0.5), 0.2);
  const raw = detunedSaws(freq, n, [-7, 0, 7], 0.22, 0);
  const out = new Float32Array(n);
  const f = Biquad.lowpass(4000, 1.2);
  for (let i = 0; i < n; i++) {
    if (i % 32 === 0) {
      const cut = 400 + 5000 * Math.exp(-(i / SR) / 0.09);
      Object.assign(f, Biquad.lowpass(cut, 1.2), { x1: f.x1, x2: f.x2, y1: f.y1, y2: f.y2 });
    }
    out[i] = f.process(raw[i]!) * decay(i / SR, 0.18) * attack(i / SR, 0.002);
  }
  return out;
};

export const arpPluck: Voice = (freq, secs) => {
  const n = length(Math.min(secs, 0.3), 0.15);
  const out = new Float32Array(n);
  const dt = freq / SR;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = squareBL(ph, dt) * 0.3 * decay(t, 0.1) * attack(t, 0.001);
    ph = (ph + dt) % 1;
  }
  return filter(out, Biquad.lowpass(Math.min(6000, freq * 7 + 800), 0.9));
};

// ------------------------------------------------------------------ registry
export const VOICES = {
  sub808, synthBass, reese, pluckBass, electricPiano, piano, organ, bell, marimba, guitar, harp, padWarm, padGlass, strings, choir, brass, leadSaw, leadSquare, leadPluck, arpPluck,
} as const;
export type VoiceName = keyof typeof VOICES;

/** MIDI note -> Hz convenience for generators. */
export const note = (midi: number): number => midiToHz(midi);
