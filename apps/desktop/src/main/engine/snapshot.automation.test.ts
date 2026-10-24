import { describe, expect, it } from "vitest";
import { applyOp, createProject, type Op, type Project } from "@daw/shared";
import { SlotAllocator, toEngineSnapshot } from "./snapshot";

let n = 0;
const run = (p: Project, body: object): Project => {
  const r = applyOp(p, { opId: `au${++n}`, clientId: "c", ...body } as Op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

describe("automation in the snapshot", () => {
  it("sends each curve as [tick, value] pairs on its track, and nothing for a track without curves", () => {
    let p = createProject("p");
    p = run(p, { type: "setAutomation", trackId: "track-1", param: "volume", points: [{ tick: 0, value: 0 }, { tick: 3840, value: 1 }] });
    p = run(p, { type: "setAutomation", trackId: "track-1", param: "filter", points: [{ tick: 960, value: 0.25 }] });
    const t = toEngineSnapshot(p, new SlotAllocator()).tracks[0]!;
    expect(t.automation).toEqual({ volume: [[0, 0], [3840, 1]], filter: [[960, 0.25]] });
    const none = toEngineSnapshot(createProject("q"), new SlotAllocator()).tracks[0]!;
    expect(none.automation).toBeUndefined();
  });
  it("removing a curve removes it from the snapshot", () => {
    let p = createProject("p");
    p = run(p, { type: "setAutomation", trackId: "track-1", param: "volume", points: [{ tick: 0, value: 0.5 }] });
    p = run(p, { type: "setAutomation", trackId: "track-1", param: "volume", points: null });
    expect(toEngineSnapshot(p, new SlotAllocator()).tracks[0]!.automation).toBeUndefined();
  });
});
