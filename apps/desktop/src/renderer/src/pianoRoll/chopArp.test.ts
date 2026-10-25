import { describe, expect, it } from "vitest";
import { applyOp, createProject, PPQ, TICKS_PER_BAR, type Note, type Op, type OpBody, type Project } from "@daw/shared";
import { transposeOps } from "./editing";
import { chopOps } from "./chop";
import { arpOps } from "./arp";

const clip = { trackId: "track-1", clipId: "clip-1", lengthTicks: TICKS_PER_BAR * 4 };
const note = (id: string, pitch: number, startTick: number, durationTicks: number, velocity = 100): Note => ({ id, pitch, startTick, durationTicks, velocity });
let c = 0;
const newId = () => `n${++c}`;
const run = (notes: Note[], bodies: OpBody[]): Note[] => {
  let p: Project = createProject("p");
  for (const n of notes) p = ok(p, { type: "addNote", trackId: "track-1", clipId: "clip-1", note: n });
  for (const b of bodies) p = ok(p, b);
  return Object.values(p.tracks["track-1"]!.clips["clip-1"]!.notes).sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
};
const ok = (p: Project, b: OpBody): Project => {
  const r = applyOp(p, { opId: `x${++c}`, clientId: "t", ...b } as Op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

describe("transpose (Lessons 1.3, 5.1)", () => {
  it("shifts a note up and down by an octave", () => {
    const n = [note("a", 60, 0, PPQ)];
    expect(run(n, transposeOps(clip, n, 12))[0]!.pitch).toBe(72);
    expect(run(n, transposeOps(clip, n, -12))[0]!.pitch).toBe(48);
  });
  it("moves a chord as a group so it stays intact", () => {
    const chord = [note("a", 60, 0, PPQ), note("b", 64, 0, PPQ), note("c", 67, 0, PPQ)];
    expect(run(chord, transposeOps(clip, chord, 2)).map((x) => x.pitch)).toEqual([62, 66, 69]);
  });
  it("clamps so the whole group stays in 0-127, or does nothing if it cannot move", () => {
    const high = [note("a", 120, 0, PPQ), note("b", 127, 0, PPQ)];
    expect(transposeOps(clip, high, 12)).toEqual([]); // 127 cannot go higher
    const nearTop = [note("a", 120, 0, PPQ)];
    expect(run(nearTop, transposeOps(clip, nearTop, 12))[0]!.pitch).toBe(127); // clamped to the ceiling
  });
});

describe("chopper (Lesson 5.2)", () => {
  it("slices a one-bar note into eight 1/8-note pieces, covering the whole note", () => {
    const n = [note("a", 60, 0, TICKS_PER_BAR)];
    const out = run(n, chopOps(clip, n, PPQ / 2, newId));
    expect(out).toHaveLength(8);
    expect(out.every((x) => x.durationTicks === PPQ / 2 && x.pitch === 60)).toBe(true);
    expect(out.map((x) => x.startTick)).toEqual([0, 480, 960, 1440, 1920, 2400, 2880, 3360]);
  });
  it("leaves a note too short to make two pieces alone", () => {
    const n = [note("a", 60, 0, PPQ / 2)];
    expect(chopOps(clip, n, PPQ, newId)).toEqual([]);
  });
  it("keeps pitch and velocity of each piece", () => {
    const n = [note("a", 55, 0, PPQ, 72)];
    const out = run(n, chopOps(clip, n, PPQ / 2, newId));
    expect(out.every((x) => x.pitch === 55 && x.velocity === 72)).toBe(true);
  });
});

describe("arpeggiator (Lesson 6.1)", () => {
  it("spreads a chord into a rising sequence over its own length", () => {
    const chord = [note("a", 60, 0, TICKS_PER_BAR), note("b", 64, 0, TICKS_PER_BAR), note("c", 67, 0, TICKS_PER_BAR)];
    const out = run(chord, arpOps(clip, chord, PPQ, "up", newId));
    expect(out).toHaveLength(4); // one bar / quarter-note step = 4 steps
    expect(out.map((x) => x.pitch)).toEqual([60, 64, 67, 60]); // cycles up through the chord
    expect(out.map((x) => x.startTick)).toEqual([0, 960, 1920, 2880]);
  });
  it("can run down", () => {
    const chord = [note("a", 60, 0, PPQ * 3), note("b", 64, 0, PPQ * 3), note("c", 67, 0, PPQ * 3)];
    expect(run(chord, arpOps(clip, chord, PPQ, "down", newId)).map((x) => x.pitch)).toEqual([67, 64, 60]);
  });
  it("leaves a single note (not a chord) alone", () => {
    const n = [note("a", 60, 0, TICKS_PER_BAR)];
    expect(arpOps(clip, n, PPQ, "up", newId)).toEqual([]);
  });
  it("averages the chord's velocities", () => {
    const chord = [note("a", 60, 0, PPQ * 2, 80), note("b", 64, 0, PPQ * 2, 100)];
    expect(run(chord, arpOps(clip, chord, PPQ, "up", newId)).every((x) => x.velocity === 90)).toBe(true);
  });
});
