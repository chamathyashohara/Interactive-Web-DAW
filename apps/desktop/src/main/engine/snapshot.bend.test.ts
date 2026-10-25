import { describe, expect, it } from "vitest";
import { applyOp, createProject, createTrack, type Op, type Project } from "@daw/shared";
import { SlotAllocator, toEngineSnapshot } from "./snapshot";

const run = (p: Project, body: object): Project => {
  const r = applyOp(p, { opId: `b${Math.random()}`, clientId: "c", ...body } as Op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const note = (id: string, bend?: { tick: number; semis: number }[]) => ({ id, pitch: 60, startTick: 480, durationTicks: 960, velocity: 90, ...(bend ? { bend } : {}) });

describe("pitch bend in the snapshot for the engine", () => {
  it("sends a synth note's curve as [ticks after the note starts, semitones] pairs", () => {
    const p = run(createProject("p"), { type: "addNote", trackId: "track-1", clipId: "clip-1", note: note("n", [{ tick: 0, semis: 0 }, { tick: 480, semis: 2.5 }]) });
    const notes = toEngineSnapshot(p, new SlotAllocator()).tracks[0]!.notes;
    expect(notes[0]).toMatchObject({ pitch: 60, startTick: 480 });
    expect(notes[0]!.bend).toEqual([[0, 0], [480, 2.5]]); // relative to the note, not the clip or the song
  });
  it("sends nothing for a plain note", () => {
    const p = run(createProject("p"), { type: "addNote", trackId: "track-1", clipId: "clip-1", note: note("n") });
    expect(toEngineSnapshot(p, new SlotAllocator()).tracks[0]!.notes[0]!.bend).toBeUndefined();
  });
  it("does not send a curve for tracks that cannot play one (drums, plugins)", () => {
    let p = run(createProject("p"), { type: "addTrack", track: createTrack("d", "Drums", "drums", "#ef4444", "cd") });
    p = run(p, { type: "addNote", trackId: "d", clipId: "cd", note: note("n", [{ tick: 0, semis: 0 }, { tick: 100, semis: 1 }]) });
    const drums = toEngineSnapshot(p, new SlotAllocator()).tracks.find((t) => t.instrument === "drums")!;
    expect(drums.notes[0]!.bend).toBeUndefined();
  });
});
