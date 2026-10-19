import { describe, expect, it } from "vitest";
import { applyOp, createProject, invertOp, projectHash, TICKS_PER_BAR, type Op, type Project } from "../src";

const add = (id: string, opId: string, over: Record<string, unknown> = {}): Op =>
  ({
    opId,
    clientId: "c1",
    type: "addNote",
    trackId: "track-1",
    clipId: "clip-1",
    note: { id, pitch: 60, startTick: 0, durationTicks: 240, velocity: 90 },
    ...over,
  }) as Op;

const ok = (project: Project, op: Op) => {
  const r = applyOp(project, op);
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("applyOp", () => {
  it("adds, updates and deletes a note", () => {
    let p = createProject("p");
    p = ok(p, add("n1", "o1")).project;
    expect(p.tracks["track-1"]!.clips["clip-1"]!.notes["n1"]!.pitch).toBe(60);
    p = ok(p, { opId: "o2", clientId: "c1", type: "updateNote", trackId: "track-1", clipId: "clip-1", noteId: "n1", changes: { pitch: 64 } }).project;
    expect(p.tracks["track-1"]!.clips["clip-1"]!.notes["n1"]!.pitch).toBe(64);
    p = ok(p, { opId: "o3", clientId: "c1", type: "deleteNote", trackId: "track-1", clipId: "clip-1", noteId: "n1" }).project;
    expect(Object.keys(p.tracks["track-1"]!.clips["clip-1"]!.notes)).toHaveLength(0);
  });

  it("is idempotent: applying the same opId twice equals applying it once", () => {
    const p0 = createProject("p");
    const op = add("n1", "o1");
    const once = ok(p0, op);
    const twice = ok(once.project, op);
    expect(twice.applied).toBe(false);
    expect(projectHash(twice.project)).toBe(projectHash(once.project));
  });

  it("sets tempo and rejects out-of-range values", () => {
    const p0 = createProject("p");
    expect(ok(p0, { opId: "t1", clientId: "c1", type: "setTempo", bpm: 140 }).project.tempo).toBe(140);
    expect(applyOp(p0, { opId: "t2", clientId: "c1", type: "setTempo", bpm: 5 }).ok).toBe(false);
  });

  it("rejects invalid notes", () => {
    const p0 = createProject("p");
    expect(applyOp(p0, add("n", "o", { note: { id: "n", pitch: 200, startTick: 0, durationTicks: 10, velocity: 90 } })).ok).toBe(false);
    expect(applyOp(p0, add("n", "o", { note: { id: "n", pitch: 60, startTick: 4 * TICKS_PER_BAR - 10, durationTicks: 100, velocity: 90 } })).ok).toBe(false);
    expect(applyOp(p0, add("n", "o", { note: { id: "n", pitch: 60, startTick: 1.5, durationTicks: 100, velocity: 90 } })).ok).toBe(false);
    expect(applyOp(p0, add("n", "o", { trackId: "nope" })).ok).toBe(false);
  });

  it("rejects a duplicate note id with a different opId", () => {
    const p1 = ok(createProject("p"), add("n1", "o1")).project;
    expect(applyOp(p1, add("n1", "o2")).ok).toBe(false);
  });

  it("does not mutate its input", () => {
    const p0 = createProject("p");
    const snapshot = JSON.stringify(p0);
    ok(p0, add("n1", "o1"));
    expect(JSON.stringify(p0)).toBe(snapshot);
  });
});

describe("invertOp", () => {
  it("inverse of add/update/tempo/delete restores the previous state", () => {
    const ops: Op[] = [
      add("n1", "o1"),
      { opId: "o2", clientId: "c1", type: "updateNote", trackId: "track-1", clipId: "clip-1", noteId: "n1", changes: { pitch: 67, velocity: 40 } },
      { opId: "o3", clientId: "c1", type: "setTempo", bpm: 150 },
      { opId: "o4", clientId: "c1", type: "deleteNote", trackId: "track-1", clipId: "clip-1", noteId: "n1" },
    ];
    let p = createProject("p");
    ops.forEach((op, i) => {
      const inv = invertOp(p, op, `inv${i}`)!;
      const after = ok(p, op).project;
      const reverted = ok(after, inv).project;
      expect(projectHash(reverted)).toBe(projectHash(p));
      p = after;
    });
  });
});
