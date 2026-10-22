import { describe, expect, it } from "vitest";
import { applyOp, createProject, TICKS_PER_BAR, type Note, type Op, type OpBody, type Project } from "@daw/shared";
import { velocityRampOps } from "./ramp";
import { ACCENT_VELOCITY, barCount, clearBarOps, copyBarToAllOps, NORMAL_VELOCITY, notesAtStep, setStepOps, STEP_TICKS, stepsInBar, stepTick, stepVelocity } from "./steps";

const clip = { trackId: "track-1", clipId: "clip-1", lengthTicks: TICKS_PER_BAR * 4 };
const note = (id: string, pitch: number, startTick: number, velocity = 100): Note => ({ id, pitch, startTick, durationTicks: STEP_TICKS, velocity });
let c = 0;
const newId = () => `s${++c}`;
const ok = (p: Project, b: OpBody): Project => {
  const r = applyOp(p, { opId: `x${++c}`, clientId: "t", ...b } as Op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const run = (notes: Note[], bodies: OpBody[]): Note[] => {
  let p: Project = createProject("p");
  for (const n of notes) p = ok(p, { type: "addNote", trackId: "track-1", clipId: "clip-1", note: n });
  for (const b of bodies) p = ok(p, b);
  return Object.values(p.tracks["track-1"]!.clips["clip-1"]!.notes).sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
};

describe("step grid", () => {
  it("has sixteen steps of a sixteenth note per bar", () => {
    expect(stepTick(0, 0)).toBe(0);
    expect(stepTick(0, 4)).toBe(960);
    expect(stepTick(2, 3)).toBe(TICKS_PER_BAR * 2 + STEP_TICKS * 3);
  });
  it("counts bars and the steps that fit in a clip that ends mid-bar", () => {
    expect(barCount(TICKS_PER_BAR * 4)).toBe(4);
    expect(barCount(TICKS_PER_BAR * 4 + 1)).toBe(5);
    expect(stepsInBar(TICKS_PER_BAR + STEP_TICKS * 5, 1)).toBe(5);
    expect(stepsInBar(TICKS_PER_BAR + STEP_TICKS * 5, 2)).toBe(0);
    expect(stepsInBar(TICKS_PER_BAR * 4, 3)).toBe(16);
  });
  it("shows a hand-played note that is slightly off the grid on its step", () => {
    const ns = [note("a", 36, 100), note("b", 38, 0)];
    expect(notesAtStep(ns, 36, 0).map((n) => n.id)).toEqual(["a"]);
    expect(stepVelocity(ns, 36, 0)).toBe(100);
    expect(stepVelocity(ns, 36, STEP_TICKS)).toBeNull();
  });
});

describe("toggling steps", () => {
  it("turns an empty step on at the normal loudness, one sixteenth long", () => {
    const out = run([], setStepOps(clip, [], 36, stepTick(0, 4), NORMAL_VELOCITY, newId));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ pitch: 36, startTick: 960, durationTicks: STEP_TICKS, velocity: NORMAL_VELOCITY });
  });
  it("turns a step off, even if several notes sit on it", () => {
    const ns = [note("a", 36, 0), note("b", 36, 100)];
    expect(run(ns, setStepOps(clip, ns, 36, 0, null, newId))).toHaveLength(0);
  });
  it("changes the loudness of a lit step instead of adding a second note", () => {
    const ns = [note("a", 42, 0, 100)];
    const out = run(ns, setStepOps(clip, ns, 42, 0, ACCENT_VELOCITY, newId));
    expect(out).toHaveLength(1);
    expect(out[0]!.velocity).toBe(ACCENT_VELOCITY);
  });
  it("does not add a step past the end of the clip", () => {
    expect(setStepOps(clip, [], 36, clip.lengthTicks, NORMAL_VELOCITY, newId)).toEqual([]);
  });
});

describe("bars", () => {
  const ns = [note("a", 36, 0), note("b", 38, 960), note("c", 36, TICKS_PER_BAR), note("d", 42, TICKS_PER_BAR * 2)];
  it("clears one bar, optionally one drum", () => {
    expect(run(ns, clearBarOps(clip, ns, 0)).map((n) => n.id)).toEqual(["c", "d"]);
    expect(run(ns, clearBarOps(clip, ns, 0, 36)).map((n) => n.id)).toEqual(["b", "c", "d"]);
  });
  it("copies a bar over all the others, replacing what was there", () => {
    const out = run(ns, copyBarToAllOps(clip, ns, 0, newId));
    expect(out).toHaveLength(8);
    for (let b = 0; b < 4; b++) {
      const bar = out.filter((n) => n.startTick >= b * TICKS_PER_BAR && n.startTick < (b + 1) * TICKS_PER_BAR);
      expect(bar.map((n) => [n.pitch, n.startTick - b * TICKS_PER_BAR])).toEqual([[36, 0], [38, 960]]);
    }
  });
});

describe("velocity ramp", () => {
  const four = [note("a", 42, 0, 55), note("b", 42, 960, 55), note("c", 42, 1920, 55), note("d", 42, 2880, 55)];
  it("goes from the first value to the last by time", () => {
    expect(run(four, velocityRampOps(clip, four, 40, 100)).map((n) => n.velocity)).toEqual([40, 60, 80, 100]);
  });
  it("can run downwards", () => expect(run(four, velocityRampOps(clip, four, 120, 30)).map((n) => n.velocity)).toEqual([120, 90, 60, 30]));
  it("an ease-in build stays quiet for longer, ease-out gets loud quickly", () => {
    const easeIn = run(four, velocityRampOps(clip, four, 20, 110, "ease-in")).map((n) => n.velocity);
    const easeOut = run(four, velocityRampOps(clip, four, 20, 110, "ease-out")).map((n) => n.velocity);
    expect(easeIn[1]!).toBeLessThan(50 - 5);
    expect(easeOut[1]!).toBeGreaterThan(50 + 5); // a straight ramp would give 50
    expect(easeIn[3]).toBe(110);
  });
  it("gives notes that sound together the same loudness", () => {
    const ns = [note("a", 60, 0), note("b", 64, 0), note("c", 60, 1920)];
    const out = run(ns, velocityRampOps(clip, ns, 40, 100));
    expect(out.filter((n) => n.startTick === 0).map((n) => n.velocity)).toEqual([40, 40]);
  });
  it("keeps values in 1-127 and skips notes that do not change", () => {
    const out = run(four, velocityRampOps(clip, four, -50, 500)).map((n) => n.velocity);
    expect(out[0]).toBe(1);
    expect(out[3]).toBe(127);
    expect(velocityRampOps(clip, four, 55, 55)).toEqual([]);
    expect(velocityRampOps(clip, [], 1, 127)).toEqual([]);
  });
});
