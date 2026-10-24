import { describe, expect, it } from "vitest";
import {
  applyOp,
  createProject,
  createTrack,
  deleteClipOps,
  duplicateClipOps,
  findFreeStart,
  freeLengthFrom,
  invertOp,
  lastClipEnd,
  migrateProject,
  moveClipOps,
  newClipOps,
  projectHash,
  resizeClipOps,
  splitClipOps,
  songTicks,
  TICKS_PER_BAR,
  type Clip,
  type Note,
  type Op,
  type OpBody,
  type Project,
} from "../src";

const BAR = TICKS_PER_BAR;
let n = 0;
const uid = () => `id${++n}`;

function run(p: Project, bodies: OpBody[]): Project {
  let out = p;
  for (const b of bodies) {
    const r = applyOp(out, { opId: uid(), clientId: "c", ...b } as Op);
    if (!r.ok) throw new Error(`${b.type}: ${r.reason}`);
    out = r.project;
  }
  return out;
}
const fails = (p: Project, body: OpBody) => !applyOp(p, { opId: uid(), clientId: "c", ...body } as Op).ok;
const note = (id: string, pitch: number, start: number, dur: number): Note => ({ id, pitch, startTick: start, durationTicks: dur, velocity: 90 });
const clipOf = (p: Project, trackId = "track-1", clipId = "clip-1") => p.tracks[trackId]!.clips[clipId]!;

/** A project whose track-1 has one 4-bar clip holding `notes`. */
function withNotes(notes: Note[]): Project {
  return run(createProject("p"), notes.map((nt) => ({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: nt }) as OpBody));
}
const song = (p: Project) => songTicks(p);

describe("clip ops: validation", () => {
  it("adds, rejects overlaps, rejects clips past the song end and shorter than a beat", () => {
    let p = createProject("p"); // 8-bar song, clip-1 = bars 1-4
    const add = (id: string, start: number, len: number): OpBody => ({ type: "addClip", trackId: "track-1", clip: { id, startTick: start, lengthTicks: len, notes: {} } });
    p = run(p, [add("b", 4 * BAR, 2 * BAR)]);
    expect(Object.keys(p.tracks["track-1"]!.clips)).toHaveLength(2);
    expect(fails(p, add("c", 3 * BAR, 2 * BAR))).toBe(true); // overlaps clip-1 (ends at 4 bars)
    expect(fails(p, add("d", 5 * BAR, 2 * BAR))).toBe(true); // overlaps b
    expect(fails(p, add("e", 7 * BAR, 2 * BAR))).toBe(true); // past song end
    expect(fails(p, add("f", 6 * BAR, 100))).toBe(true); // shorter than a beat
    expect(fails(p, add("clip-1", 7 * BAR, BAR))).toBe(true); // duplicate id
    expect(run(p, [add("g", 6 * BAR, 2 * BAR)]).tracks["track-1"]!.clips["g"]).toBeDefined(); // touching edges is fine
  });

  it("clips on different tracks may overlap in time", () => {
    let p = createProject("p");
    p = run(p, [{ type: "addTrack", track: createTrack("t2", "T2", "synth", "#22d3ee", "t2c") }]);
    expect(clipOf(p, "t2", "t2c").startTick).toBe(0); // same place as track-1's clip
  });

  it("cannot shorten a clip below its notes, nor move/grow it into a neighbour", () => {
    const p = withNotes([note("a", 60, 0, 1000), note("b", 62, 2 * BAR, 480)]);
    expect(fails(p, { type: "updateClip", trackId: "track-1", clipId: "clip-1", changes: { lengthTicks: BAR } })).toBe(true);
    const p2 = run(p, [{ type: "addClip", trackId: "track-1", clip: { id: "x", startTick: 5 * BAR, lengthTicks: BAR, notes: {} } }]);
    expect(fails(p2, { type: "updateClip", trackId: "track-1", clipId: "clip-1", changes: { lengthTicks: 5 * BAR + 10 } })).toBe(true);
    expect(fails(p2, { type: "updateClip", trackId: "track-1", clipId: "x", changes: { startTick: 3 * BAR } })).toBe(true);
  });

  it("song length: bounded, and cannot end before the last clip", () => {
    const p = createProject("p"); // clip ends at 4 bars
    expect(run(p, [{ type: "setSongLength", bars: 16 }]).songBars).toBe(16);
    expect(run(p, [{ type: "setSongLength", bars: 4 }]).songBars).toBe(4);
    expect(fails(p, { type: "setSongLength", bars: 3 })).toBe(true);
    expect(fails(p, { type: "setSongLength", bars: 0 })).toBe(true);
    expect(fails(p, { type: "setSongLength", bars: 999 })).toBe(true);
    expect(fails(p, { type: "setSongLength", bars: 4.5 })).toBe(true);
  });

  it("notes stay valid relative to their own clip wherever it sits", () => {
    let p = createProject("p");
    p = run(p, [{ type: "addClip", trackId: "track-1", clip: { id: "late", startTick: 6 * BAR, lengthTicks: BAR, notes: {} } }]);
    p = run(p, [{ type: "addNote", trackId: "track-1", clipId: "late", note: note("n", 60, 0, BAR) }]);
    expect(fails(p, { type: "addNote", trackId: "track-1", clipId: "late", note: note("m", 60, 10, BAR) })).toBe(true);
  });
});

describe("inverse ops restore the exact previous state", () => {
  it("addClip / deleteClip / updateClip / setSongLength", () => {
    let p = withNotes([note("a", 60, 0, 480)]);
    const ops: OpBody[] = [
      { type: "addClip", trackId: "track-1", clip: { id: "x", name: "X", startTick: 4 * BAR, lengthTicks: BAR, notes: { k: note("k", 64, 0, 240) } } },
      { type: "updateClip", trackId: "track-1", clipId: "x", changes: { startTick: 5 * BAR, name: "Y" } },
      { type: "setSongLength", bars: 12 },
      { type: "deleteClip", trackId: "track-1", clipId: "x" },
      { type: "deleteClip", trackId: "track-1", clipId: "clip-1" },
    ];
    for (const body of ops) {
      const op = { opId: uid(), clientId: "c", ...body } as Op;
      const inv = invertOp(p, op, uid())!;
      const after = (applyOp(p, op) as { project: Project }).project;
      const reverted = (applyOp(after, inv) as { project: Project }).project;
      expect(projectHash(reverted)).toBe(projectHash(p));
      p = after;
    }
  });
});

describe("arrangement helpers", () => {
  it("findFreeStart / freeLengthFrom / newClipOps place clips on free bars", () => {
    const p = createProject("p"); // clip-1 occupies bars 1-4 of 8
    const track = p.tracks["track-1"]!;
    expect(findFreeStart(track, 2 * BAR, song(p), 0)).toBe(4 * BAR);
    expect(findFreeStart(track, 5 * BAR, song(p), 0)).toBeNull();
    expect(freeLengthFrom(track, 4 * BAR, song(p))).toBe(4 * BAR);
    expect(freeLengthFrom(track, BAR, song(p))).toBe(0); // inside clip-1
    const ops = newClipOps("track-1", track, "new", 6 * BAR, song(p))!;
    const p2 = run(p, ops);
    expect(clipOf(p2, "track-1", "new")).toMatchObject({ startTick: 6 * BAR, lengthTicks: 2 * BAR }); // shortened to fit
    expect(newClipOps("track-1", track, "z", BAR, song(p))).toBeNull(); // on top of clip-1
  });

  it("move: stays inside the song, refuses to overlap", () => {
    let p = run(createProject("p"), [{ type: "addClip", trackId: "track-1", clip: { id: "x", startTick: 5 * BAR, lengthTicks: BAR, notes: {} } }]);
    const t = () => p.tracks["track-1"]!;
    expect(moveClipOps("track-1", t(), clipOf(p, "track-1", "x"), 6 * BAR, song(p))).toEqual([{ type: "updateClip", trackId: "track-1", clipId: "x", changes: { startTick: 6 * BAR } }]);
    expect(moveClipOps("track-1", t(), clipOf(p, "track-1", "x"), 3 * BAR, song(p))).toBeNull(); // would overlap clip-1
    expect(moveClipOps("track-1", t(), clipOf(p, "track-1", "x"), 99 * BAR, song(p))).toEqual([{ type: "updateClip", trackId: "track-1", clipId: "x", changes: { startTick: 7 * BAR } }]); // clamped
    expect(moveClipOps("track-1", t(), clipOf(p, "track-1", "x"), 5 * BAR, song(p))).toEqual([]); // no-op
    p = run(p, moveClipOps("track-1", t(), clipOf(p, "track-1", "x"), 6 * BAR, song(p))!);
    expect(clipOf(p, "track-1", "x").startTick).toBe(6 * BAR);
  });

  it("resize: shrinking trims or removes notes that no longer fit; growing is plain", () => {
    const p = withNotes([note("a", 60, 0, BAR), note("b", 62, 2 * BAR - 480, 960), note("c", 64, 3 * BAR, 480)]);
    const shrink = resizeClipOps("track-1", p.tracks["track-1"]!, clipOf(p), 2 * BAR, song(p))!;
    const p2 = run(p, shrink);
    const c = clipOf(p2);
    expect(c.lengthTicks).toBe(2 * BAR);
    expect(Object.keys(c.notes).sort()).toEqual(["a", "b"]); // c removed
    expect(c.notes["b"]!.durationTicks).toBe(480); // trimmed to the clip end
    expect(shrink.at(-1)).toMatchObject({ type: "updateClip" }); // clip change comes last so every step is valid
    const grow = resizeClipOps("track-1", p2.tracks["track-1"]!, clipOf(p2), 3 * BAR, song(p2))!;
    expect(grow).toHaveLength(1);
    expect(resizeClipOps("track-1", p.tracks["track-1"]!, clipOf(p), 100, song(p))).toBeNull(); // below a beat
    expect(resizeClipOps("track-1", p.tracks["track-1"]!, clipOf(p), 9 * BAR, song(p))).toBeNull(); // past the song
  });

  it("split: moves later notes, cuts crossing notes in two, loses nothing", () => {
    const notes = [note("a", 60, 0, 480), note("b", 62, BAR - 240, 960), note("c", 64, 2 * BAR, 480), note("d", 65, 3 * BAR + 240, 240)];
    const p = withNotes(notes);
    const before = notes.reduce((sum, x) => sum + x.durationTicks, 0);
    const ops = splitClipOps("track-1", clipOf(p), BAR, "right", () => uid())!;
    const p2 = run(p, ops);
    const left = clipOf(p2), right = clipOf(p2, "track-1", "right");
    expect(left.lengthTicks).toBe(BAR);
    expect(right.startTick).toBe(BAR);
    expect(right.lengthTicks).toBe(3 * BAR);
    const total = (c: Clip) => Object.values(c.notes).reduce((s, x) => s + x.durationTicks, 0);
    expect(total(left) + total(right)).toBe(before); // every tick of every note preserved
    expect(Object.values(left.notes).map((x) => x.pitch).sort()).toEqual([60, 62]);
    expect(Object.values(right.notes).map((x) => [x.pitch, x.startTick]).sort()).toEqual([[62, 0], [64, BAR], [65, 2 * BAR + 240]]);
    expect(splitClipOps("track-1", clipOf(p), 100, "r", () => uid())).toBeNull(); // too close to the start
    expect(splitClipOps("track-1", clipOf(p), 4 * BAR - 100, "r", () => uid())).toBeNull(); // too close to the end
  });

  it("duplicate: copies notes with fresh ids right after the clip, else the next free slot, else null", () => {
    let p = withNotes([note("a", 60, 0, 480)]);
    const ops = duplicateClipOps("track-1", p.tracks["track-1"]!, clipOf(p), "copy", () => uid(), song(p))!;
    p = run(p, ops);
    const copy = clipOf(p, "track-1", "copy");
    expect(copy.startTick).toBe(4 * BAR);
    expect(Object.keys(copy.notes)).not.toContain("a");
    expect(Object.values(copy.notes).map((x) => x.pitch)).toEqual([60]);
    expect(duplicateClipOps("track-1", p.tracks["track-1"]!, clipOf(p), "again", () => uid(), song(p))).toBeNull(); // track is full
  });

  it("delete is a single op", () => {
    expect(deleteClipOps("t", "c")).toEqual([{ type: "deleteClip", trackId: "t", clipId: "c" }]);
  });
});

describe("migration", () => {
  it("M2 projects keep playing the same length: songBars = length of the longest clip", () => {
    const old = createProject("p") as unknown as Record<string, unknown>;
    delete old.songBars;
    const m = migrateProject(old as unknown as Project);
    expect(m.songBars).toBe(4);
    expect(lastClipEnd(m)).toBe(4 * BAR);
  });
  it("keeps an existing song length", () => {
    expect(migrateProject({ ...createProject("p"), songBars: 20 }).songBars).toBe(20);
  });
});
