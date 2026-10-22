import { describe, expect, it } from "vitest";
import { applyOp, barBeat, createProject, formatBarBeat, invertOp, MAX_MARKERS, PPQ, tapTempo, TICKS_PER_BAR, type Marker, type Op, type Project } from "../src";

describe("bar and beat readout", () => {
  it("starts at 1.1.1", () => expect(barBeat(0)).toEqual({ bar: 1, beat: 1, sixteenth: 1 }));
  it("counts beats and sixteenths inside a bar", () => {
    expect(barBeat(PPQ)).toEqual({ bar: 1, beat: 2, sixteenth: 1 });
    expect(barBeat(PPQ * 3 + (PPQ / 4) * 2)).toEqual({ bar: 1, beat: 4, sixteenth: 3 });
  });
  it("moves to the next bar every four beats", () => {
    expect(barBeat(TICKS_PER_BAR - 1)).toEqual({ bar: 1, beat: 4, sixteenth: 4 });
    expect(barBeat(TICKS_PER_BAR)).toEqual({ bar: 2, beat: 1, sixteenth: 1 });
    expect(barBeat(TICKS_PER_BAR * 7 + PPQ)).toEqual({ bar: 8, beat: 2, sixteenth: 1 });
  });
  it("formats like a hardware display", () => expect(formatBarBeat(TICKS_PER_BAR * 2 + PPQ)).toBe("003.2.1"));
  it("treats a negative or fractional tick safely", () => {
    expect(barBeat(-5).bar).toBe(1);
    expect(barBeat(959.9).beat).toBe(1);
  });
});

describe("tap tempo", () => {
  const taps = (gapMs: number, n: number, start = 1000) => Array.from({ length: n }, (_, i) => start + i * gapMs);
  it("needs two taps", () => {
    expect(tapTempo([])).toBeNull();
    expect(tapTempo([500])).toBeNull();
  });
  it("turns the gap between taps into BPM", () => {
    expect(tapTempo(taps(500, 2))).toBe(120);
    expect(tapTempo(taps(600, 5))).toBe(100);
  });
  it("averages over the recent taps, so one slightly late tap does not jump the tempo", () => {
    const t = taps(500, 6);
    t[5]! += 30;
    expect(tapTempo(t)!).toBeGreaterThan(115);
    expect(tapTempo(t)!).toBeLessThan(121);
  });
  it("starts over after a long pause", () => {
    const t = [...taps(500, 4), ...taps(400, 3, 20000)];
    expect(tapTempo(t)).toBe(150);
  });
  it("only uses the last few taps, so it follows a change of pace", () => {
    const t = [...taps(1000, 10), ...taps(500, 9, 10500)];
    expect(tapTempo(t)).toBe(120);
  });
  it("stays inside the tempo range", () => {
    expect(tapTempo(taps(20, 4))).toBe(300);
    expect(tapTempo(taps(1900, 3))).toBeCloseTo(31.6, 1);
  });
});

let n = 0;
const apply = (p: Project, op: Record<string, unknown>) => applyOp(p, { ...op, opId: `lm${++n}`, clientId: "t" } as unknown as Op);
const ok = (p: Project, op: Record<string, unknown>): Project => {
  const r = apply(p, op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

describe("loop region", () => {
  const p0 = createProject("p");
  it("sets and clears the region", () => {
    const p1 = ok(p0, { type: "setLoop", loop: { startTick: TICKS_PER_BAR, endTick: TICKS_PER_BAR * 3 } });
    expect(p1.loop).toEqual({ startTick: TICKS_PER_BAR, endTick: TICKS_PER_BAR * 3 });
    expect("loop" in ok(p1, { type: "setLoop", loop: null })).toBe(false);
  });
  it("refuses a region outside the song, backwards, or shorter than a beat", () => {
    expect(apply(p0, { type: "setLoop", loop: { startTick: 0, endTick: p0.songBars * TICKS_PER_BAR + 1 } }).ok).toBe(false);
    expect(apply(p0, { type: "setLoop", loop: { startTick: 960, endTick: 0 } }).ok).toBe(false);
    expect(apply(p0, { type: "setLoop", loop: { startTick: 0, endTick: PPQ - 1 } }).ok).toBe(false);
    expect(apply(p0, { type: "setLoop", loop: { startTick: -1, endTick: 4000 } }).ok).toBe(false);
    expect(apply(p0, { type: "setLoop", loop: { startTick: 0.5, endTick: 4000 } }).ok).toBe(false);
  });
  it("undoes to the previous region (or none)", () => {
    const first: Op = { type: "setLoop", loop: { startTick: 0, endTick: TICKS_PER_BAR }, opId: "a1", clientId: "t" };
    const p1 = applyOp(p0, first);
    if (!p1.ok) throw new Error("x");
    const undo = applyOp(p1.project, invertOp(p0, first, "a2")!);
    expect(undo.ok && "loop" in undo.project).toBe(false);
    const second: Op = { type: "setLoop", loop: { startTick: TICKS_PER_BAR, endTick: TICKS_PER_BAR * 2 }, opId: "a3", clientId: "t" };
    const p2 = applyOp(p1.project, second);
    if (!p2.ok) throw new Error("x");
    const back = applyOp(p2.project, invertOp(p1.project, second, "a4")!);
    expect(back.ok && back.project.loop).toEqual({ startTick: 0, endTick: TICKS_PER_BAR });
  });
});

describe("section markers", () => {
  const p0 = createProject("p");
  const m = (id: string, tick: number, name = "Verse", color?: string): Marker => ({ id, tick, name, ...(color ? { color } : {}) });
  it("stores markers in time order and trims names", () => {
    const p1 = ok(p0, { type: "setMarkers", markers: [m("b", TICKS_PER_BAR * 4, " Drop "), m("a", 0, "Intro", "#22d3ee")] });
    expect(p1.markers!.map((x) => x.id)).toEqual(["a", "b"]);
    expect(p1.markers![1]!.name).toBe("Drop");
  });
  it("an empty list removes them", () => {
    const p1 = ok(p0, { type: "setMarkers", markers: [m("a", 0)] });
    expect("markers" in ok(p1, { type: "setMarkers", markers: [] })).toBe(false);
  });
  it("refuses bad markers", () => {
    expect(apply(p0, { type: "setMarkers", markers: [m("a", 0), m("a", 960)] }).ok).toBe(false); // same id twice
    expect(apply(p0, { type: "setMarkers", markers: [m("a", p0.songBars * TICKS_PER_BAR + 1)] }).ok).toBe(false);
    expect(apply(p0, { type: "setMarkers", markers: [m("a", -1)] }).ok).toBe(false);
    expect(apply(p0, { type: "setMarkers", markers: [m("a", 0, "   ")] }).ok).toBe(false);
    expect(apply(p0, { type: "setMarkers", markers: [m("a", 0, "x".repeat(25))] }).ok).toBe(false);
    expect(apply(p0, { type: "setMarkers", markers: [m("a", 0, "A", "red")] }).ok).toBe(false);
    expect(apply(p0, { type: "setMarkers", markers: Array.from({ length: MAX_MARKERS + 1 }, (_, i) => m(`m${i}`, i)) }).ok).toBe(false);
  });
  it("undoes to the previous list", () => {
    const op: Op = { type: "setMarkers", markers: [m("a", 0)], opId: "k1", clientId: "t" };
    const p1 = applyOp(p0, op);
    if (!p1.ok) throw new Error("x");
    const back = applyOp(p1.project, invertOp(p0, op, "k2")!);
    expect(back.ok && "markers" in back.project).toBe(false);
  });
});
