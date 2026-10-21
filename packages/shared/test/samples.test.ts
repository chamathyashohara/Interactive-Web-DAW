import { describe, expect, it } from "vitest";
import { applyOp, createProject, dropSampleOps, invertOp, isGateSample, sampleBars, TICKS_PER_BAR, type DroppedSample, type OpBody, type Project } from "../src";

const kick: DroppedSample = { id: "starter/kick/punch-kick", name: "Punch Kick", category: "Kick", durationSec: 1.17, meta: {} };
const loop: DroppedSample = { id: "starter/loop/boom-bap-90-drums", name: "Boom Bap 90 Drums", category: "Loop", durationSec: 5.33, meta: { bpm: 90, bars: 2, loop: true } };
const ids = (n: number) => ({ trackId: `track-s${n}`, clipId: `clip-s${n}`, noteId: `note-s${n}` });

let counter = 0;
function run(project: Project, ops: OpBody[]): Project {
  let p = project;
  for (const b of ops) {
    const r = applyOp(p, { ...b, opId: `o${counter++}`, clientId: "t" } as never);
    if (!r.ok) throw new Error(r.reason);
    p = r.project;
  }
  return p;
}

describe("dropping a sound on the arrangement", () => {
  it("makes a track named after the sound, with one clip that plays it", () => {
    const p0 = createProject("p");
    const r = dropSampleOps(p0, kick, TICKS_PER_BAR * 2, null, ids(1), "#f97316");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = run(p0, r.ops);
    const t = p.tracks["track-s1"]!;
    expect(t.name).toBe("Punch Kick");
    expect(t.instrument).toBe("sample");
    expect(t.sample).toEqual({ id: kick.id, name: "Punch Kick", gate: false });
    expect(t.color).toBe("#f97316");
    const clip = Object.values(t.clips)[0]!;
    expect(clip.startTick).toBe(2 * TICKS_PER_BAR);
    expect(clip.name).toBe("Punch Kick");
    const note = Object.values(clip.notes)[0]!;
    expect(note.pitch).toBe(60);
    expect(note.startTick).toBe(0);
    expect(p.trackOrder.at(-1)).toBe("track-s1");
  });

  it("starts the clip exactly at the (already grid-snapped) tick it is given", () => {
    const p0 = createProject("p");
    const r = dropSampleOps(p0, kick, 960, null, ids(1), "#fff000");
    if (!r.ok) throw new Error("x");
    expect(Object.values(run(p0, r.ops).tracks["track-s1"]!.clips)[0]!.startTick).toBe(960);
  });

  it("a loop covers its own bars and is cut by note-off; a one-shot is not", () => {
    expect(isGateSample(loop)).toBe(true);
    expect(isGateSample(kick)).toBe(false);
    expect(sampleBars(loop, 120)).toBe(2);
    expect(sampleBars(kick, 120)).toBe(1);
    expect(sampleBars({ ...kick, durationSec: 9, meta: {} }, 120)).toBe(5); // 9 s at 120 BPM = 4.5 bars
  });

  it("lengthens the song when the sound would run past its end, in the same batch", () => {
    const p0 = createProject("p"); // 8 bars
    const r = dropSampleOps(p0, loop, 7 * TICKS_PER_BAR, null, ids(1), "#34d399");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops[0]).toEqual({ type: "setSongLength", bars: 9 });
    expect(run(p0, r.ops).songBars).toBe(9);
  });

  it("dropping the same sound on its own lane adds a clip there, not a new track", () => {
    const p0 = createProject("p");
    const first = dropSampleOps(p0, kick, 0, null, ids(1), "#f97316");
    if (!first.ok) throw new Error("x");
    const p1 = run(p0, first.ops);
    const again = dropSampleOps(p1, kick, 2 * TICKS_PER_BAR, "track-s1", ids(2), "#f97316");
    expect(again.ok && !again.newTrack).toBe(true);
    if (!again.ok) return;
    const p2 = run(p1, again.ops);
    expect(Object.keys(p2.tracks["track-s1"]!.clips)).toHaveLength(2);
    expect(p2.trackOrder).toHaveLength(2);
  });

  it("refuses to overlap an existing clip on that lane", () => {
    const p0 = createProject("p");
    const first = dropSampleOps(p0, kick, 0, null, ids(1), "#f97316");
    if (!first.ok) throw new Error("x");
    const p1 = run(p0, first.ops);
    expect(dropSampleOps(p1, kick, 0, "track-s1", ids(2), "#f97316").ok).toBe(false);
  });

  it("a different sound dropped on a lane gets its own track", () => {
    const r = dropSampleOps(createProject("p"), kick, 0, "track-1", ids(1), "#f97316");
    expect(r.ok && r.newTrack).toBe(true);
  });

  it("refuses when the song already has 16 tracks", () => {
    let p = createProject("p");
    for (let i = 0; i < 15; i++) {
      const r = dropSampleOps(p, { ...kick, id: `s${i}`, name: `S${i}` }, 0, null, ids(i + 10), "#f97316");
      if (!r.ok) throw new Error(r.reason);
      p = run(p, r.ops);
    }
    expect(p.trackOrder).toHaveLength(16);
    expect(dropSampleOps(p, kick, 0, null, ids(99), "#f97316").ok).toBe(false);
  });

  it("a sample track must name its sample (validation)", () => {
    const p0 = createProject("p");
    const r = dropSampleOps(p0, kick, 0, null, ids(1), "#f97316");
    if (!r.ok) throw new Error("x");
    const bad = JSON.parse(JSON.stringify(r.ops)) as OpBody[];
    delete (bad[0] as unknown as { track: { sample?: unknown } }).track.sample;
    expect(applyOp(p0, { ...bad[0]!, opId: "b", clientId: "t" } as never).ok).toBe(false);
  });
});

describe("loops that follow the project tempo", () => {
  const drop = (tempo: number) => {
    const p0 = { ...createProject("p"), tempo };
    const r = dropSampleOps(p0, loop, 0, null, ids(1), "#34d399");
    if (!r.ok) throw new Error(r.reason);
    return { p0, p: run(p0, r.ops) };
  };
  it("a loop with a known tempo drops in set to fit, with the same bars at any tempo", () => {
    for (const tempo of [70, 120, 170]) {
      const { p } = drop(tempo);
      const t = p.tracks["track-s1"]!;
      expect(t.sample).toMatchObject({ bpm: 90, fit: true, gate: true });
      expect(Object.values(t.clips)[0]!.lengthTicks).toBe(2 * TICKS_PER_BAR);
    }
  });
  it("a one-shot has no tempo to fit", () => {
    const p0 = createProject("p");
    const r = dropSampleOps(p0, kick, 0, null, ids(1), "#f97316");
    if (!r.ok) throw new Error("x");
    expect(run(p0, r.ops).tracks["track-s1"]!.sample!.fit).toBeUndefined();
  });
  it("a loop without a bar count gets it from its length at its own tempo", () => {
    expect(sampleBars({ ...loop, meta: { bpm: 100, loop: true }, durationSec: 9.6 }, 150)).toBe(4);
  });
  it("updateSample changes the original tempo and Fit, validates, and undoes", () => {
    const { p } = drop(120);
    let q = run(p, [{ type: "updateSample", trackId: "track-s1", changes: { fit: false } }]);
    expect(q.tracks["track-s1"]!.sample!.fit).toBe(false);
    q = run(q, [{ type: "updateSample", trackId: "track-s1", changes: { bpm: 100 } }]);
    expect(q.tracks["track-s1"]!.sample!.bpm).toBe(100);
    q = run(q, [{ type: "updateSample", trackId: "track-s1", changes: { bpm: null } }]);
    expect(q.tracks["track-s1"]!.sample!.bpm).toBeUndefined();
    expect(applyOp(q, { type: "updateSample", trackId: "track-s1", changes: { bpm: 5 }, opId: "bad1", clientId: "t" }).ok).toBe(false);
    expect(applyOp(q, { type: "updateSample", trackId: "track-1", changes: { fit: true }, opId: "bad2", clientId: "t" }).ok).toBe(false); // a synth track
    const op = { type: "updateSample", trackId: "track-s1", changes: { bpm: 80, fit: true }, opId: "fwd", clientId: "t" } as const;
    const after = applyOp(q, op);
    if (!after.ok) throw new Error(after.reason);
    const inv = invertOp(q, op, "inv");
    const back = applyOp(after.project, inv!);
    if (!back.ok) throw new Error(back.reason);
    expect(back.project.tracks["track-s1"]!.sample).toEqual(q.tracks["track-s1"]!.sample);
  });
});
