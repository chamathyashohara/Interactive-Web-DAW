import { describe, expect, it } from "vitest";
import { activeMs, computeMetrics, eventsToCsv, metricsToCsv, type TelemetryEvent } from "../src";

const ev = (t: string, at: number, extra: Record<string, string | number | boolean | null> = {}, mode: "beginner" | "all" = "beginner"): TelemetryEvent => ({ t, at, s: "s1", mode, ...extra });
const S = 1000;

describe("active time", () => {
  it("adds the gaps between events but ignores pauses over a minute", () => {
    expect(activeMs([ev("a", 0), ev("b", 10 * S), ev("c", 20 * S), ev("d", 500 * S), ev("e", 505 * S)])).toBe(25 * S);
  });
  it("is zero for no events or one event", () => {
    expect(activeMs([])).toBe(0);
    expect(activeMs([ev("a", 5)])).toBe(0);
  });
});

describe("note accuracy", () => {
  const notes = (flags: (boolean | null)[]) => flags.map((k, i) => ev("note.added", i * S, { inKey: k, kind: "synth" }));
  it("counts only notes that had a key to be judged against", () => {
    const m = computeMetrics(notes([true, false, null, true, true]));
    expect(m.notesAdded).toBe(5);
    expect(m.keyedNotes).toBe(4);
    expect(m.outOfKeyNotes).toBe(1);
    expect(m.outOfKeyRate).toBe(0.25);
  });
  it("compares the first and last third of the notes: do mistakes fall with practice?", () => {
    const m = computeMetrics(notes([false, false, true, true, false, true, true, true, true]));
    expect(m.outOfKeyRateFirstThird).toBeCloseTo(2 / 3);
    expect(m.outOfKeyRateLastThird).toBe(0);
  });
  it("does not report a trend from only a few notes", () => {
    expect(computeMetrics(notes([true, false, true])).outOfKeyRateFirstThird).toBeNull();
  });
});

describe("corrections", () => {
  it("measures how quickly red notes are fixed, and how", () => {
    const events = [
      ev("note.added", 0, { inKey: false }), ev("note.added", 1, { inKey: false }), ev("note.added", 2, { inKey: false }), ev("note.added", 3, { inKey: true }),
      ev("note.corrected", 4, { ms: 4000, via: "manual" }), ev("note.corrected", 5, { ms: 8000, via: "fix" }),
    ];
    const m = computeMetrics(events);
    expect(m.corrected).toBe(2);
    expect(m.correctedShare).toBeCloseTo(2 / 3);
    expect(m.medianCorrectionMs).toBe(6000);
    expect(m.correctionsByVia).toEqual({ manual: 1, fix: 1 });
  });
});

describe("editing and locked features", () => {
  it("counts edits per active minute, undo and redo, and attempts on locked controls by lesson", () => {
    const events = [ev("edit", 0, { op: "addNote" }), ev("edit", 30 * S, { op: "addNote" }), ev("history", 40 * S, { kind: "undo" }), ev("ui.locked", 50 * S, { lesson: "M8.2" }), ev("ui.locked", 55 * S, { lesson: "M8.2" }), ev("ui.locked", 56 * S, { lesson: "M6.4" })];
    const m = computeMetrics(events);
    expect(m.edits).toBe(2);
    expect(m.undos).toBe(1);
    expect(m.lockedAttempts).toBe(3);
    expect(m.lockedByLesson).toEqual({ "M8.2": 2, "M6.4": 1 });
    expect(m.editsPerActiveMinute).toBeCloseTo(2 / (56 / 60));
  });
});

describe("feature adoption", () => {
  it("reports how long after a lesson unlocked a feature the learner first used it", () => {
    const events = [ev("lesson.completed", 1000, { lessonId: "M8.2" }), ev("ui.tool", 3000, { tool: "paint" }), ev("edit", 9000, { op: "setLoop" }), ev("edit", 20000, { op: "setLoop" })];
    const m = computeMetrics(events);
    const loop = m.adoption.find((a) => a.feature === "arrangement.loop")!;
    expect(loop.latencyMs).toBe(8000);
    expect(m.adoption.find((a) => a.feature === "arrangement.clips")!.latencyMs).toBeNull(); // never used
    expect(m.lessonsCompleted).toEqual(["M8.2"]);
  });
  it("ignores use from before the unlock", () => {
    const m = computeMetrics([ev("edit", 500, { op: "setLoop" }), ev("lesson.completed", 1000, { lessonId: "M8.2" })]);
    expect(m.adoption.find((a) => a.feature === "arrangement.loop")!.firstUseAt).toBeNull();
  });
});

describe("study conditions", () => {
  it("separates the numbers for beginner mode and all-features mode", () => {
    const m = computeMetrics([ev("note.added", 0, { inKey: false }, "all"), ev("note.added", 1, { inKey: false }, "all"), ev("note.added", 2, { inKey: true }, "beginner"), ev("note.added", 3, { inKey: true }, "beginner")]);
    expect(m.byMode.all!.outOfKeyRate).toBe(1);
    expect(m.byMode.beginner!.outOfKeyRate).toBe(0);
  });
});

describe("CSV", () => {
  it("writes one row per event with a column for every field, quoting where needed", () => {
    const csv = eventsToCsv([ev("edit", 2000, { op: "addNote", n: 1 }), ev("ui.tool", 1000, { tool: "a,b" })]).trim().split("\n");
    expect(csv[0]).toBe("at,iso,s,mode,t,n,op,tool");
    expect(csv[1]).toContain('"a,b"'); // sorted by time: the tool event first
    expect(csv[2]).toContain("addNote");
  });
  it("writes the metrics as name,value rows", () => {
    const csv = metricsToCsv(computeMetrics([ev("edit", 0, { op: "addNote" })]));
    expect(csv.startsWith("metric,value\n")).toBe(true);
    expect(csv).toContain("edits,1");
  });
});
