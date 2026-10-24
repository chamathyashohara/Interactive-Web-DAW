import { describe, expect, it } from "vitest";
import { applyOp, createProject, createTrack, TICKS_PER_BAR, type Op, type Project } from "@daw/shared";
import { isAudible, SlotAllocator, toEngineSnapshot, volumeToGain } from "./snapshot";

let n = 0;
const run = (p: Project, body: object): Project => {
  const r = applyOp(p, { opId: `o${++n}`, clientId: "c", ...body } as Op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const withTracks = () => {
  let p = createProject("p");
  p = run(p, { type: "addTrack", track: createTrack("t2", "Drums", "drums", "#f472b6", "c2") });
  p = run(p, { type: "addTrack", track: createTrack("t3", "Bass", "synth", "#a3e635", "c3") });
  return p;
};

describe("mute / solo resolution", () => {
  it("is audible by default; mute silences only that track", () => {
    let p = withTracks();
    expect(["track-1", "t2", "t3"].map((id) => isAudible(p, id))).toEqual([true, true, true]);
    p = run(p, { type: "updateTrack", trackId: "t2", changes: { mute: true } });
    expect(["track-1", "t2", "t3"].map((id) => isAudible(p, id))).toEqual([true, false, true]);
  });
  it("solo silences every non-soloed track; several solos can coexist; mute still wins", () => {
    let p = withTracks();
    p = run(p, { type: "updateTrack", trackId: "t2", changes: { solo: true } });
    expect(["track-1", "t2", "t3"].map((id) => isAudible(p, id))).toEqual([false, true, false]);
    p = run(p, { type: "updateTrack", trackId: "t3", changes: { solo: true } });
    expect(["track-1", "t2", "t3"].map((id) => isAudible(p, id))).toEqual([false, true, true]);
    p = run(p, { type: "updateTrack", trackId: "t3", changes: { mute: true } });
    expect(["track-1", "t2", "t3"].map((id) => isAudible(p, id))).toEqual([false, true, false]);
  });
});

describe("toEngineSnapshot", () => {
  it("resolves gain, pan, instrument and master volume", () => {
    let p = withTracks();
    p = run(p, { type: "updateTrack", trackId: "t2", changes: { volume: 50, pan: -50 } });
    p = run(p, { type: "setMasterVolume", volume: 100 });
    const s = toEngineSnapshot(p, new SlotAllocator());
    expect(s.masterGain).toBe(1);
    const drums = s.tracks.find((t) => t.instrument === "drums")!;
    expect(drums.gain).toBeCloseTo(volumeToGain(50));
    expect(drums.pan).toBe(-0.5);
    expect(s.tracks).toHaveLength(3);
  });
  it("sends gain 0 for silenced tracks and omits muted notes", () => {
    let p = withTracks();
    p = run(p, { type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "a", pitch: 60, startTick: 0, durationTicks: 240, velocity: 90 } });
    p = run(p, { type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "b", pitch: 62, startTick: 240, durationTicks: 240, velocity: 90, muted: true } });
    p = run(p, { type: "updateTrack", trackId: "t3", changes: { mute: true } });
    const s = toEngineSnapshot(p, new SlotAllocator());
    expect(s.tracks[0]!.notes.map((x) => x.pitch)).toEqual([60]);
    expect(s.tracks[2]!.gain).toBe(0);
  });
});

describe("SlotAllocator", () => {
  it("keeps slots stable across edits and reuses freed slots", () => {
    const slots = new SlotAllocator();
    let p = withTracks();
    slots.sync(p);
    expect([slots.slotFor("track-1"), slots.slotFor("t2"), slots.slotFor("t3")]).toEqual([0, 1, 2]);
    p = run(p, { type: "deleteTrack", trackId: "t2" });
    slots.sync(p);
    expect(slots.slotFor("t3")).toBe(2); // unchanged
    p = run(p, { type: "addTrack", track: createTrack("t4", "New", "synth", "#fb923c", "c4") });
    slots.sync(p);
    expect(slots.slotFor("t4")).toBe(1); // reused
    expect(slots.trackFor(1)).toBe("t4");
  });
});

describe("clips in the engine snapshot", () => {
  it("loops over the song length, not over the longest clip", () => {
    let p = createProject("p"); // 8-bar song, one 4-bar clip
    expect(toEngineSnapshot(p, new SlotAllocator()).loopTicks).toBe(8 * TICKS_PER_BAR);
    p = run(p, { type: "setSongLength", bars: 20 });
    expect(toEngineSnapshot(p, new SlotAllocator()).loopTicks).toBe(20 * TICKS_PER_BAR);
  });

  it("places notes of every clip at absolute song ticks (clip start + note start)", () => {
    let p = createProject("p");
    p = run(p, { type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "a", pitch: 60, startTick: 480, durationTicks: 240, velocity: 90 } });
    p = run(p, { type: "addClip", trackId: "track-1", clip: { id: "late", startTick: 5 * TICKS_PER_BAR, lengthTicks: 2 * TICKS_PER_BAR, notes: { b: { id: "b", pitch: 64, startTick: 960, durationTicks: 480, velocity: 100 } } } });
    const notes = toEngineSnapshot(p, new SlotAllocator()).tracks[0]!.notes.map((n) => [n.pitch, n.startTick]).sort();
    expect(notes).toEqual([[60, 480], [64, 5 * TICKS_PER_BAR + 960]]);
  });

  it("keeps a clip's notes silent when the track is muted, and a muted note out of the engine", () => {
    let p = createProject("p");
    p = run(p, { type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "a", pitch: 60, startTick: 0, durationTicks: 240, velocity: 90, muted: true } });
    expect(toEngineSnapshot(p, new SlotAllocator()).tracks[0]!.notes).toHaveLength(0);
  });
});

describe("sample tracks in the snapshot", () => {
  const sampleTrack = () => {
    const t = createTrack("ts", "Punch Kick", "sample", "#f97316", "cs");
    t.sample = { id: "starter/kick/punch-kick", name: "Punch Kick", gate: false };
    return t;
  };
  it("carries the file path and gate flag; a sound missing from the library is silent but present", () => {
    const p = run(createProject("p"), { type: "addTrack", track: sampleTrack() });
    const found = toEngineSnapshot(p, new SlotAllocator(), (id) => (id === "starter/kick/punch-kick" ? "C:/lib/Punch Kick.wav" : null));
    const t = found.tracks.find((x) => x.instrument === "sample")!;
    expect(t.samplePath).toBe("C:/lib/Punch Kick.wav");
    expect(t.gate).toBe(false);
    const missing = toEngineSnapshot(p, new SlotAllocator());
    expect(missing.tracks.find((x) => x.instrument === "sample")!.samplePath).toBeUndefined();
  });
  it("mute silences a sample track like any other", () => {
    let p = run(createProject("p"), { type: "addTrack", track: sampleTrack() });
    p = run(p, { type: "updateTrack", trackId: "ts", changes: { mute: true } });
    expect(toEngineSnapshot(p, new SlotAllocator()).tracks.find((x) => x.instrument === "sample")!.gain).toBe(0);
  });
});

describe("stretchRatioFor", () => {
  it("is the project tempo over the loop's own tempo, only when Fit is on and the tempo is known", async () => {
    const { stretchRatioFor } = await import("./snapshot");
    expect(stretchRatioFor(120, { bpm: 90, fit: true })).toBeCloseTo(4 / 3, 6);
    expect(stretchRatioFor(75, { bpm: 90, fit: true })).toBeCloseTo(75 / 90, 6);
    expect(stretchRatioFor(120, { bpm: 90, fit: false })).toBeNull();
    expect(stretchRatioFor(120, { fit: true })).toBeNull();
    expect(stretchRatioFor(90, { bpm: 90, fit: true })).toBeNull(); // same tempo: play as recorded
    expect(stretchRatioFor(300, { bpm: 40, fit: true })).toBe(4); // limited to what can be stretched
  });
  it("reaches the engine in the snapshot", () => {
    const t = createTrack("tl", "Loop", "sample", "#34d399", "cl");
    t.sample = { id: "x", name: "x", gate: true, bpm: 90, fit: true };
    const p = run(createProject("p"), { type: "addTrack", track: t });
    const snap = toEngineSnapshot(p, new SlotAllocator(), () => "C:/x.wav");
    expect(snap.tracks.find((x) => x.instrument === "sample")!.stretchRatio).toBeCloseTo(120 / 90, 6);
  });
});
