import { describe, expect, it } from "vitest";
import {
  applyOp,
  createProject,
  dropSampleOps,
  duplicateClipOps,
  invertOp,
  resizeClipOps,
  splitClipOps,
  trimClipStartOps,
  TICKS_PER_BAR,
  type DroppedSample,
  type OpBody,
  type Project,
} from "../src";

const kick: DroppedSample = { id: "starter/kick/punch-kick", name: "Punch Kick", category: "Kick", durationSec: 1.17, meta: {} };
const ids = (n: number) => ({ trackId: `track-s${n}`, clipId: `clip-s${n}`, noteId: `note-s${n}` });
const SONG = 8 * TICKS_PER_BAR;
const SEC_PER_TICK = 60 / (120 * 960);

let counter = 0;
function run(project: Project, ops: OpBody[]): Project {
  let p = project;
  for (const b of ops) {
    const r = applyOp(p, { ...b, opId: `c${counter++}`, clientId: "t" } as never);
    if (!r.ok) throw new Error(r.reason);
    p = r.project;
  }
  return p;
}

const setup = () => {
  const p0 = createProject("p");
  const r = dropSampleOps(p0, kick, 0, null, ids(1), "#f97316");
  if (!r.ok) throw new Error("drop failed");
  const p = run(p0, r.ops);
  const track = p.tracks["track-s1"]!;
  return { p, track, clip: Object.values(track.clips)[0]! };
};
const setAudio = (p: Project, clipId: string, audio: object) => run(p, [{ type: "updateClip", trackId: "track-s1", clipId, changes: { audio } } as OpBody]);

describe("clip audio settings: gain, fades, trimmed start", () => {
  it("stores settings on a sample clip, drops defaults, and undoes", () => {
    const { p, clip } = setup();
    const op = { type: "updateClip", trackId: "track-s1", clipId: clip.id, changes: { audio: { gainDb: -6, fadeInTicks: 480, fadeOutTicks: 0, cut: false } }, opId: "a1", clientId: "t" } as const;
    const r = applyOp(p, op);
    if (!r.ok) throw new Error(r.reason);
    expect(r.project.tracks["track-s1"]!.clips[clip.id]!.audio).toEqual({ gainDb: -6, fadeInTicks: 480 });
    const back = applyOp(r.project, invertOp(p, op, "i1")!);
    if (!back.ok) throw new Error(back.reason);
    expect(back.project.tracks["track-s1"]!.clips[clip.id]!.audio).toBeUndefined();
    const cleared = applyOp(r.project, { type: "updateClip", trackId: "track-s1", clipId: clip.id, changes: { audio: null }, opId: "a2", clientId: "t" });
    expect(cleared.ok && cleared.project.tracks["track-s1"]!.clips[clip.id]!.audio).toBeUndefined();
  });

  it("rejects nonsense: gain out of range, fades longer than the clip, a negative start, settings on a synth clip", () => {
    const { p, clip } = setup();
    const ok = (audio: object) => applyOp(p, { type: "updateClip", trackId: "track-s1", clipId: clip.id, changes: { audio }, opId: `b${Math.random()}`, clientId: "t" } as never).ok;
    expect(ok({ gainDb: 40 })).toBe(false);
    expect(ok({ gainDb: -80 })).toBe(false);
    expect(ok({ fadeInTicks: 3000, fadeOutTicks: 3000 })).toBe(false);
    expect(ok({ fadeInTicks: 1.5 })).toBe(false);
    expect(ok({ startSec: -1 })).toBe(false);
    expect(ok({ gainDb: -3, fadeInTicks: 960, fadeOutTicks: 960, startSec: 0.25 })).toBe(true);
    const synthClip = Object.values(p.tracks["track-1"]!.clips)[0]!;
    expect(applyOp(p, { type: "updateClip", trackId: "track-1", clipId: synthClip.id, changes: { audio: { gainDb: -3 } }, opId: "s1", clientId: "t" }).ok).toBe(false);
  });

  it("shortening a sample clip cuts its sound, keeps the note as long as the clip, and shrinks fades to fit", () => {
    const { p, clip } = setup();
    const withFades = setAudio(p, clip.id, { fadeInTicks: 1500, fadeOutTicks: 1500 });
    const t2 = withFades.tracks["track-s1"]!;
    const q = run(withFades, resizeClipOps("track-s1", t2, t2.clips[clip.id]!, 1920, SONG)!);
    const c2 = q.tracks["track-s1"]!.clips[clip.id]!;
    expect(c2.lengthTicks).toBe(1920);
    expect(c2.audio!.cut).toBe(true);
    expect((c2.audio!.fadeInTicks ?? 0) + (c2.audio!.fadeOutTicks ?? 0)).toBeLessThanOrEqual(1920);
    expect(Object.values(c2.notes)[0]!.durationTicks).toBe(1920);
    const longer = run(q, resizeClipOps("track-s1", q.tracks["track-s1"]!, c2, 3840, SONG)!);
    expect(Object.values(longer.tracks["track-s1"]!.clips[clip.id]!.notes)[0]!.durationTicks).toBe(3840);
  });

  it("trimming the start moves the edge and the start point together; the start point cannot go before the sound's beginning", () => {
    const { p, track, clip } = setup();
    const q = run(p, trimClipStartOps("track-s1", track, clip, 960, SONG, SEC_PER_TICK)!);
    const c = q.tracks["track-s1"]!.clips[clip.id]!;
    expect(c.startTick).toBe(960);
    expect(c.lengthTicks).toBe(3840 - 960);
    expect(c.audio!.startSec).toBeCloseTo(960 * SEC_PER_TICK, 9);
    expect(Object.values(c.notes)[0]!.durationTicks).toBe(3840 - 960);
    const back = run(q, trimClipStartOps("track-s1", q.tracks["track-s1"]!, c, 0, SONG, SEC_PER_TICK)!);
    expect(back.tracks["track-s1"]!.clips[clip.id]!.audio?.startSec).toBeUndefined();
    expect(back.tracks["track-s1"]!.clips[clip.id]!.startTick).toBe(0);
    const moved = run(back, [{ type: "updateClip", trackId: "track-s1", clipId: clip.id, changes: { startTick: 1920 } }]);
    const tt = moved.tracks["track-s1"]!;
    expect(trimClipStartOps("track-s1", tt, tt.clips[clip.id]!, 960, SONG, SEC_PER_TICK)).toBeNull();
  });

  it("splitting a sample clip continues the sound in the right half; a duplicate keeps the settings", () => {
    const { p, clip } = setup();
    const set = setAudio(p, clip.id, { gainDb: -3, fadeInTicks: 480, fadeOutTicks: 480 });
    const c = set.tracks["track-s1"]!.clips[clip.id]!;
    const split = run(set, splitClipOps("track-s1", c, 1920, "clip-r", () => `n${Math.random()}`, SEC_PER_TICK)!);
    const left = split.tracks["track-s1"]!.clips[clip.id]!;
    const right = split.tracks["track-s1"]!.clips["clip-r"]!;
    expect(left.audio).toMatchObject({ gainDb: -3, fadeInTicks: 480, cut: true });
    expect(left.audio!.fadeOutTicks).toBeUndefined();
    expect(right.audio!.startSec).toBeCloseTo(1920 * SEC_PER_TICK, 9);
    expect(right.audio).toMatchObject({ gainDb: -3, fadeOutTicks: 480 });
    expect(right.audio!.fadeInTicks).toBeUndefined();
    const dup = duplicateClipOps("track-s1", set.tracks["track-s1"]!, c, "clip-d", () => `m${Math.random()}`, SONG)!;
    expect(run(set, dup).tracks["track-s1"]!.clips["clip-d"]!.audio).toEqual(c.audio);
  });
});
