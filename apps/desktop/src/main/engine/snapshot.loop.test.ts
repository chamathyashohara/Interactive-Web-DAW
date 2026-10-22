import { describe, expect, it } from "vitest";
import { applyOp, createProject, TICKS_PER_BAR, type Op, type Project } from "@daw/shared";
import { SlotAllocator, toEngineSnapshot } from "./snapshot";

const run = (p: Project, body: object): Project => {
  const r = applyOp(p, { opId: `lp${Math.random()}`, clientId: "c", ...body } as Op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

describe("loop region in the snapshot", () => {
  it("sends the region, and nothing without one", () => {
    const p = createProject("p");
    expect(toEngineSnapshot(p, new SlotAllocator()).loopEndTick).toBeUndefined();
    const q = run(p, { type: "setLoop", loop: { startTick: TICKS_PER_BAR, endTick: TICKS_PER_BAR * 3 } });
    const s = toEngineSnapshot(q, new SlotAllocator());
    expect([s.loopStartTick, s.loopEndTick]).toEqual([TICKS_PER_BAR, TICKS_PER_BAR * 3]);
  });
  it("leaves out a region that the song has since become too short for", () => {
    let p = createProject("p");
    p = run(p, { type: "setLoop", loop: { startTick: TICKS_PER_BAR * 4, endTick: TICKS_PER_BAR * 6 } });
    p = run(p, { type: "setSongLength", bars: 4 });
    const s = toEngineSnapshot(p, new SlotAllocator());
    expect(s.loopEndTick).toBeUndefined();
    expect(s.loopTicks).toBe(TICKS_PER_BAR * 4);
  });
});
