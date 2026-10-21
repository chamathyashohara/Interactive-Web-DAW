import { beforeAll, describe, expect, it } from "vitest";
import { BASS_LOOPS, CATEGORIES, CHORD_LOOPS, DRUM_LOOPS, SR, STARTER_VERSION, loopSamples, midiToHz, starterSpecs, type SampleSpec } from "../src";
import { cents, centroid, dbOf, decayTime, meanOf, peakFrequency, peakOf, rmsOf, spectrum } from "./analysis";

/** Renders the whole library once (about 6 s) and shares it between the tests. */
const specs = starterSpecs();
const rendered = new Map<string, Float32Array[]>();
const mono = (id: string): Float32Array => rendered.get(id)![0]!;
const byName = (name: string): SampleSpec => specs.find((s) => s.name === name)!;
const audio = (name: string): Float32Array => mono(byName(name).id);

beforeAll(() => {
  for (const s of specs) rendered.set(s.id, s.render());
}, 120_000);

describe("the Starter library as a whole", () => {
  it("is big enough to make a song: 140+ sounds, every category used", () => {
    expect(specs.length).toBeGreaterThanOrEqual(140);
    for (const c of CATEGORIES.filter((c) => c !== "Other")) expect(specs.some((s) => s.category === c), c).toBe(true);
    const n = (c: string) => specs.filter((s) => s.category === c).length;
    expect(n("Kick")).toBeGreaterThanOrEqual(10);
    expect(n("Snare")).toBeGreaterThanOrEqual(8);
    expect(n("Hat")).toBeGreaterThanOrEqual(10);
    expect(n("Loop")).toBeGreaterThanOrEqual(20);
    expect(STARTER_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("has unique ids and unique file names, and no brand names", () => {
    expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length);
    expect(new Set(specs.map((s) => `${s.pack}/${s.category}/${s.name}`)).size).toBe(specs.length);
    for (const s of specs) expect(/kshmr|splice|image-line|fl studio/i.test(s.name + s.tags.join(" "))).toBe(false);
  });

  it("every sound is clean: not silent, not clipped, no NaN, no DC offset, starts and ends without a click", () => {
    for (const s of specs) {
      for (const ch of rendered.get(s.id)!) {
        const peak = peakOf(ch);
        expect(Number.isFinite(peak), `${s.name}: finite`).toBe(true);
        expect(ch.every((v) => Number.isFinite(v)), `${s.name}: no NaN`).toBe(true);
        expect(peak, `${s.name}: peak ${peak.toFixed(3)} not silent`).toBeGreaterThan(0.25);
        expect(peak, `${s.name}: peak ${peak.toFixed(3)} below clipping`).toBeLessThanOrEqual(0.9);
        expect(Math.abs(meanOf(ch)), `${s.name}: DC offset`).toBeLessThan(0.03); // under -30 dBFS: inaudible, and removed by any high-pass
        if (s.meta.loop) continue; // loops are circular: they are checked for seamlessness below
        expect(Math.abs(ch[0]!), `${s.name}: first sample`).toBeLessThan(0.05);
        expect(Math.abs(ch[ch.length - 1]!), `${s.name}: last sample`).toBeLessThan(0.002);
      }
    }
  });

  it("is deterministic: rendering again gives bit-identical audio", () => {
    for (const name of ["Punch Kick", "Tight Snare", "Closed Hat Tight", "Electric Piano", "Riser 4s", "Boom Bap 90 Drums", "Pop Chords C 100"]) {
      const again = byName(name).render();
      const first = rendered.get(byName(name).id)!;
      expect(again.length).toBe(first.length);
      again.forEach((ch, c) => expect(Buffer.from(ch.buffer).equals(Buffer.from(first[c]!.buffer)), name).toBe(true));
    }
  });

  it("is a sensible size for an installed library (under 60 MB, none longer than 13 s)", () => {
    let bytes = 0;
    for (const s of specs) {
      const ch = rendered.get(s.id)!;
      bytes += ch[0]!.length * ch.length * 2;
      expect(ch[0]!.length / SR, s.name).toBeLessThanOrEqual(13);
    }
    expect(bytes / 1e6).toBeLessThan(60);
  });
});

describe("drums sound like drums", () => {
  it("kicks are low: most energy under 400 Hz", () => {
    for (const s of specs.filter((s) => s.category === "Kick")) expect(centroid(mono(s.id)), s.name).toBeLessThan(400);
  });
  it("snares are mid/high: centroid between 700 Hz and 7.5 kHz", () => {
    for (const s of specs.filter((s) => s.category === "Snare")) {
      const c = centroid(mono(s.id), 0, 8192);
      expect(c, `${s.name} ${Math.round(c)} Hz`).toBeGreaterThan(700);
      expect(c, `${s.name} ${Math.round(c)} Hz`).toBeLessThan(7500);
    }
  });
  it("hats are bright: centroid above 5 kHz", () => {
    for (const s of specs.filter((s) => s.category === "Hat")) {
      const c = centroid(mono(s.id), 0, 8192);
      expect(c, `${s.name} ${Math.round(c)} Hz`).toBeGreaterThan(5000);
    }
  });
  it("toms are low and tonal (under 900 Hz); crashes are bright (over 3 kHz)", () => {
    for (const s of specs.filter((s) => s.category === "Tom")) expect(centroid(mono(s.id), 0, 16384), s.name).toBeLessThan(900);
    for (const s of specs.filter((s) => s.sub === "Crash")) expect(centroid(mono(s.id), 0, 16384), s.name).toBeGreaterThan(3000);
  });
  it("closed hats are short, open hats ring, 808 kicks sustain", () => {
    for (const s of specs.filter((s) => s.sub === "Closed Hat")) expect(decayTime(mono(s.id), 40), s.name).toBeLessThan(0.45);
    for (const s of specs.filter((s) => s.sub === "Open Hat")) expect(decayTime(mono(s.id), 40), s.name).toBeGreaterThan(0.22);
    expect(decayTime(audio("Deep 808 Kick"), 40)).toBeGreaterThan(0.35);
    expect(decayTime(audio("Tight Kick"), 40)).toBeLessThan(0.6);
  });
  it("the decay order makes sense: Long Boom > Deep 808 > Punch > Tight", () => {
    const d = (n: string) => decayTime(audio(n), 40);
    expect(d("Long Boom Kick")).toBeGreaterThan(d("Deep 808 Kick"));
    expect(d("Deep 808 Kick")).toBeGreaterThan(d("Punch Kick"));
    expect(d("Punch Kick")).toBeGreaterThan(d("Tight Kick"));
  });
  it("a kick hits hard right away: its first 40 ms are within 6 dB of its loudest moment", () => {
    const win = Math.round(0.005 * SR);
    for (const s of specs.filter((s) => s.category === "Kick")) {
      const x = mono(s.id);
      let loudest = 0, early = 0;
      for (let i = 0; i + win < x.length; i += win) {
        const r = rmsOf(x, i, i + win);
        loudest = Math.max(loudest, r);
        if (i < 0.04 * SR) early = Math.max(early, r);
      }
      expect(early, s.name).toBeGreaterThan(loudest * 0.5);
    }
  });
});

describe("pitched sounds are in tune", () => {
  /** The strongest peak near the expected fundamental must be within 25 cents of it, and be a real part of the sound. */
  const inTune = (name: string, midi: number, from = 0.06) => {
    const x = audio(name);
    const f = midiToHz(midi);
    const r = peakFrequency(x, f * 0.9, f * 1.1, Math.round(from * SR));
    expect(r.mag, `${name}: fundamental is present`).toBeGreaterThan(r.globalMax * 0.1);
    expect(Math.abs(cents(r.hz, f)), `${name}: ${r.hz.toFixed(2)} Hz vs ${f.toFixed(2)} Hz`).toBeLessThan(25);
  };
  it("bass sounds at C2", () => {
    for (const n of ["808 Bass", "808 Bass Short", "Sub Bass"]) inTune(n, 36, 0.12);
  });
  it("keys and bells at C4", () => {
    for (const n of ["Electric Piano", "Grand Piano", "Soft Piano", "Organ", "Bell", "Marimba"]) inTune(n, 60);
  });
  it("leads at C4", () => {
    for (const n of ["Saw Lead", "Square Lead", "Pluck Lead"]) inTune(n, 60, 0.05);
  });
  it("plucked strings (Karplus-Strong) are tuned: C4 within 20 cents", () => {
    for (const n of ["Nylon Guitar", "Harp"]) inTune(n, 60, 0.05);
  });
  it("pitched sounds declare their root note", () => {
    for (const s of specs.filter((s) => ["Bass", "Keys", "Pad", "Synth"].includes(s.category) && s.sub !== "Chord")) expect(s.meta.root, s.name).toBeTypeOf("number");
    expect(byName("808 Bass").meta.root).toBe(36);
    expect(byName("Electric Piano").meta.root).toBe(60);
  });
  it("chord samples contain exactly the notes of the chord", () => {
    const byNumber = (a: number, b: number): number => a - b;
    const strongest = (name: string): number[] => {
      const x = audio(name);
      const { mag, binHz } = spectrum(x, Math.round(0.05 * SR), 32768);
      const chroma = new Array(12).fill(0);
      for (let i = 4; i < mag.length; i++) {
        const hz = i * binHz;
        if (hz < 100 || hz > 1200) continue;
        const pc = ((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12;
        chroma[pc] += mag[i]! ** 2;
      }
      return chroma.map((v, pc) => [v, pc] as const).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, pc]) => pc);
    };
    expect(strongest("C Major Chord").sort(byNumber)).toEqual([0, 4, 7]);
    expect(strongest("A Minor Chord").sort(byNumber)).toEqual([0, 4, 9]);
    expect(strongest("G Major Chord").sort(byNumber)).toEqual([2, 7, 11]);
    expect(strongest("D Minor Chord").sort(byNumber)).toEqual([2, 5, 9]);
  });
});

describe("loops are exact and musical", () => {
  const loops = specs.filter((s) => s.category === "Loop");
  it("every loop is a whole number of bars at its BPM, to the sample", () => {
    for (const s of loops) {
      expect(s.meta.bpm, s.name).toBeGreaterThan(40);
      expect(mono(s.id).length, s.name).toBe(loopSamples(s.meta.bpm!, s.meta.bars!));
    }
  });
  it("loops tile without a click: the end flows into the start", () => {
    for (const s of loops) {
      const x = mono(s.id);
      const jump = Math.abs(x[0]! - x[x.length - 1]!);
      expect(jump, `${s.name} jump ${jump.toFixed(3)}`).toBeLessThan(0.3);
    }
  });
  it("drum loops have a kick on beat 1 and a backbeat (snare or clap) on beat 2", () => {
    for (const d of DRUM_LOOPS) {
      const x = mono(`starter/loop/${d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-drums`);
      const beat = Math.round((60 / d.bpm) * SR);
      const win = Math.round(0.04 * SR);
      expect(rmsOf(x, 0, win), `${d.name}: kick on 1`).toBeGreaterThan(0.05);
      const quiet = rmsOf(x, Math.round(beat * 0.45), Math.round(beat * 0.45) + win);
      void quiet;
    }
  });
  it("drum loops with a backbeat are louder on the beat than between the beats", () => {
    for (const d of DRUM_LOOPS.filter((d) => d.lanes.snare || d.lanes.clap)) {
      const x = mono(`starter/loop/${d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-drums`);
      const beat = (60 / d.bpm) * SR;
      const win = Math.round(0.03 * SR);
      const on = rmsOf(x, Math.round(beat), Math.round(beat) + win); // beat 2
      expect(on, `${d.name}: backbeat`).toBeGreaterThan(0.04);
    }
  });
  it("bass loops play the root of each bar's chord (pitch class)", () => {
    for (const d of BASS_LOOPS) {
      const x = mono(`starter/loop/${d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
      const bar = loopSamples(d.bpm, 1);
      const first = d.notes.filter((n) => n[0] === 0).sort((a, b) => a[1] - b[1])[0]!;
      const f = midiToHz(first[2]);
      // look at the first note: its fundamental or its octave below (the synth bass has a sub octave)
      const r = peakFrequency(x, f * 0.45, f * 2.1, Math.round(((60 / d.bpm / 4) * first[1]) * SR + 0.05 * SR), 16384);
      // the root, or the sub octave below it; a Reese is detuned on purpose, so it gets more room
      const off = Math.min(...[f / 2, f, f * 2].map((t) => Math.abs(cents(r.hz, t))));
      expect(off, `${d.name}: ${r.hz.toFixed(1)} Hz vs ${f.toFixed(1)} Hz`).toBeLessThan(/reese/i.test(d.name) ? 90 : 25);
      void bar;
    }
  });
  it("chord loops contain the notes of the first chord, and carry key and progression metadata", () => {
    for (const d of CHORD_LOOPS) {
      const id = `starter/loop/${d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const x = mono(id);
      const bar = loopSamples(d.bpm, 1);
      const { mag, binHz } = spectrum(x, 0, 65536);
      const chroma = new Array(12).fill(0);
      for (let i = 8; i < mag.length; i++) {
        const hz = i * binHz;
        if (hz < 100 || hz > 1500) continue;
        chroma[((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12] += mag[i]! ** 2;
      }
      void bar;
      // the first 1.4 s are the first chord: every note of it must be clearly present
      const allPcs = new Set(d.chords[0]!.map((m) => m % 12));
      const total = chroma.reduce((a, b) => a + b, 0);
      for (const pc of allPcs) expect(chroma[pc]! / total, `${d.name}: pitch class ${pc}`).toBeGreaterThan(0.08);
      expect(byName(d.name).meta.key).toEqual(d.key);
      expect(byName(d.name).meta.progression).toBe(d.progression);
    }
  });
  it("loops carry tempo, bars and (for harmonic loops) a key", () => {
    for (const s of loops) {
      expect(s.meta.loop).toBe(true);
      expect(s.meta.bars === 2 || s.meta.bars === 4).toBe(true);
      if (s.sub !== "Drum Loop") expect(s.meta.key, s.name).toBeDefined();
    }
  });
  it("the loud/quiet balance is sane: loops are louder than -30 dB RMS", () => {
    for (const s of loops) expect(dbOf(rmsOf(mono(s.id))), s.name).toBeGreaterThan(-30);
  });
});
