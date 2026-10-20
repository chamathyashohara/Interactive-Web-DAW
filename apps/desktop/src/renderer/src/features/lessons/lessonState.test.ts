import { describe, expect, it } from "vitest";
import { createLessonState, needsFreshClip } from "./lessonState";
import { memoryStore } from "./storage";
import { beatsLabel, timeTargets } from "./subLesson";
import { BUILT } from "./curriculum";

describe("lesson state (progress kept across the studio, other lessons and restarts)", () => {
  it("remembers the view, each sub-lesson's position and the pane settings, across a restart", () => {
    const store = memoryStore();
    const a = createLessonState(store);
    a.setView({ kind: "sub", id: "m3-major-triad" });
    a.saveSub("m3-major-triad", { stage: "practice", reached: 3, hints: 2, tryPassed: true, practicePassed: false, quickPicked: null, quickRight: false });
    a.savePane({ tool: "select", snap: false, gridTicks: 240, pxPerBeat: 100, rowH: 28 });
    const b = createLessonState(store);
    expect(b.view()).toEqual({ kind: "sub", id: "m3-major-triad" });
    expect(b.sub("m3-major-triad")).toMatchObject({ stage: "practice", hints: 2, tryPassed: true });
    expect(b.pane()).toMatchObject({ tool: "select", pxPerBeat: 100 });
    expect(b.sub("unknown")).toBeUndefined();
  });

  it("keeps each stage's notes separately and remembers who owns the shared clip", () => {
    const s = createLessonState(memoryStore());
    s.saveWork("m1-octaves", "practice", [{ pitch: 67, startTick: 0, durationTicks: 960 }]);
    s.saveWork("m1-octaves", "try", [{ pitch: 60, startTick: 0, durationTicks: 960 }]);
    expect(s.work("m1-octaves", "practice")).toEqual([{ pitch: 67, startTick: 0, durationTicks: 960 }]);
    expect(s.work("m1-octaves", "try")![0]!.pitch).toBe(60);
    expect(s.work("m1-semitones", "try")).toBeUndefined();
    s.setOwner({ subId: "m1-octaves", stage: "practice" });
    expect(s.owner()).toEqual({ subId: "m1-octaves", stage: "practice" });
  });

  it("only replaces the shared clip when it holds another stage or sub-lesson", () => {
    expect(needsFreshClip(null, "a", "try")).toBe(true);
    expect(needsFreshClip({ subId: "a", stage: "try" }, "a", "try")).toBe(false);
    expect(needsFreshClip({ subId: "a", stage: "try" }, "a", "practice")).toBe(true);
    expect(needsFreshClip({ subId: "b", stage: "try" }, "a", "try")).toBe(true);
  });
});

describe("where notes go (beat and bar guide)", () => {
  it("labels lengths in beats", () => {
    expect(beatsLabel(960)).toBe("1 beat");
    expect(beatsLabel(1920)).toBe("2 beats");
    expect(beatsLabel(480)).toBe("½ beat");
    expect(beatsLabel(1440)).toBe("1½ beats");
    expect(beatsLabel(3840)).toBe("4 beats");
  });

  it("reads positions and lengths from a placement check (the new Beats and bars lesson)", () => {
    const sub = BUILT["m0-beats-bars"]!;
    expect(timeTargets(sub.practice.check, sub.bars)).toEqual([
      { startTick: 0, durationTicks: 1920, label: "2 beats", hasLength: true },
      { startTick: 3840 + 2880, durationTicks: 960, label: "1 beat", hasLength: true },
    ]);
  });

  it("merges stacked notes (a chord) into one position, and marks each bar for chord checks", () => {
    const triad = BUILT["m3-major-triad"]!;
    expect(timeTargets(triad.practice.check, triad.bars).map((t) => [t.startTick, t.label])).toEqual([
      [0, "chord"],
      [3840, "chord"],
      [7680, "chord"],
      [11520, "chord"],
    ]);
    const intervals = BUILT["m3-intervals"]!;
    expect(timeTargets(intervals.practice.check, intervals.bars).map((t) => t.startTick)).toEqual([0, 1920, 3840]);
  });

  it("gives no positions when timing is free (a free melody), and combines checks", () => {
    expect(timeTargets(BUILT["m2-pentatonic"]!.practice.check, 2)).toEqual([]);
    const tempo = BUILT["m0-play-loop-tempo"]!;
    expect(timeTargets(tempo.practice.check, tempo.bars).map((t) => t.startTick)).toEqual([0, 960, 1920, 2880]);
  });
});
