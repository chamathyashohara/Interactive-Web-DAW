import { describe, expect, it } from "vitest";
import { applyOp, createProject, PPQ, TICKS_PER_BAR, type Note, type Op, type OpBody, type Project } from "@daw/shared";
import { duplicateOps, pasteOps, quantizeOps, sliceOps, transposeOps } from "./editing";
import { chopOps } from "./chop";

// How the piano roll's note operations treat a note's pitch bend (the glide recorded by hand play).
const clip = { trackId: "track-1", clipId: "clip-1", lengthTicks: TICKS_PER_BAR * 4 };
let c = 0;
const newId = () => `n${++c}`;
const ok = (p: Project, b: OpBody): Project => {
  const r = applyOp(p, { opId: `x${++c}`, clientId: "t", ...b } as Op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const run = (notes: Note[], bodies: OpBody[]): Note[] => {
  let p = createProject("p");
  for (const n of notes) p = ok(p, { type: "addNote", trackId: "track-1", clipId: "clip-1", note: n });
  for (const b of bodies) p = ok(p, b);
  return Object.values(p.tracks["track-1"]!.clips["clip-1"]!.notes).sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
};
// a one-beat note that glides up two semitones over its length
const glide = (id = "g", start = 0): Note => ({ id, pitch: 60, startTick: start, durationTicks: PPQ, velocity: 100, bend: [{ tick: 0, semis: 0 }, { tick: PPQ, semis: 2 }] });

describe("pitch bend and the piano roll's note operations", () => {
  it("paste and duplicate keep the glide", () => {
    const pasted = run([glide()], pasteOps(clip, [glide()], PPQ * 2, newId));
    expect(pasted).toHaveLength(2);
    expect(pasted[1]!.bend).toEqual([{ tick: 0, semis: 0 }, { tick: PPQ, semis: 2 }]);
    expect(pasted[1]!.bend).not.toBe(pasted[0]!.bend); // a copy, not the same array
    const dup = run([glide()], duplicateOps(clip, [glide()], PPQ / 4, newId));
    expect(dup[1]!.bend).toEqual(glide().bend);
  });

  it("slicing gives the right part its own share of the glide and leaves the left part on the original curve", () => {
    const n = glide();
    const out = run([n], sliceOps(clip, n, PPQ / 2, newId)!);
    expect(out).toHaveLength(2);
    expect(out[0]!.durationTicks).toBe(PPQ / 2);
    expect(out[0]!.bend).toEqual(n.bend); // the first half still follows the original curve (the part past its end is simply not heard)
    expect(out[1]!.bend).toEqual([{ tick: 0, semis: 1 }, { tick: PPQ / 2, semis: 2 }]); // the second half starts where the glide had got to
  });

  it("chopping gives every piece the part of the curve that was under it, so the pieces together still glide the same way", () => {
    const n = glide();
    const out = run([n], chopOps(clip, [n], PPQ / 4, newId));
    expect(out).toHaveLength(4);
    const starts = out.map((p) => p.bend![0]!.semis);
    expect(starts).toEqual([0, 0.5, 1, 1.5]); // each piece begins at the pitch the whole note had reached
    expect(out[3]!.bend![out[3]!.bend!.length - 1]).toEqual({ tick: PPQ / 4, semis: 2 });
  });

  it("a flat piece of a curve becomes a plain note", () => {
    const flat: Note = { id: "f", pitch: 60, startTick: 0, durationTicks: PPQ, velocity: 100, bend: [{ tick: 0, semis: 0 }, { tick: PPQ / 4, semis: 0 }] };
    const out = run([flat], chopOps(clip, [flat], PPQ / 4, newId));
    expect(out.every((p) => p.bend === undefined)).toBe(true);
  });

  it("moving, quantizing and transposing keep the glide (it is relative to the note)", () => {
    const n = glide("m", 150);
    const moved = run([n], [...quantizeOps(clip, [n], 240), ...transposeOps(clip, [n], 7)]);
    expect(moved[0]!.startTick).toBe(240);
    expect(moved[0]!.pitch).toBe(67);
    expect(moved[0]!.bend).toEqual(n.bend);
  });
});
