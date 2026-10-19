import { describe, expect, it } from "vitest";
import {
  applyOp,
  createProject,
  createTrack,
  invertOp,
  MAX_TRACKS,
  migrateProject,
  projectHash,
  type Op,
  type Project,
} from "../src";

const ok = (project: Project, op: Op) => {
  const r = applyOp(project, op);
  if (!r.ok) throw new Error(r.reason);
  return r;
};
let n = 0;
const id = () => `op${++n}`;
const addTrack = (tid: string, instrument: "synth" | "drums" = "synth", index?: number): Op => ({
  opId: id(),
  clientId: "c",
  type: "addTrack",
  track: createTrack(tid, tid, instrument, "#22d3ee", `${tid}-clip`),
  index,
});

describe("tracks", () => {
  it("adds tracks in order, respects an index, and rejects duplicates", () => {
    let p = createProject("p");
    p = ok(p, addTrack("t2", "drums")).project;
    p = ok(p, addTrack("t3", "synth", 0)).project;
    expect(p.trackOrder).toEqual(["t3", "track-1", "t2"]);
    expect(applyOp(p, addTrack("t2")).ok).toBe(false);
  });

  it(`caps the project at ${MAX_TRACKS} tracks`, () => {
    let p = createProject("p");
    for (let i = 1; i < MAX_TRACKS; i++) p = ok(p, addTrack(`t${i}`)).project;
    expect(p.trackOrder).toHaveLength(MAX_TRACKS);
    expect(applyOp(p, addTrack("one-too-many")).ok).toBe(false);
  });

  it("refuses to delete the last track", () => {
    const p = createProject("p");
    expect(applyOp(p, { opId: id(), clientId: "c", type: "deleteTrack", trackId: "track-1" }).ok).toBe(false);
  });

  it("validates mixer fields", () => {
    const p = createProject("p");
    const upd = (changes: object): Op => ({ opId: id(), clientId: "c", type: "updateTrack", trackId: "track-1", changes }) as Op;
    expect(ok(p, upd({ volume: 55, pan: -30, mute: true, solo: true, name: "Lead", color: "#ff00aa" })).project.tracks["track-1"]).toMatchObject({ volume: 55, pan: -30, mute: true, solo: true, name: "Lead" });
    expect(applyOp(p, upd({ volume: 101 })).ok).toBe(false);
    expect(applyOp(p, upd({ pan: 1.5 })).ok).toBe(false);
    expect(applyOp(p, upd({ name: "" })).ok).toBe(false);
    expect(applyOp(p, upd({ color: "red" })).ok).toBe(false);
    expect(applyOp(p, { opId: id(), clientId: "c", type: "setMasterVolume", volume: -1 }).ok).toBe(false);
  });

  it("deleting a track and undoing restores its notes and position exactly", () => {
    let p = createProject("p");
    p = ok(p, addTrack("t2", "drums")).project;
    p = ok(p, { opId: id(), clientId: "c", type: "addNote", trackId: "t2", clipId: "t2-clip", note: { id: "n1", pitch: 36, startTick: 0, durationTicks: 240, velocity: 100 } }).project;
    p = ok(p, addTrack("t3")).project;
    const del: Op = { opId: id(), clientId: "c", type: "deleteTrack", trackId: "t2" };
    const inv = invertOp(p, del, id())!;
    const after = ok(p, del).project;
    expect(after.trackOrder).toEqual(["track-1", "t3"]);
    const restored = ok(after, inv).project;
    expect(restored.trackOrder).toEqual(p.trackOrder);
    expect(projectHash(restored)).toBe(projectHash(p));
  });

  it("inverts updateTrack, setMasterVolume and note mute", () => {
    let p = createProject("p");
    p = ok(p, { opId: id(), clientId: "c", type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "n1", pitch: 60, startTick: 0, durationTicks: 240, velocity: 90 } }).project;
    const ops: Op[] = [
      { opId: id(), clientId: "c", type: "updateTrack", trackId: "track-1", changes: { volume: 10, mute: true } },
      { opId: id(), clientId: "c", type: "setMasterVolume", volume: 33 },
      { opId: id(), clientId: "c", type: "updateNote", trackId: "track-1", clipId: "clip-1", noteId: "n1", changes: { muted: true } },
    ];
    for (const op of ops) {
      const inv = invertOp(p, op, id())!;
      const after = ok(p, op).project;
      expect(projectHash(ok(after, inv).project)).toBe(projectHash(p));
      p = after;
    }
  });

  it("migrates M1 projects that lack mixer fields", () => {
    const old = createProject("p") as unknown as Record<string, any>;
    delete old.masterVolume;
    for (const k of ["color", "volume", "pan", "mute", "solo"]) delete old.tracks["track-1"][k];
    const m = migrateProject(old as unknown as Project);
    expect(m.masterVolume).toBe(80);
    expect(m.tracks["track-1"]).toMatchObject({ volume: 80, pan: 0, mute: false, solo: false });
    expect(m.tracks["track-1"]!.color).toMatch(/^#/);
  });
});
