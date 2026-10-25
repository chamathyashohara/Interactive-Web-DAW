import { describe, expect, it } from "vitest";
import { applyOp, createProject, createTrack, DEFAULT_SYNTH_PRESET, invertOp, isSynthPreset, SYNTH_PRESETS, synthParamsFor, type Op, type Project } from "../src";

let n = 0;
const apply = (p: Project, op: Record<string, unknown>) => applyOp(p, { ...op, opId: `sp${++n}`, clientId: "t" } as unknown as Op);
const ok = (p: Project, op: Record<string, unknown>): Project => {
  const r = apply(p, op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

describe("synth presets", () => {
  it("has a 'classic' default whose params match the original synth sound", () => {
    expect(DEFAULT_SYNTH_PRESET).toBe("classic");
    expect(synthParamsFor("classic")).toMatchObject({ model: 0, attackSec: 0.004, releaseSec: 0.18, sawLevel: 0.7, subLevel: 0.3, osc2Level: 0, detuneCents: 0, toneHz: 20000, gain: 0.16, sineLevel: 0, drive: 0 });
  });
  it("offers classic, piano, pad, violin, pluck, lead and bass", () => {
    expect(SYNTH_PRESETS.map((p) => p.id)).toEqual(["classic", "keys", "pad", "strings", "pluck", "lead", "bass"]);
    expect(SYNTH_PRESETS.find((p) => p.id === "keys")!.name).toBe("Piano");
    expect(SYNTH_PRESETS.find((p) => p.id === "strings")!.name).toBe("Violin");
  });
  it("uses a different voice MODEL for piano and violin, not just a different filter", () => {
    expect(synthParamsFor("classic").model).toBe(0);
    expect(synthParamsFor("keys").model).toBe(1); // additive, struck piano
    expect(synthParamsFor("strings").model).toBe(2); // bowed ensemble
    expect(synthParamsFor("strings").vibratoCents).toBeGreaterThan(5); // violin has vibrato
    expect(synthParamsFor("strings").noiseLevel).toBeGreaterThan(0); // and bow noise
  });
  it("makes the bass heavy: a strong fundamental and sub, a dark tone, and saturation", () => {
    const bass = synthParamsFor("bass");
    expect(bass.sineLevel).toBeGreaterThan(0.5);
    expect(bass.subLevel).toBeGreaterThan(synthParamsFor("lead").subLevel * 2);
    expect(bass.toneHz).toBeLessThan(1500);
    expect(bass.drive).toBeGreaterThan(0);
  });
  it("keeps the other character differences (pad swells and is dark, pluck is short)", () => {
    expect(synthParamsFor("pad").attackSec).toBeGreaterThan(0.2);
    expect(synthParamsFor("pluck").releaseSec).toBeLessThan(0.2);
    expect(synthParamsFor("pad").toneHz).toBeLessThan(synthParamsFor("lead").toneHz);
  });
  it("falls back to classic for a missing or unknown id", () => {
    expect(synthParamsFor()).toEqual(synthParamsFor("classic"));
    expect(synthParamsFor("nope")).toEqual(synthParamsFor("classic"));
    expect(isSynthPreset("keys")).toBe(true);
    expect(isSynthPreset("nope")).toBe(false);
  });
});

describe("setSynthPreset op", () => {
  const p0 = createProject("p"); // one synth track "track-1"
  it("sets the preset on a synth track", () => {
    const p1 = ok(p0, { type: "setSynthPreset", trackId: "track-1", preset: "pad" });
    expect(p1.tracks["track-1"]!.synthPreset).toBe("pad");
  });
  it("refuses an unknown preset or a non-synth track", () => {
    expect(apply(p0, { type: "setSynthPreset", trackId: "track-1", preset: "nope" }).ok).toBe(false);
    const withDrums = ok(p0, { type: "addTrack", track: createTrack("d", "Kit", "drums", "#f472b6", "dc") });
    expect(apply(withDrums, { type: "setSynthPreset", trackId: "d", preset: "pad" }).ok).toBe(false);
  });
  it("undoes to the previous preset (or keys)", () => {
    const set: Op = { type: "setSynthPreset", trackId: "track-1", preset: "strings", opId: "a1", clientId: "t" };
    const after = applyOp(p0, set);
    if (!after.ok) throw new Error("x");
    const back = applyOp(after.project, invertOp(p0, set, "a2")!);
    expect(back.ok && (back.project.tracks["track-1"]!.synthPreset ?? "classic")).toBe("classic");
  });
});
