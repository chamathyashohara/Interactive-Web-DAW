import { describe, expect, it } from "vitest";
import { applyOp, autoValueAt, createProject, filterHz, invertOp, MAX_AUTO_POINTS, TICKS_PER_BAR, type AutoPoint, type Op, type Project } from "../src";

let n = 0;
const set = (p: Project, points: AutoPoint[] | null, param: "volume" | "filter" = "volume", trackId = "track-1"): Project => {
  const r = applyOp(p, { type: "setAutomation", trackId, param, points, opId: `au${++n}`, clientId: "t" } as Op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const tryApply = (p: Project, points: unknown, param = "volume", trackId = "track-1") =>
  applyOp(p, { type: "setAutomation", trackId, param, points, opId: `au${++n}`, clientId: "t" } as never);

describe("automation curves", () => {
  const p0 = createProject("p");
  it("stores a curve on a track, and removes it with null or an empty list", () => {
    const p1 = set(p0, [{ tick: 0, value: 0 }, { tick: 3840, value: 1 }]);
    expect(p1.tracks["track-1"]!.automation!.volume).toEqual([{ tick: 0, value: 0 }, { tick: 3840, value: 1 }]);
    expect(set(p1, null).tracks["track-1"]!.automation).toBeUndefined();
    expect(set(p1, []).tracks["track-1"]!.automation).toBeUndefined();
  });
  it("keeps volume and filter curves separately", () => {
    const p1 = set(set(p0, [{ tick: 0, value: 1 }]), [{ tick: 0, value: 0.2 }], "filter");
    expect(Object.keys(p1.tracks["track-1"]!.automation!).sort()).toEqual(["filter", "volume"]);
    expect(Object.keys(set(p1, null, "volume").tracks["track-1"]!.automation!)).toEqual(["filter"]);
  });
  it("undoes by restoring the previous curve (or none)", () => {
    const a = [{ tick: 0, value: 0.5 }];
    const p1 = set(p0, a);
    const op: Op = { type: "setAutomation", trackId: "track-1", param: "volume", points: [{ tick: 0, value: 0 }, { tick: 960, value: 1 }], opId: "x1", clientId: "t" };
    const after = applyOp(p1, op);
    if (!after.ok) throw new Error(after.reason);
    const back = applyOp(after.project, invertOp(p1, op, "x2")!);
    if (!back.ok) throw new Error(back.reason);
    expect(back.project.tracks["track-1"]!.automation!.volume).toEqual(a);
    const fresh: Op = { ...op, opId: "x3" };
    const first = applyOp(p0, fresh);
    if (!first.ok) throw new Error("x");
    const undone = applyOp(first.project, invertOp(p0, fresh, "x4")!);
    expect(undone.ok && undone.project.tracks["track-1"]!.automation).toBeUndefined();
  });
  it("refuses bad curves", () => {
    expect(tryApply(p0, [{ tick: 960, value: 0.5 }, { tick: 0, value: 0.5 }]).ok).toBe(false); // out of order
    expect(tryApply(p0, [{ tick: 0, value: 0.5 }, { tick: 0, value: 0.7 }]).ok).toBe(false); // two points at one moment
    expect(tryApply(p0, [{ tick: 0, value: 1.5 }]).ok).toBe(false);
    expect(tryApply(p0, [{ tick: 0, value: -0.1 }]).ok).toBe(false);
    expect(tryApply(p0, [{ tick: 0.5, value: 0.5 }]).ok).toBe(false);
    expect(tryApply(p0, [{ tick: p0.songBars * TICKS_PER_BAR + 1, value: 0.5 }]).ok).toBe(false); // past the song
    expect(tryApply(p0, Array.from({ length: MAX_AUTO_POINTS + 1 }, (_, i) => ({ tick: i, value: 0.5 }))).ok).toBe(false);
    expect(tryApply(p0, [{ tick: 0, value: 0.5 }], "pitch").ok).toBe(false);
    expect(tryApply(p0, [{ tick: 0, value: 0.5 }], "volume", "nope").ok).toBe(false);
  });
});

describe("reading a curve", () => {
  const pts: AutoPoint[] = [{ tick: 960, value: 0 }, { tick: 1920, value: 1 }, { tick: 2880, value: 0.5 }];
  it("holds the first value before the curve and the last after it", () => {
    expect(autoValueAt(pts, 0)).toBe(0);
    expect(autoValueAt(pts, 5000)).toBe(0.5);
  });
  it("draws straight lines between points", () => {
    expect(autoValueAt(pts, 1440)).toBeCloseTo(0.5, 9);
    expect(autoValueAt(pts, 1920)).toBe(1);
    expect(autoValueAt(pts, 2400)).toBeCloseTo(0.75, 9);
  });
  it("is full level (1) when there is no curve", () => expect(autoValueAt([], 123)).toBe(1));
  it("maps the filter value to a cutoff from 20 Hz to 20 kHz on a log scale", () => {
    expect(filterHz(0)).toBeCloseTo(20, 6);
    expect(filterHz(1)).toBeCloseTo(20000, 3);
    expect(filterHz(0.5)).toBeCloseTo(Math.sqrt(20 * 20000), 3);
  });
});
