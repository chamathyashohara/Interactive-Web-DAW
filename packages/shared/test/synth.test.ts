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
  it("has a 'keys' default whose params match the original synth sound", () => {
    expect(DEFAULT_SYNTH_PRESET).toBe("keys");
    const keys = synthParamsFor("keys");
    expect(keys).toMatchObject({ attackSec: 0.004, releaseSec: 0.18, sawLevel: 0.7, subLevel: 0.3, osc2Level: 0, detuneCents: 0, toneHz: 20000, gain: 0.16 });
  });
  it("offers pad, strings, pluck, lead and bass with distinct, sensible params", () => {
    const ids = SYNTH_PRESETS.map((p) => p.id);
    expect(ids).toEqual(["keys", "pad", "strings", "pluck", "lead", "bass"]);
    expect(synthParamsFor("pad").attackSec).toBeGreaterThan(0.2); // pads swell in slowly
    expect(synthParamsFor("pluck").releaseSec).toBeLessThan(0.2); // plucks are short
    expect(synthParamsFor("bass").subLevel).toBeGreaterThan(synthParamsFor("lead").subLevel); // bass has more sub
    expect(synthParamsFor("pad").toneHz).toBeLessThan(synthParamsFor("lead").toneHz); // pads are darker
  });
  it("falls back to keys for a missing or unknown id", () => {
    expect(synthParamsFor()).toEqual(synthParamsFor("keys"));
    expect(synthParamsFor("nope")).toEqual(synthParamsFor("keys"));
    expect(isSynthPreset("pad")).toBe(true);
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
    expect(back.ok && (back.project.tracks["track-1"]!.synthPreset ?? "keys")).toBe("keys");
  });
});
