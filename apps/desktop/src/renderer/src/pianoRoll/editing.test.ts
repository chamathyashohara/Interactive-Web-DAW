import { describe, expect, it } from "vitest";
import { applyOp, createProject, type Note, type Op, type OpBody, type Project } from "@daw/shared";
import { clampGroupMove, copyNotes, deleteOps, duplicateOps, pasteOps, quantizeOps, sliceOps, toggleMuteOps } from "./editing";

const clip = { trackId: "track-1", clipId: "clip-1", lengthTicks: 15360 };
const note = (id: string, pitch: number, startTick: number, durationTicks = 240, extra: Partial<Note> = {}): Note => ({ id, pitch, startTick, durationTicks, velocity: 90, ...extra });
let c = 0;
const newId = () => `new${++c}`;

function applyAll(p: Project, bodies: OpBody[]): Project {
  let out = p;
  for (const b of bodies) {
    const r = applyOp(out, { opId: `x${++c}`, clientId: "t", ...b } as Op);
    if (!r.ok) throw new Error(r.reason);
    out = r.project;
  }
  return out;
}
const withNotes = (notes: Note[]) => applyAll(createProject("p"), notes.map((n) => ({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: n }) as OpBody));
const notesOf = (p: Project) => Object.values(p.tracks["track-1"]!.clips["clip-1"]!.notes).sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);

describe("copy / paste / duplicate", () => {
  it("copies relative to the earliest note and pastes at the target, keeping pitch and velocity", () => {
    const copied = copyNotes([note("a", 60, 480), note("b", 64, 960)]);
    expect(copied.map((n) => n.startTick)).toEqual([0, 480]);
    const p = applyAll(createProject("p"), pasteOps(clip, copied, 1920, newId));
    expect(notesOf(p).map((n) => [n.pitch, n.startTick])).toEqual([[60, 1920], [64, 2400]]);
  });
  it("trims or drops pasted notes that would leave the clip", () => {
    const ops = pasteOps(clip, [note("a", 60, 0, 1000), note("b", 62, 500, 240)], 15000, newId);
    const p = applyAll(createProject("p"), ops);
    const out = notesOf(p);
    expect(out).toHaveLength(1);
    expect(out[0]!.durationTicks).toBe(360); // trimmed to the clip end
  });
  it("duplicates directly after the selection, rounded up to the grid", () => {
    const sel = [note("a", 60, 0, 240), note("b", 62, 300, 240)]; // span 540 -> 720 at 1/16 grid
    const p = applyAll(withNotes(sel), duplicateOps(clip, sel, 240, newId));
    expect(notesOf(p).map((n) => n.startTick)).toEqual([0, 300, 720, 1020]);
  });
  it("preserves muted flags when pasting", () => {
    const p = applyAll(createProject("p"), pasteOps(clip, [note("a", 60, 0, 240, { muted: true })], 0, newId));
    expect(notesOf(p)[0]!.muted).toBe(true);
  });
});

describe("quantize", () => {
  it("snaps starts to the nearest grid line and leaves aligned notes untouched", () => {
    const notes = [note("a", 60, 250), note("b", 62, 480), note("c", 64, 700)];
    const ops = quantizeOps(clip, notes, 240);
    expect(ops).toHaveLength(2); // b is already aligned
    const p = applyAll(withNotes(notes), ops);
    expect(notesOf(p).map((n) => n.startTick)).toEqual([240, 480, 720]);
  });
  it("never pushes a note past the end of the clip", () => {
    const n = note("a", 60, 15350, 10);
    const ops = quantizeOps(clip, [n], 240);
    const p = applyAll(withNotes([n]), ops);
    expect(notesOf(p)[0]!.startTick + notesOf(p)[0]!.durationTicks).toBeLessThanOrEqual(15360);
  });
});

describe("slice", () => {
  it("splits one note into two that together cover the original", () => {
    const n = note("a", 60, 480, 960, { velocity: 77 });
    const ops = sliceOps(clip, n, 960, newId)!;
    const out = notesOf(applyAll(withNotes([n]), ops));
    expect(out.map((x) => [x.startTick, x.durationTicks, x.velocity])).toEqual([[480, 480, 77], [960, 480, 77]]);
  });
  it("refuses to cut at or outside the note edges", () => {
    const n = note("a", 60, 480, 960);
    expect(sliceOps(clip, n, 480, newId)).toBeNull();
    expect(sliceOps(clip, n, 1440, newId)).toBeNull();
    expect(sliceOps(clip, n, 100, newId)).toBeNull();
  });
});

describe("delete and mute", () => {
  it("deletes a selection", () => {
    const notes = [note("a", 60, 0), note("b", 62, 240), note("c", 64, 480)];
    expect(notesOf(applyAll(withNotes(notes), deleteOps(clip, ["a", "c"]))).map((n) => n.id)).toEqual(["b"]);
  });
  it("toggles mute: audible notes become muted, then all unmute", () => {
    const notes = [note("a", 60, 0), note("b", 62, 240, 240, { muted: true })];
    const p1 = applyAll(withNotes(notes), toggleMuteOps(clip, notes));
    expect(notesOf(p1).every((n) => n.muted === true)).toBe(true);
    const p2 = applyAll(p1, toggleMuteOps(clip, notesOf(p1)));
    expect(notesOf(p2).every((n) => !n.muted)).toBe(true);
  });
});

describe("clampGroupMove", () => {
  it("keeps the whole group inside the clip and pitch range", () => {
    const g = [note("a", 40, 100), note("b", 80, 15000, 300)];
    expect(clampGroupMove(g, -500, 0, 15360, 36, 83)).toMatchObject({ dTick: -100 });
    expect(clampGroupMove(g, 500, 0, 15360, 36, 83)).toMatchObject({ dTick: 60 });
    expect(clampGroupMove(g, 0, 10, 15360, 36, 83)).toMatchObject({ dPitch: 3 });
    expect(clampGroupMove(g, 0, -10, 15360, 36, 83)).toMatchObject({ dPitch: -4 });
  });
});
