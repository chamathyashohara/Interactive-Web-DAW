import { describe, expect, it } from "vitest";
import { applyOp, createProject, createTrack, type Op, type Project } from "@daw/shared";
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
