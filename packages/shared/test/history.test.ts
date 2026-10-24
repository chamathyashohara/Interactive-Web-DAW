import { describe, expect, it } from "vitest";
import { History, type Op } from "../src";

const inv = (id: string): Op => ({ opId: id, clientId: "c", type: "setTempo", bpm: 100 });

describe("History", () => {
  it("merges same-group entries within the window, keeping the oldest inverse", () => {
    const h = new History();
    h.record([inv("a")], "tempo", 0);
    h.record([inv("b")], "tempo", 300);
    expect(h.popUndo()!.inverse[0]!.opId).toBe("a");
    expect(h.canUndo).toBe(false);
  });
  it("does not merge across the window or different groups", () => {
    const h = new History();
    h.record([inv("a")], "tempo", 0);
    h.record([inv("b")], "tempo", 5000);
    h.record([inv("c")], undefined, 5001);
    expect(h.popUndo()!.inverse[0]!.opId).toBe("c");
    expect(h.popUndo()!.inverse[0]!.opId).toBe("b");
    expect(h.popUndo()!.inverse[0]!.opId).toBe("a");
  });
  it("clears redo on a new record", () => {
    const h = new History();
    h.record([inv("a")], undefined, 0);
    h.pushRedo(h.popUndo()!);
    expect(h.canRedo).toBe(true);
    h.record([inv("b")], undefined, 10);
    expect(h.canRedo).toBe(false);
  });
});
