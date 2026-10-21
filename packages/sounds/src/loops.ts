import { Rng, SR, hashSeed, midiToHz, normalize, removeDc } from "./dsp.ts";
import { CLAPS, HATS, KICKS, SNARES, clap, crash, hat, kick, rimshot, shaker, snare, tom } from "./drums.ts";
import { VOICES, type VoiceName } from "./voices.ts";

/** Loops are built by placing our own one-shots and voices on an exact grid, so their length is a whole number of bars at their BPM. */

const cache = new Map<string, Float32Array>();
const memo = (key: string, make: () => Float32Array): Float32Array => {
  let v = cache.get(key);
  if (!v) {
    v = make();
    cache.set(key, v);
  }
  return v;
};
const K = (name: string) => memo("k:" + name, () => kick(KICKS.find((k) => k.name === name)!.p, name));
const S = (name: string) => memo("s:" + name, () => snare(SNARES.find((k) => k.name === name)!.p, name));
const C = (name: string) => memo("c:" + name, () => clap(CLAPS.find((k) => k.name === name)!.p, name));
const H = (name: string) => memo("h:" + name, () => hat(HATS.find((k) => k.name === name)!.p, name));

/** Mixes `src` into `dst` at `offset`, wrapping past the end so the loop tiles seamlessly (tails continue into the next pass). */
function addWrap(dst: Float32Array, src: Float32Array, offset: number, gain: number): void {
  const n = dst.length;
  for (let i = 0; i < src.length; i++) dst[(offset + i) % n]! += src[i]! * gain;
}

export const loopSamples = (bpm: number, bars: number): number => Math.round((bars * 4 * 60 * SR) / bpm);

// ---------------------------------------------------------------- drum loops
type Lane = "kick" | "snare" | "clap" | "hat" | "open" | "shaker" | "rim" | "crash" | "tom";
export interface DrumLoopDef {
  name: string;
  bpm: number;
  /** 0.5 = straight; 0.58 = a relaxed shuffle on the 16th notes. */
  swing: number;
  tags: string[];
  /** Per lane: one 16-step pattern per bar (they repeat if fewer than `bars`). x = full, o = medium, g = ghost note. */
  lanes: Partial<Record<Lane, string[]>>;
  kit: { kick: string; snare: string; clap?: string; hat: string; open?: string };
}

const LEVEL: Record<Lane, number> = { kick: 1, snare: 0.85, clap: 0.7, hat: 0.5, open: 0.45, shaker: 0.3, rim: 0.5, crash: 0.55, tom: 0.7 };
const VEL: Record<string, number> = { x: 1, o: 0.62, g: 0.33 };

function laneBuffer(lane: Lane, def: DrumLoopDef): Float32Array {
  switch (lane) {
    case "kick": return K(def.kit.kick);
    case "snare": return S(def.kit.snare);
    case "clap": return C(def.kit.clap ?? "Classic Clap");
    case "hat": return H(def.kit.hat);
    case "open": return H(def.kit.open ?? "Open Hat Classic");
    case "shaker": return memo("shaker", () => shaker("shaker-loop", 5500, 0.025, 0.07));
    case "rim": return memo("rim", () => rimshot("rim-loop", 1700));
    case "crash": return memo("crash", () => crash("crash-loop", 1.4, 1.5, 3200));
    case "tom": return memo("tom", () => tom("tom-loop", 110, 0.3));
  }
}

export function renderDrumLoop(def: DrumLoopDef, bars = 2): Float32Array {
  const stepSec = 60 / def.bpm / 4;
  const total = loopSamples(def.bpm, bars);
  const out = new Float32Array(total);
  const rng = new Rng(hashSeed(def.name));
  for (const lane of Object.keys(def.lanes) as Lane[]) {
    const patterns = def.lanes[lane]!;
    const buf = laneBuffer(lane, def);
    for (let bar = 0; bar < bars; bar++) {
      const pat = patterns[bar % patterns.length]!;
      for (let s = 0; s < 16; s++) {
        const c = pat[s]!;
        if (c === "." || c === " ") continue;
        // 16th-note swing: every second step is pushed toward the next one
        const pair = Math.floor(s / 2) * 2;
        const t = (bar * 16 + pair) * stepSec + (s % 2 === 1 ? 2 * stepSec * def.swing : 0);
        addWrap(out, buf, Math.round(t * SR), LEVEL[lane] * (VEL[c] ?? 1) * (0.95 + 0.05 * rng.next()));
      }
    }
  }
  const clean = removeDc(out);
  normalize(clean, 0.85);
  return clean;
}

const EIGHTHS = "x.x.x.x.x.x.x.x.";
const SIXTEENTHS = "xoxoxoxoxoxoxoxo";

export const DRUM_LOOPS: DrumLoopDef[] = [
  { name: "Boom Bap 90", bpm: 90, swing: 0.56, tags: ["hip hop", "boom bap", "90s"], kit: { kick: "Soft Kick", snare: "Boom Bap Snare", hat: "Closed Hat Dirty" },
    lanes: { kick: ["x.....x.x.......", "x.....x...x.x..."], snare: ["....x.......x..."], hat: [EIGHTHS] } },
  { name: "Lo-fi Chill 75", bpm: 75, swing: 0.6, tags: ["lo-fi", "chill", "study"], kit: { kick: "Dusty Lo-fi Kick", snare: "Lo-fi Snare", hat: "Closed Hat Soft", open: "Open Hat Soft" },
    lanes: { kick: ["x.....x...x.....", "x.....x.....x..."], snare: ["....x.......x..."], hat: ["o.o.o.o.o.o.o.o."], open: ["..............x.", "................"] } },
  { name: "Trap 140", bpm: 140, swing: 0.5, tags: ["trap", "half-time"], kit: { kick: "Trap Hard Kick", snare: "Trap Snare", clap: "Tight Clap", hat: "Closed Hat Tight", open: "Open Hat Short" },
    lanes: { kick: ["x.......x..x....", "x.....x.x......x"], snare: ["........x.......", "........x......."], clap: ["........x.......", "........x......."], hat: ["xoxoxoxoxoxoxxxx", "xoxoxoxoxoxoxoxo"], open: ["..............x.", "................"] } },
  { name: "House 124", bpm: 124, swing: 0.5, tags: ["house", "dance", "four on the floor"], kit: { kick: "House Thump Kick", snare: "Tight Snare", clap: "Classic Clap", hat: "Closed Hat Classic", open: "Open Hat Long" },
    lanes: { kick: ["x...x...x...x..."], clap: ["....x.......x..."], hat: ["x.x.x.x.x.x.x.x."], open: ["..x...x...x...x."], shaker: [SIXTEENTHS] } },
  { name: "Pop 110", bpm: 110, swing: 0.5, tags: ["pop", "radio"], kit: { kick: "Punch Kick", snare: "Snap Snare", clap: "Snap Clap", hat: "Closed Hat Pop" },
    lanes: { kick: ["x.......x.x.....", "x.......x.x..x.."], snare: ["....x.......x..."], clap: ["....x.......x..."], hat: [EIGHTHS] } },
  { name: "Rock 120", bpm: 120, swing: 0.5, tags: ["rock", "live", "band"], kit: { kick: "Rock Kick", snare: "Rock Snare", hat: "Closed Hat Pop" },
    lanes: { kick: ["x.......x.x.....", "x.......x.x....."], snare: ["....x.......x..."], hat: [EIGHTHS], crash: ["x...............", "................"] } },
  { name: "Techno 130", bpm: 130, swing: 0.5, tags: ["techno", "club"], kit: { kick: "Click Kick", snare: "Tight Snare", clap: "Tight Clap", hat: "Closed Hat Short", open: "Open Hat Bright" },
    lanes: { kick: ["x...x...x...x..."], clap: ["....x.......x..."], hat: ["xxxxxxxxxxxxxxxx"], open: ["..x...x...x...x."], rim: ["...x..x....x..x."] } },
  { name: "Big Room 128", bpm: 128, swing: 0.5, tags: ["edm", "festival"], kit: { kick: "Distorted Kick", snare: "Big Room Snare", clap: "Big Room Clap", hat: "Closed Hat Bright", open: "Open Hat Bright" },
    lanes: { kick: ["x...x...x...x..."], snare: ["....x.......x..."], clap: ["....x.......x..."], hat: ["x.x.x.x.x.x.x.x."], open: ["..x...x...x...x."], crash: ["x...............", "................"] } },
  { name: "Drum and Bass 170", bpm: 170, swing: 0.5, tags: ["dnb", "fast"], kit: { kick: "Tight Kick", snare: "Crack Snare", hat: "Closed Hat Bright" },
    lanes: { kick: ["x.........x.....", "x.........x...x."], snare: ["....x.......x..."], hat: ["x.x.x.x.x.x.x.x."] } },
  { name: "Reggaeton 95", bpm: 95, swing: 0.5, tags: ["reggaeton", "latin", "dembow"], kit: { kick: "Punch Kick", snare: "Snap Snare", hat: "Closed Hat Classic" },
    lanes: { kick: ["x...x...x...x..."], snare: ["...x..x....x..x."], hat: [EIGHTHS] } },
  { name: "Funk 100", bpm: 100, swing: 0.54, tags: ["funk", "groove"], kit: { kick: "Rock Kick", snare: "Fat Snare", hat: "Closed Hat Classic", open: "Open Hat Classic" },
    lanes: { kick: ["x..x..x...x.x...", "x..x..x...x...x."], snare: ["....x..g.g..x..g"], hat: [SIXTEENTHS], open: ["..............x.", "................"] } },
  { name: "Afrobeat Groove 105", bpm: 105, swing: 0.55, tags: ["afrobeat", "world"], kit: { kick: "Soft Kick", snare: "Tight Snare", hat: "Closed Hat Classic" },
    lanes: { kick: ["x..x..x...x..x..", "x..x..x...x....."], rim: ["..x..x..x...x..x"], hat: ["x.xxx.xxx.xxx.xx"], shaker: [SIXTEENTHS] } },
];

// ---------------------------------------------------------------- bass and chord loops (harmonic)
interface Key { tonic: number; mode: "major" | "minor" }

export interface BassLoopDef {
  name: string;
  bpm: number;
  key: Key;
  voice: VoiceName;
  tags: string[];
  /** [bar, step (0-15), midi note, length in steps, velocity 0-1] */
  notes: Array<[number, number, number, number, number]>;
}
export interface ChordLoopDef {
  name: string;
  bpm: number;
  key: Key;
  voice: VoiceName;
  tags: string[];
  progression: string;
  /** One chord per bar (MIDI notes). */
  chords: number[][];
  /** 16-step rhythm for each bar; "x" re-strikes the chord. "hold" = one long chord per bar. */
  rhythm: string | "hold";
  strumMs?: number;
}

const bassLine = (roots: number[], pattern: Array<[number, number, number]>): BassLoopDef["notes"] =>
  roots.flatMap((root, bar) => pattern.map(([step, len, offset]): [number, number, number, number, number] => [bar, step, root + offset, len, 0.9]));

export const BASS_LOOPS: BassLoopDef[] = [
  { name: "808 Trap Bass Cm 140", bpm: 140, key: { tonic: 0, mode: "minor" }, voice: "sub808", tags: ["trap", "808", "minor"],
    notes: [[0, 0, 36, 7, 1], [0, 10, 36, 3, 0.8], [1, 0, 32, 7, 1], [1, 10, 32, 3, 0.8], [2, 0, 39, 7, 1], [2, 8, 39, 3, 0.8], [2, 12, 41, 3, 0.8], [3, 0, 34, 7, 1], [3, 10, 34, 5, 0.8]] },
  { name: "Synth Bass Am 120", bpm: 120, key: { tonic: 9, mode: "minor" }, voice: "synthBass", tags: ["synth", "pop", "minor"], notes: bassLine([33, 29, 36, 31], [[0, 2, 0], [2, 2, 0], [4, 2, 12], [6, 2, 0], [8, 2, 0], [10, 2, 0], [12, 2, 12], [14, 2, 0]]) },
  { name: "Pluck Bass C 100", bpm: 100, key: { tonic: 0, mode: "major" }, voice: "pluckBass", tags: ["pluck", "pop", "major"], notes: bassLine([36, 31, 33, 29], [[0, 3, 0], [3, 3, 0], [6, 2, 7], [8, 4, 0], [12, 2, 7], [14, 2, 0]]) },
  { name: "Reese Bass Dm 170", bpm: 170, key: { tonic: 2, mode: "minor" }, voice: "reese", tags: ["dnb", "reese", "minor"], notes: [[0, 0, 38, 12, 1], [1, 0, 34, 12, 1], [2, 0, 41, 12, 1], [3, 0, 36, 12, 1]] },
  { name: "Sub Bass Gm 90", bpm: 90, key: { tonic: 7, mode: "minor" }, voice: "sub808", tags: ["hip hop", "sub", "minor"], notes: [[0, 0, 31, 10, 1], [0, 12, 31, 3, 0.8], [1, 0, 27, 10, 1], [1, 12, 29, 3, 0.8], [2, 0, 34, 10, 1], [2, 12, 34, 3, 0.8], [3, 0, 29, 8, 1], [3, 8, 31, 7, 0.9]] },
  { name: "Groove Bass Em 105", bpm: 105, key: { tonic: 4, mode: "minor" }, voice: "synthBass", tags: ["funk", "groove", "minor"], notes: bassLine([40, 36, 43, 38], [[0, 2, 0], [3, 1, 0], [4, 2, 12], [7, 1, 0], [8, 2, 0], [10, 2, 7], [12, 2, 0], [14, 1, 12]]) },
];

export const CHORD_LOOPS: ChordLoopDef[] = [
  { name: "Pop Chords C 100", bpm: 100, key: { tonic: 0, mode: "major" }, voice: "electricPiano", tags: ["pop", "major", "I-V-vi-IV"], progression: "I-V-vi-IV", strumMs: 6,
    chords: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]], rhythm: "x.....x.x.x....." },
  { name: "Lo-fi Keys C 80", bpm: 80, key: { tonic: 0, mode: "major" }, voice: "electricPiano", tags: ["lo-fi", "jazzy", "ii-V-I"], progression: "vi7-ii7-V7-Imaj7", strumMs: 9,
    chords: [[57, 60, 64, 67], [50, 53, 57, 60], [55, 59, 62, 65], [60, 64, 67, 71]], rhythm: "x.......x.x....." },
  { name: "Sad Piano Am 75", bpm: 75, key: { tonic: 9, mode: "minor" }, voice: "piano", tags: ["sad", "emotional", "i-VI-III-VII"], progression: "i-VI-III-VII", strumMs: 12,
    chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], rhythm: "hold" },
  { name: "Warm Pad D 90", bpm: 90, key: { tonic: 2, mode: "major" }, voice: "padWarm", tags: ["pad", "ambient", "I-V-vi-IV"], progression: "I-V-vi-IV",
    chords: [[62, 66, 69], [57, 61, 64], [59, 62, 66], [55, 59, 62]], rhythm: "hold" },
  { name: "Epic Strings Cm 100", bpm: 100, key: { tonic: 0, mode: "minor" }, voice: "strings", tags: ["epic", "cinematic", "i-VI-III-VII"], progression: "i-VI-III-VII",
    chords: [[60, 63, 67], [56, 60, 63], [63, 67, 70], [58, 62, 65]], rhythm: "hold" },
  { name: "Synth Stabs Em 128", bpm: 128, key: { tonic: 4, mode: "minor" }, voice: "brass", tags: ["dance", "edm", "i-VI-III-VII"], progression: "i-VI-III-VII", strumMs: 0,
    chords: [[64, 67, 71], [60, 64, 67], [67, 71, 74], [62, 66, 69]], rhythm: "x..x..x...x.x..." },
];

function renderVoiceLoop(
  name: string,
  bpm: number,
  bars: number,
  events: Array<{ bar: number; step: number; midi: number; steps: number; vel: number; offsetSec?: number }>,
  voice: VoiceName,
): Float32Array {
  const stepSec = 60 / bpm / 4;
  const out = new Float32Array(loopSamples(bpm, bars));
  for (const e of events) {
    const secs = Math.max(0.05, e.steps * stepSec);
    const note = VOICES[voice](midiToHz(e.midi), secs, `${name}:${e.bar}:${e.step}:${e.midi}`);
    addWrap(out, note, Math.round(((e.bar * 16 + e.step) * stepSec + (e.offsetSec ?? 0)) * SR), e.vel);
  }
  const clean = removeDc(out);
  normalize(clean, 0.85);
  return clean;
}

export const renderBassLoop = (d: BassLoopDef): Float32Array =>
  renderVoiceLoop(d.name, d.bpm, 4, d.notes.map(([bar, step, midi, steps, vel]) => ({ bar, step, midi, steps, vel })), d.voice);

export function renderChordLoop(d: ChordLoopDef): Float32Array {
  const events: Parameters<typeof renderVoiceLoop>[3] = [];
  d.chords.forEach((chord, bar) => {
    const hits = d.rhythm === "hold" ? [0] : [...d.rhythm].flatMap((c, i) => (c === "x" ? [i] : []));
    hits.forEach((step, hi) => {
      const next = hits[hi + 1] ?? 16;
      const steps = d.rhythm === "hold" ? 16 : Math.max(1, next - step);
      chord.forEach((midi, ni) => events.push({ bar, step, midi, steps, vel: 0.9 / Math.sqrt(chord.length), offsetSec: ((d.strumMs ?? 0) / 1000) * ni }));
    });
  });
  return renderVoiceLoop(d.name, d.bpm, 4, events, d.voice);
}
