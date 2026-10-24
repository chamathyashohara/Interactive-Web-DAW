import {
  Biquad, Rng, SR, TAU, addInto, attack, decay, fadeIn, fadeOut, filter, hashSeed, mix, newBuf, noiseBuf, normalize, removeDc, reverb, samples, saturate, squareBL,
} from "./dsp.ts";

/** Synthesised drum sounds. Each function renders one mono one-shot, normalised to -1 dBFS, ending in a short fade so it never clicks. */

const finish = (b: Float32Array, fade = 6): Float32Array => {
  fadeIn(b, 0.3); // start from exactly zero so a hit never clicks
  fadeOut(b, fade);
  normalize(b);
  return b;
};

// ---------------------------------------------------------------- kick
export interface KickParams {
  /** Start and end pitch of the downward sweep (Hz). */
  f0: number;
  f1: number;
  /** Time constant of the sweep and of the amplitude decay (seconds). */
  sweep: number;
  tau: number;
  /** Saturation amount (harmonics) and the level of the beater click. */
  drive: number;
  click: number;
  /** Optional low-pass for a darker, "lo-fi" kick. */
  lp?: number;
}

export function kick(p: KickParams, seed: string): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const n = samples(Math.min(2.6, p.tau * 7 + 0.05));
  const body = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    phase += (p.f1 + (p.f0 - p.f1) * Math.exp(-t / p.sweep)) / SR;
    body[i] = Math.sin(TAU * phase) * attack(t, 0.0012) * decay(t, p.tau);
  }
  const click = filter(noiseBuf(0.02, rng), Biquad.highpass(1800));
  for (let i = 0; i < click.length; i++) click[i]! *= p.click * decay(i / SR, 0.0022) * 2.2;
  addInto(body, click);
  for (let i = 0; i < n; i++) body[i] = saturate(body[i]!, p.drive);
  const out = p.lp ? filter(body, Biquad.lowpass(p.lp)) : body;
  return finish(removeDc(out), 8);
}

export const KICKS: Array<{ name: string; sub: string; tags: string[]; p: KickParams }> = [
  { name: "Punch Kick", sub: "Kick", tags: ["punchy", "pop", "rock"], p: { f0: 160, f1: 52, sweep: 0.035, tau: 0.16, drive: 1.8, click: 0.35 } },
  { name: "Deep 808 Kick", sub: "Kick", tags: ["808", "hip hop", "trap"], p: { f0: 120, f1: 42, sweep: 0.05, tau: 0.55, drive: 2.2, click: 0.1 } },
  { name: "Long Boom Kick", sub: "Kick", tags: ["boom", "long", "trap"], p: { f0: 100, f1: 38, sweep: 0.06, tau: 0.9, drive: 1.6, click: 0.05 } },
  { name: "Tight Kick", sub: "Kick", tags: ["tight", "short", "edm"], p: { f0: 180, f1: 60, sweep: 0.02, tau: 0.09, drive: 2.5, click: 0.5 } },
  { name: "Soft Kick", sub: "Kick", tags: ["soft", "lo-fi", "chill"], p: { f0: 120, f1: 55, sweep: 0.04, tau: 0.18, drive: 1, click: 0.05 } },
  { name: "House Thump Kick", sub: "Kick", tags: ["house", "dance", "club"], p: { f0: 140, f1: 50, sweep: 0.03, tau: 0.25, drive: 2, click: 0.25 } },
  { name: "Rock Kick", sub: "Kick", tags: ["rock", "live", "dry"], p: { f0: 200, f1: 70, sweep: 0.02, tau: 0.12, drive: 1.2, click: 0.6 } },
  { name: "Trap Hard Kick", sub: "Kick", tags: ["trap", "hard", "808"], p: { f0: 150, f1: 45, sweep: 0.04, tau: 0.45, drive: 3.2, click: 0.2 } },
  { name: "Dusty Lo-fi Kick", sub: "Kick", tags: ["lo-fi", "dusty", "chill"], p: { f0: 110, f1: 50, sweep: 0.05, tau: 0.22, drive: 1.5, click: 0.08, lp: 2600 } },
  { name: "Sub Kick", sub: "Kick", tags: ["sub", "bass", "deep"], p: { f0: 80, f1: 40, sweep: 0.03, tau: 0.7, drive: 1, click: 0 } },
  { name: "Click Kick", sub: "Kick", tags: ["click", "techno", "tight"], p: { f0: 190, f1: 70, sweep: 0.015, tau: 0.07, drive: 2, click: 0.9 } },
  { name: "Distorted Kick", sub: "Kick", tags: ["distorted", "hard", "edm"], p: { f0: 150, f1: 48, sweep: 0.035, tau: 0.3, drive: 6, click: 0.3 } },
];

// ---------------------------------------------------------------- snare
export interface SnareParams {
  /** The two tones of the drum head (Hz). */
  f1: number;
  f2: number;
  bodyTau: number;
  noiseTau: number;
  /** Noise colour: high-pass, then band-pass centre and Q. */
  hp: number;
  bp: number;
  q: number;
  bodyMix: number;
  noiseMix: number;
  drive: number;
  verb?: { rt60: number; wet: number };
  lp?: number;
}

export function snare(p: SnareParams, seed: string): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const len = Math.max(p.bodyTau, p.noiseTau) * 7 + 0.03;
  const n = samples(len);
  const body = new Float32Array(n);
  let ph1 = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const bend = 1 + 0.35 * Math.exp(-t / 0.012);
    ph1 += (p.f1 * bend) / SR;
    ph2 += (p.f2 * bend) / SR;
    body[i] = (Math.sin(TAU * ph1) + 0.6 * Math.sin(TAU * ph2)) * attack(t, 0.0008) * decay(t, p.bodyTau);
  }
  const noise = filter(noiseBuf(len, rng), Biquad.highpass(p.hp), Biquad.bandpass(p.bp, p.q), Biquad.lowpass(p.bp * 2.2, 0.7));
  for (let i = 0; i < n; i++) noise[i]! *= attack(i / SR, 0.0004) * decay(i / SR, p.noiseTau) * 2.6;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = saturate(body[i]! * p.bodyMix + noise[i]! * p.noiseMix, p.drive);
  let out = p.lp ? filter(sig, Biquad.lowpass(p.lp)) : sig;
  if (p.verb) out = reverb(out, p.verb.rt60, p.verb.wet);
  return finish(removeDc(out), 10);
}

export const SNARES: Array<{ name: string; sub: string; tags: string[]; p: SnareParams }> = [
  { name: "Tight Snare", sub: "Snare", tags: ["tight", "pop", "edm"], p: { f1: 190, f2: 330, bodyTau: 0.06, noiseTau: 0.08, hp: 900, bp: 3500, q: 0.6, bodyMix: 0.7, noiseMix: 1, drive: 1.4 } },
  { name: "Fat Snare", sub: "Snare", tags: ["fat", "big", "hip hop"], p: { f1: 170, f2: 300, bodyTau: 0.1, noiseTau: 0.18, hp: 700, bp: 2800, q: 0.5, bodyMix: 1, noiseMix: 0.9, drive: 1.8 } },
  { name: "Crack Snare", sub: "Snare", tags: ["crack", "bright", "rock"], p: { f1: 200, f2: 360, bodyTau: 0.05, noiseTau: 0.14, hp: 1500, bp: 4500, q: 0.7, bodyMix: 0.6, noiseMix: 1.1, drive: 2 } },
  { name: "Boom Bap Snare", sub: "Snare", tags: ["boom bap", "hip hop", "90s"], p: { f1: 175, f2: 310, bodyTau: 0.09, noiseTau: 0.12, hp: 800, bp: 2400, q: 0.5, bodyMix: 1, noiseMix: 0.8, drive: 1.6, lp: 7500 } },
  { name: "Lo-fi Snare", sub: "Snare", tags: ["lo-fi", "dusty", "chill"], p: { f1: 165, f2: 290, bodyTau: 0.08, noiseTau: 0.11, hp: 600, bp: 2000, q: 0.5, bodyMix: 1, noiseMix: 0.7, drive: 1.2, lp: 4200 } },
  { name: "Trap Snare", sub: "Snare", tags: ["trap", "tight", "reverb"], p: { f1: 210, f2: 380, bodyTau: 0.045, noiseTau: 0.1, hp: 1100, bp: 4000, q: 0.6, bodyMix: 0.7, noiseMix: 1, drive: 2.2, verb: { rt60: 0.5, wet: 0.2 } } },
  { name: "Rock Snare", sub: "Snare", tags: ["rock", "live", "big"], p: { f1: 185, f2: 340, bodyTau: 0.12, noiseTau: 0.2, hp: 700, bp: 3000, q: 0.5, bodyMix: 1, noiseMix: 1, drive: 1.5, verb: { rt60: 0.35, wet: 0.12 } } },
  { name: "Big Room Snare", sub: "Snare", tags: ["big", "edm", "reverb"], p: { f1: 180, f2: 320, bodyTau: 0.09, noiseTau: 0.16, hp: 900, bp: 3200, q: 0.5, bodyMix: 0.9, noiseMix: 1, drive: 1.8, verb: { rt60: 0.9, wet: 0.3 } } },
  { name: "Snap Snare", sub: "Snare", tags: ["snap", "short", "pop"], p: { f1: 230, f2: 400, bodyTau: 0.03, noiseTau: 0.05, hp: 1600, bp: 5000, q: 0.8, bodyMix: 0.5, noiseMix: 1, drive: 1.5 } },
  { name: "Deep Snare", sub: "Snare", tags: ["deep", "low", "heavy"], p: { f1: 140, f2: 250, bodyTau: 0.14, noiseTau: 0.15, hp: 500, bp: 1800, q: 0.5, bodyMix: 1.2, noiseMix: 0.7, drive: 2 } },
];

// ---------------------------------------------------------------- clap
export interface ClapParams {
  bursts: number;
  /** Gap between the hand claps (ms). */
  gap: number;
  burstTau: number;
  tailTau: number;
  bp: number;
  q: number;
  verb?: { rt60: number; wet: number };
}

export function clap(p: ClapParams, seed: string): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const len = p.bursts * p.gap / 1000 + p.tailTau * 7 + 0.02;
  const n = samples(len);
  const noise = filter(noiseBuf(len, rng), Biquad.highpass(500), Biquad.bandpass(p.bp, p.q));
  const out = new Float32Array(n);
  const starts: number[] = [];
  for (let k = 0; k < p.bursts; k++) starts.push((k * p.gap + (k > 0 ? (rng.next() - 0.5) * 2 : 0)) / 1000);
  const lastStart = starts[starts.length - 1]!;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let env = 0;
    for (let k = 0; k < starts.length - 1; k++) if (t >= starts[k]!) env = Math.max(env, 0.85 * decay(t - starts[k]!, p.burstTau));
    if (t >= lastStart) env = Math.max(env, decay(t - lastStart, p.tailTau));
    out[i] = noise[i]! * env * attack(t, 0.0003);
  }
  const shaped = p.verb ? reverb(out, p.verb.rt60, p.verb.wet) : out;
  return finish(removeDc(shaped), 8);
}

export const CLAPS: Array<{ name: string; sub: string; tags: string[]; p: ClapParams }> = [
  { name: "Classic Clap", sub: "Clap", tags: ["classic", "808", "pop"], p: { bursts: 4, gap: 9, burstTau: 0.008, tailTau: 0.07, bp: 1250, q: 1.1 } },
  { name: "Tight Clap", sub: "Clap", tags: ["tight", "short", "trap"], p: { bursts: 3, gap: 7, burstTau: 0.006, tailTau: 0.04, bp: 1500, q: 1.3 } },
  { name: "Big Room Clap", sub: "Clap", tags: ["big", "edm", "reverb"], p: { bursts: 4, gap: 10, burstTau: 0.009, tailTau: 0.09, bp: 1150, q: 0.9, verb: { rt60: 1.0, wet: 0.3 } } },
  { name: "Retro Clap", sub: "Clap", tags: ["80s", "retro", "synthwave"], p: { bursts: 6, gap: 8, burstTau: 0.007, tailTau: 0.1, bp: 1000, q: 0.8 } },
  { name: "Snap Clap", sub: "Clap", tags: ["snappy", "bright", "pop"], p: { bursts: 2, gap: 6, burstTau: 0.005, tailTau: 0.03, bp: 1800, q: 1.5 } },
];

// ---------------------------------------------------------------- metal (hats and cymbals)
/** The six square-wave frequencies of the classic analog hi-hat circuit (Hz). */
const METAL = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];

function metalBuf(seconds: number, scale: number): Float32Array {
  const n = samples(seconds);
  const out = new Float32Array(n);
  for (const f of METAL) {
    const dt = (f * scale) / SR;
    let ph = (f * 0.137) % 1;
    for (let i = 0; i < n; i++) {
      out[i]! += squareBL(ph, Math.min(dt, 0.45)) / METAL.length;
      ph += dt;
      if (ph >= 1) ph -= 1;
    }
  }
  return out;
}

export interface HatParams {
  /** Pitch multiplier of the metal oscillators; higher = thinner and brighter. */
  scale: number;
  tau: number;
  hp: number;
  noiseMix: number;
  /** For open hats the length is set by tau; closed hats are short. */
  open?: boolean;
}

export function hat(p: HatParams, seed: string): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const len = p.open ? Math.min(2, p.tau * 6) : Math.min(0.4, p.tau * 7 + 0.02);
  const n = samples(len);
  const metal = metalBuf(len, p.scale);
  const noise = noiseBuf(len, rng);
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = metal[i]! * 1.2 + noise[i]! * p.noiseMix;
  const out = filter(sig, Biquad.highpass(p.hp, 0.9), Biquad.highpass(p.hp * 1.3, 0.7), Biquad.lowpass(11500, 0.7), Biquad.lowpass(14000, 0.5));
  for (let i = 0; i < n; i++) out[i]! *= attack(i / SR, 0.0005) * decay(i / SR, p.tau);
  return finish(out, p.open ? 25 : 5);
}

export const HATS: Array<{ name: string; sub: string; tags: string[]; p: HatParams }> = [
  { name: "Closed Hat Tight", sub: "Closed Hat", tags: ["closed", "tight", "trap"], p: { scale: 1.8, tau: 0.016, hp: 7000, noiseMix: 0.3 } },
  { name: "Closed Hat Classic", sub: "Closed Hat", tags: ["closed", "808", "classic"], p: { scale: 1.6, tau: 0.024, hp: 6500, noiseMix: 0.25 } },
  { name: "Closed Hat Soft", sub: "Closed Hat", tags: ["closed", "soft", "lo-fi"], p: { scale: 1.4, tau: 0.03, hp: 5000, noiseMix: 0.4 } },
  { name: "Closed Hat Bright", sub: "Closed Hat", tags: ["closed", "bright", "edm"], p: { scale: 2.1, tau: 0.02, hp: 8500, noiseMix: 0.2 } },
  { name: "Closed Hat Dirty", sub: "Closed Hat", tags: ["closed", "dirty", "hip hop"], p: { scale: 1.5, tau: 0.035, hp: 4500, noiseMix: 0.7 } },
  { name: "Closed Hat Short", sub: "Closed Hat", tags: ["closed", "short", "techno"], p: { scale: 1.9, tau: 0.011, hp: 7500, noiseMix: 0.25 } },
  { name: "Pedal Hat", sub: "Closed Hat", tags: ["pedal", "live"], p: { scale: 1.5, tau: 0.05, hp: 5500, noiseMix: 0.35 } },
  { name: "Closed Hat Pop", sub: "Closed Hat", tags: ["closed", "pop"], p: { scale: 1.7, tau: 0.02, hp: 6000, noiseMix: 0.3 } },
  { name: "Open Hat Classic", sub: "Open Hat", tags: ["open", "808", "classic"], p: { scale: 1.6, tau: 0.22, hp: 6500, noiseMix: 0.25, open: true } },
  { name: "Open Hat Short", sub: "Open Hat", tags: ["open", "short", "trap"], p: { scale: 1.8, tau: 0.12, hp: 7000, noiseMix: 0.3, open: true } },
  { name: "Open Hat Long", sub: "Open Hat", tags: ["open", "long", "house"], p: { scale: 1.7, tau: 0.38, hp: 6500, noiseMix: 0.25, open: true } },
  { name: "Open Hat Soft", sub: "Open Hat", tags: ["open", "soft", "lo-fi"], p: { scale: 1.4, tau: 0.2, hp: 5000, noiseMix: 0.45, open: true } },
  { name: "Open Hat Bright", sub: "Open Hat", tags: ["open", "bright", "edm"], p: { scale: 2.1, tau: 0.26, hp: 8000, noiseMix: 0.2, open: true } },
];

// ---------------------------------------------------------------- cymbals
export function crash(seed: string, tau: number, scale: number, hp: number): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const len = Math.min(3.6, tau * 5.5);
  const n = samples(len);
  const metal = metalBuf(len, scale);
  const noise = noiseBuf(len, rng);
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = metal[i]! * 0.9 + noise[i]! * 0.7;
  const out = filter(sig, Biquad.highpass(hp), Biquad.highpass(hp * 1.2, 0.6));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i]! *= attack(t, 0.004) * (0.65 * decay(t, tau) + 0.35 * decay(t, tau * 0.3));
  }
  return finish(out, 60);
}

export function ride(seed: string, scale: number, ping: number, bell: boolean): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const len = bell ? 1.6 : 1.8;
  const n = samples(len);
  const metal = metalBuf(len, scale);
  const noise = noiseBuf(len, rng);
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = metal[i]! * 0.8 + noise[i]! * 0.15;
  const out = filter(sig, Biquad.highpass(3500, 0.8));
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const ringTone = Math.sin(TAU * ping * t) * 0.6 + Math.sin(TAU * ping * 1.58 * t) * 0.35 + (bell ? Math.sin(TAU * ping * 0.5 * t) * 0.7 : 0);
    tone[i] = ringTone * decay(t, bell ? 0.6 : 0.2);
    out[i]! *= attack(t, 0.0015) * (bell ? decay(t, 0.4) : 0.8 * decay(t, 0.55) + 0.2 * decay(t, 0.12));
  }
  return finish(mix(out, [tone, 0.5]), 40);
}

export function shaker(seed: string, bp: number, swell: number, tau: number): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const len = swell + tau * 6 + 0.02;
  const n = samples(len);
  const out = filter(noiseBuf(len, rng), Biquad.bandpass(bp, 0.8), Biquad.highpass(3000));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i]! *= (t < swell ? t / swell : decay(t - swell, tau));
  }
  return finish(out, 10);
}

export function tambourine(seed: string, tau: number): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const len = tau * 7 + 0.02;
  const n = samples(len);
  const jingle = metalBuf(len, 4.2);
  const noise = noiseBuf(len, rng);
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = jingle[i]! + noise[i]! * 0.5;
  const out = filter(sig, Biquad.highpass(5500));
  for (let i = 0; i < n; i++) out[i]! *= attack(i / SR, 0.0015) * decay(i / SR, tau);
  return finish(out, 12);
}

// ---------------------------------------------------------------- toms
export function tom(seed: string, f0: number, tau: number): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const n = samples(tau * 7 + 0.05);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (f0 * (1 + 0.55 * Math.exp(-t / 0.035))) / SR;
    out[i] = Math.sin(TAU * ph) * attack(t, 0.001) * decay(t, tau);
  }
  const click = filter(noiseBuf(0.015, rng), Biquad.bandpass(2200, 0.7));
  for (let i = 0; i < click.length; i++) click[i]! *= 0.5 * decay(i / SR, 0.003);
  addInto(out, click);
  for (let i = 0; i < n; i++) out[i] = saturate(out[i]!, 1.3);
  return finish(removeDc(out), 10);
}

// ---------------------------------------------------------------- percussion
export function rimshot(seed: string, f: number): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const n = samples(0.14);
  const noise = filter(noiseBuf(0.14, rng), Biquad.bandpass(2600, 1));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = (Math.sin(TAU * f * t) * 0.7 + Math.sin(TAU * f * 3.4 * t) * 0.5) * decay(t, 0.012) + noise[i]! * decay(t, 0.008) * 0.9;
  }
  return finish(out, 4);
}

export function cowbell(seed: string, scale: number): Float32Array {
  const n = samples(0.5);
  const out = new Float32Array(n);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    p1 = (p1 + (540 * scale) / SR) % 1;
    p2 = (p2 + (800 * scale) / SR) % 1;
    out[i] = (squareBL(p1, (540 * scale) / SR) + squareBL(p2, (800 * scale) / SR)) * (0.6 * decay(t, 0.2) + 0.4 * decay(t, 0.015)) * attack(t, 0.0005);
  }
  return finish(filter(out, Biquad.bandpass(780 * scale, 1.8)), 20);
}

export function clave(seed: string, f: number): Float32Array {
  const n = samples(0.18);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(TAU * f * (i / SR)) * decay(i / SR, 0.03) * attack(i / SR, 0.0003);
  return finish(out, 6);
}

export function woodblock(seed: string, f: number): Float32Array {
  const n = samples(0.25);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = (Math.sin(TAU * f * t) + 0.5 * Math.sin(TAU * f * 1.51 * t)) * decay(t, 0.045) * attack(t, 0.0004);
  }
  return finish(filter(out, Biquad.bandpass(f * 1.1, 1.5)), 8);
}

export function conga(seed: string, f0: number, tau: number, slap: boolean): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const n = samples(tau * 7 + 0.05);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (f0 * (1 + 0.18 * Math.exp(-t / 0.02))) / SR;
    out[i] = Math.sin(TAU * ph) * decay(t, tau) * attack(t, 0.0008);
  }
  const hit = filter(noiseBuf(0.02, rng), Biquad.bandpass(slap ? 3200 : 1800, 1));
  for (let i = 0; i < hit.length; i++) hit[i]! *= (slap ? 1.1 : 0.5) * decay(i / SR, 0.004);
  addInto(out, hit);
  return finish(removeDc(out), 10);
}

export function snap(seed: string, bright: number): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const n = samples(0.18);
  const sig = filter(noiseBuf(0.18, rng), Biquad.bandpass(bright, 2.2), Biquad.highpass(1200));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    sig[i] = sig[i]! * (decay(t, 0.012) * 0.8 + decay(t, 0.05) * 0.2) * attack(t, 0.0002) + Math.sin(TAU * 1100 * t) * decay(t, 0.006) * 0.4;
  }
  return finish(sig, 6);
}

export function triangle(seed: string): Float32Array {
  const n = samples(1.6);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = (Math.sin(TAU * 4400 * t) + 0.7 * Math.sin(TAU * 6150 * t) + 0.4 * Math.sin(TAU * 8300 * t)) * decay(t, 0.45) * attack(t, 0.0003);
  }
  return finish(out, 40);
}

export function stickClick(seed: string): Float32Array {
  const rng = new Rng(hashSeed(seed));
  const n = samples(0.08);
  const noise = filter(noiseBuf(0.08, rng), Biquad.highpass(2500));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    noise[i] = noise[i]! * decay(t, 0.004) + Math.sin(TAU * 950 * t) * decay(t, 0.008) * 0.6;
  }
  return finish(noise, 4);
}
