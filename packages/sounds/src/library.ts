import { fadeIn, fadeOut, midiToHz, normalize, widen } from "./dsp.ts";
import {
  CLAPS, HATS, KICKS, SNARES, clap, clave, conga, cowbell, crash, hat, kick, ride, rimshot, shaker, snap, snare, stickClick, tambourine, tom, triangle, woodblock,
} from "./drums.ts";
import { downlifter, impact, noiseHit, reverseCrash, riser, subDrop, sweep, vinylCrackle, whoosh, zap } from "./fx.ts";
import { BASS_LOOPS, CHORD_LOOPS, DRUM_LOOPS, renderBassLoop, renderChordLoop, renderDrumLoop } from "./loops.ts";
import { VOICES, type VoiceName } from "./voices.ts";

/** Bump when any sound changes, so installed copies of the library are regenerated. */
export const STARTER_VERSION = 1;
export const STARTER_PACKS = ["Starter Drums", "Starter Bass", "Starter Keys and Synths", "Starter FX", "Starter Loops"] as const;

export type Category = "Kick" | "Snare" | "Clap" | "Hat" | "Cymbal" | "Tom" | "Percussion" | "Bass" | "Keys" | "Pad" | "Synth" | "FX" | "Loop" | "Other";
export const CATEGORIES: Category[] = ["Kick", "Snare", "Clap", "Hat", "Cymbal", "Tom", "Percussion", "Bass", "Keys", "Pad", "Synth", "FX", "Loop", "Other"];

export interface SampleMeta {
  /** MIDI note at which the sample plays at its original pitch (pitched samples only). */
  root?: number;
  bpm?: number;
  bars?: number;
  key?: { tonic: number; mode: "major" | "minor" };
  /** Pitch class (0 = C) of a tonal sample whose file name carries a note tag, e.g. "(F#)". */
  rootPc?: number;
  loop?: boolean;
  /** Chord progression of a chord loop, e.g. "I-V-vi-IV". */
  progression?: string;
}

export interface SampleSpec {
  /** Stable id: "starter/kick/punch-kick". */
  id: string;
  name: string;
  category: Category;
  /** Finer label shown in the browser ("Open Hat", "Drum Loop"). */
  sub: string;
  pack: string;
  tags: string[];
  meta: SampleMeta;
  /** Renders the audio (1 or 2 channels at 48 kHz). Deterministic. */
  render: () => Float32Array[];
}

export const slug = (s: string): string =>
  s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const spec = (pack: string, category: Category, sub: string, name: string, tags: string[], meta: SampleMeta, render: () => Float32Array | Float32Array[]): SampleSpec => ({
  id: `starter/${slug(category)}/${slug(name)}`,
  name,
  category,
  sub,
  pack,
  tags,
  meta,
  render: () => {
    const r = render();
    return Array.isArray(r) ? r : [r];
  },
});

/** Every one-shot starts and ends at exactly zero, so it never clicks when triggered or cut. */
const edges = (b: Float32Array): void => {
  fadeIn(b, 0.3);
  fadeOut(b, 6);
};
const pitched = (voice: VoiceName, midi: number, secs: number, seed: string, peak = 0.891): Float32Array => {
  const b = VOICES[voice](midiToHz(midi), secs, seed);
  edges(b);
  normalize(b, peak);
  return b;
};
const stereoPitched = (voice: VoiceName, midi: number, secs: number, seed: string): Float32Array[] => {
  const ch = widen(pitched(voice, midi, secs, seed, 0.85), 14);
  ch.forEach(edges);
  normalize(ch, 0.85);
  return ch;
};
const chordHit = (voice: VoiceName, notes: number[], secs: number, seed: string): Float32Array => {
  const n = VOICES[voice](midiToHz(notes[0]!), secs, seed).length;
  const out = new Float32Array(n);
  for (const m of notes) {
    const v = VOICES[voice](midiToHz(m), secs, `${seed}:${m}`);
    for (let i = 0; i < v.length && i < n; i++) out[i]! += v[i]!;
  }
  edges(out);
  normalize(out, 0.85);
  return out;
};

/** Every sound in the Starter library, in browsing order. Nothing is rendered until `render()` is called. */
export function starterSpecs(): SampleSpec[] {
  const out: SampleSpec[] = [];
  const D = "Starter Drums", B = "Starter Bass", KS = "Starter Keys and Synths", FX = "Starter FX", L = "Starter Loops";

  for (const k of KICKS) out.push(spec(D, "Kick", k.sub, k.name, k.tags, {}, () => kick(k.p, k.name)));
  for (const s of SNARES) out.push(spec(D, "Snare", s.sub, s.name, s.tags, {}, () => snare(s.p, s.name)));
  for (const c of CLAPS) out.push(spec(D, "Clap", c.sub, c.name, c.tags, {}, () => clap(c.p, c.name)));
  for (const h of HATS) out.push(spec(D, "Hat", h.sub, h.name, h.tags, {}, () => hat(h.p, h.name)));

  const crashes: Array<[string, number, number, number, string[]]> = [
    ["Crash Bright", 1.0, 1.7, 3800, ["bright", "edm"]],
    ["Crash Classic", 1.2, 1.4, 3000, ["classic", "rock"]],
    ["Crash Dark", 1.5, 1.2, 2200, ["dark", "long"]],
    ["Crash Short", 0.5, 1.5, 3200, ["short", "accent"]],
  ];
  for (const [n, tau, scale, hp, tags] of crashes) out.push(spec(D, "Cymbal", "Crash", n, tags, {}, () => crash(n, tau, scale, hp)));
  out.push(spec(D, "Cymbal", "Splash", "Splash", ["short", "accent"], {}, () => crash("Splash", 0.28, 2, 4500)));
  out.push(spec(D, "Cymbal", "Ride", "Ride", ["ride", "jazz"], {}, () => ride("Ride", 1.0, 4200, false)));
  out.push(spec(D, "Cymbal", "Ride", "Ride Bell", ["bell", "accent"], {}, () => ride("Ride Bell", 1.2, 3300, true)));
  out.push(spec(D, "Percussion", "Shaker", "Shaker Soft", ["shaker", "soft"], {}, () => shaker("Shaker Soft", 5000, 0.03, 0.08)));
  out.push(spec(D, "Percussion", "Shaker", "Shaker Bright", ["shaker", "bright"], {}, () => shaker("Shaker Bright", 7000, 0.02, 0.06)));
  out.push(spec(D, "Percussion", "Shaker", "Shaker Long", ["shaker", "long"], {}, () => shaker("Shaker Long", 5500, 0.05, 0.12)));
  out.push(spec(D, "Percussion", "Tambourine", "Tambourine", ["tambourine", "pop"], {}, () => tambourine("Tambourine", 0.14)));
  out.push(spec(D, "Percussion", "Tambourine", "Tambourine Short", ["tambourine", "short"], {}, () => tambourine("Tambourine Short", 0.07)));

  const toms: Array<[string, number, number]> = [["Floor Tom", 70, 0.4], ["Low Tom", 92, 0.34], ["Mid Tom", 118, 0.3], ["High Tom", 150, 0.26], ["Hi Tom Tight", 190, 0.2]];
  for (const [n, f, tau] of toms) out.push(spec(D, "Tom", "Tom", n, ["tom", "fill"], {}, () => tom(n, f, tau)));

  out.push(spec(D, "Percussion", "Rim", "Rimshot", ["rim", "snare"], {}, () => rimshot("Rimshot", 1700)));
  out.push(spec(D, "Percussion", "Rim", "Rimshot Low", ["rim", "deep"], {}, () => rimshot("Rimshot Low", 1400)));
  out.push(spec(D, "Percussion", "Rim", "Rimshot High", ["rim", "bright"], {}, () => rimshot("Rimshot High", 2100)));
  out.push(spec(D, "Percussion", "Cowbell", "Cowbell", ["cowbell", "latin"], {}, () => cowbell("Cowbell", 1)));
  out.push(spec(D, "Percussion", "Cowbell", "Cowbell High", ["cowbell", "bright"], {}, () => cowbell("Cowbell High", 1.3)));
  out.push(spec(D, "Percussion", "Clave", "Clave", ["clave", "latin"], {}, () => clave("Clave", 2500)));
  out.push(spec(D, "Percussion", "Wood", "Woodblock", ["wood", "tick"], {}, () => woodblock("Woodblock", 1100)));
  out.push(spec(D, "Percussion", "Wood", "Woodblock High", ["wood", "bright"], {}, () => woodblock("Woodblock High", 1650)));
  out.push(spec(D, "Percussion", "Conga", "Conga Low", ["conga", "latin"], {}, () => conga("Conga Low", 200, 0.22, false)));
  out.push(spec(D, "Percussion", "Conga", "Conga High", ["conga", "latin"], {}, () => conga("Conga High", 310, 0.18, false)));
  out.push(spec(D, "Percussion", "Conga", "Conga Slap", ["conga", "slap"], {}, () => conga("Conga Slap", 330, 0.1, true)));
  out.push(spec(D, "Percussion", "Bongo", "Bongo Low", ["bongo", "latin"], {}, () => conga("Bongo Low", 390, 0.12, false)));
  out.push(spec(D, "Percussion", "Bongo", "Bongo High", ["bongo", "latin"], {}, () => conga("Bongo High", 560, 0.1, false)));
  out.push(spec(D, "Percussion", "Snap", "Finger Snap", ["snap", "pop"], {}, () => snap("Finger Snap", 3000)));
  out.push(spec(D, "Percussion", "Snap", "Finger Snap Bright", ["snap", "bright"], {}, () => snap("Finger Snap Bright", 4200)));
  out.push(spec(D, "Percussion", "Triangle", "Triangle", ["triangle", "ring"], {}, () => triangle("Triangle")));
  out.push(spec(D, "Percussion", "Stick", "Stick Click", ["stick", "count-in"], {}, () => stickClick("Stick Click")));

  // ---- bass (root C2 = MIDI 36)
  const bass: Array<[string, VoiceName, number, string[]]> = [
    ["808 Bass", "sub808", 1.5, ["808", "trap", "hip hop"]],
    ["808 Bass Short", "sub808", 0.4, ["808", "short"]],
    ["Sub Bass", "sub808", 2.4, ["sub", "deep", "long"]],
    ["Synth Bass", "synthBass", 0.9, ["synth", "pop"]],
    ["Synth Bass Tight", "synthBass", 0.28, ["synth", "tight"]],
    ["Reese Bass", "reese", 1.4, ["reese", "dnb"]],
    ["Pluck Bass", "pluckBass", 0.9, ["pluck", "funk"]],
  ];
  for (const [n, v, secs, tags] of bass) out.push(spec(B, "Bass", n.includes("808") || n.startsWith("Sub") ? "808 and Sub" : "Bass", n, tags, { root: 36 }, () => pitched(v, 36, secs, n)));

  // ---- keys, pads and synths (root C4 = MIDI 60)
  const keys: Array<[string, VoiceName, number, string[]]> = [
    ["Electric Piano", "electricPiano", 2.4, ["rhodes", "soft", "lo-fi"]],
    ["Grand Piano", "piano", 3.0, ["piano", "classic"]],
    ["Soft Piano", "piano", 1.2, ["piano", "soft", "short"]],
    ["Organ", "organ", 2.0, ["organ", "gospel"]],
    ["Bell", "bell", 3.2, ["bell", "sparkle"]],
    ["Marimba", "marimba", 1.2, ["marimba", "mallet"]],
    ["Nylon Guitar", "guitar", 2.2, ["guitar", "acoustic"]],
    ["Harp", "harp", 3.0, ["harp", "pluck"]],
  ];
  for (const [n, v, secs, tags] of keys) out.push(spec(KS, "Keys", "Keys", n, tags, { root: 60 }, () => pitched(v, 60, secs, n)));

  const pads: Array<[string, VoiceName, number, string[]]> = [
    ["Warm Pad", "padWarm", 5, ["pad", "warm", "ambient"]],
    ["Glass Pad", "padGlass", 5, ["pad", "airy", "ambient"]],
    ["Strings", "strings", 4.5, ["strings", "cinematic"]],
    ["Choir Ah", "choir", 4.5, ["choir", "vocal", "cinematic"]],
  ];
  for (const [n, v, secs, tags] of pads) out.push(spec(KS, "Pad", "Pad", n, tags, { root: 60 }, () => stereoPitched(v, 60, secs, n)));

  const synths: Array<[string, VoiceName, number, string[]]> = [
    ["Brass Stab", "brass", 0.5, ["brass", "stab", "dance"]],
    ["Saw Lead", "leadSaw", 1.4, ["lead", "saw", "edm"]],
    ["Square Lead", "leadSquare", 1.4, ["lead", "square", "chiptune"]],
    ["Pluck Lead", "leadPluck", 0.5, ["lead", "pluck", "pop"]],
    ["Arp Pluck", "arpPluck", 0.3, ["arp", "pluck", "chiptune"]],
  ];
  for (const [n, v, secs, tags] of synths) out.push(spec(KS, "Synth", "Synth", n, tags, { root: 60 }, () => pitched(v, 60, secs, n)));

  // chord one-shots: each plays a complete chord (they are NOT repitched meaningfully; use them to hear what a chord sounds like)
  const chords: Array<[string, number[], { tonic: number; mode: "major" | "minor" }]> = [
    ["C Major Chord", [60, 64, 67], { tonic: 0, mode: "major" }],
    ["F Major Chord", [53, 57, 60], { tonic: 5, mode: "major" }],
    ["G Major Chord", [55, 59, 62], { tonic: 7, mode: "major" }],
    ["A Minor Chord", [57, 60, 64], { tonic: 9, mode: "minor" }],
    ["D Minor Chord", [50, 53, 57], { tonic: 2, mode: "minor" }],
    ["E Minor Chord", [52, 55, 59], { tonic: 4, mode: "minor" }],
  ];
  for (const [n, notes, key] of chords) out.push(spec(KS, "Keys", "Chord", n, ["chord", key.mode, "lesson"], { key, root: notes[0] }, () => chordHit("electricPiano", notes, 2.4, n)));

  // ---- fx
  out.push(spec(FX, "FX", "Riser", "Riser 4s", ["riser", "build"], {}, () => riser("Riser 4s", 4)));
  out.push(spec(FX, "FX", "Riser", "Riser 8s", ["riser", "build", "long"], {}, () => riser("Riser 8s", 8)));
  out.push(spec(FX, "FX", "Riser", "Riser 2s", ["riser", "short"], {}, () => riser("Riser 2s", 2)));
  out.push(spec(FX, "FX", "Downlifter", "Downlifter 3s", ["fall", "drop"], {}, () => downlifter("Downlifter 3s", 3)));
  out.push(spec(FX, "FX", "Downlifter", "Downlifter 1s", ["fall", "short"], {}, () => downlifter("Downlifter 1s", 1)));
  out.push(spec(FX, "FX", "Sweep", "Sweep Up", ["sweep", "transition"], {}, () => sweep("Sweep Up", 1.5, true)));
  out.push(spec(FX, "FX", "Sweep", "Sweep Down", ["sweep", "transition"], {}, () => sweep("Sweep Down", 1.5, false)));
  out.push(spec(FX, "FX", "Whoosh", "Whoosh", ["whoosh", "transition"], {}, () => whoosh("Whoosh")));
  out.push(spec(FX, "FX", "Impact", "Impact", ["impact", "hit", "boom"], {}, () => impact("Impact")));
  out.push(spec(FX, "FX", "Impact", "Sub Drop", ["drop", "sub", "edm"], {}, () => subDrop("Sub Drop")));
  out.push(spec(FX, "FX", "Impact", "Reverse Crash", ["reverse", "build"], {}, () => reverseCrash("Reverse Crash")));
  out.push(spec(FX, "FX", "Impact", "Noise Hit", ["noise", "hit"], {}, () => noiseHit("Noise Hit")));
  out.push(spec(FX, "FX", "Zap", "Laser Down", ["laser", "zap"], {}, () => zap("Laser Down", 3200, 180, 0.3)));
  out.push(spec(FX, "FX", "Zap", "Laser Up", ["laser", "zap"], {}, () => zap("Laser Up", 200, 3200, 0.3)));
  out.push(spec(FX, "FX", "Texture", "Vinyl Crackle", ["vinyl", "lo-fi", "texture"], { loop: true }, () => vinylCrackle("Vinyl Crackle")));

  // ---- loops
  for (const d of DRUM_LOOPS) out.push(spec(L, "Loop", "Drum Loop", `${d.name} Drums`, ["drums", ...d.tags], { bpm: d.bpm, bars: 2, loop: true }, () => renderDrumLoop(d, 2)));
  for (const d of BASS_LOOPS) out.push(spec(L, "Loop", "Bass Loop", d.name, ["bass", ...d.tags], { bpm: d.bpm, bars: 4, key: d.key, loop: true }, () => renderBassLoop(d)));
  for (const d of CHORD_LOOPS) out.push(spec(L, "Loop", "Chord Loop", d.name, ["chords", ...d.tags], { bpm: d.bpm, bars: 4, key: d.key, loop: true, progression: d.progression }, () => renderChordLoop(d)));

  return out;
}
