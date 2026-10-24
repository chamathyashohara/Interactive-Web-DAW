import { describe, expect, it } from "vitest";
import { LESSONS } from "./content";
import { exerciseIndex, overallProgress, searchLessons, stepSpeechText } from "./learnModel";

describe("searchLessons", () => {
  const ids = (q: string) => searchLessons(LESSONS, q).map((l) => l.id);

  it("finds by title, case-insensitively", () => {
    expect(ids("CHORDS")).toEqual(["chords-1"]);
  });

  it("finds by topic words inside the lesson", () => {
    expect(ids("quantize")).toEqual(["midi-editing-1"]);
    expect(ids("snare")).toEqual(["rhythm-1"]);
  });

  it("requires every word and ranks title matches first", () => {
    expect(ids("melody key")).toEqual(["melody-1"]);
    expect(ids("melody")[0]).toBe("melody-1");
  });

  it("returns nothing for an empty or unmatched query", () => {
    expect(ids("   ")).toEqual([]);
    expect(ids("xylophone")).toEqual([]);
  });
});

describe("overallProgress", () => {
  it("counts completed lessons as a percentage", () => {
    expect(overallProgress(LESSONS, (id) => id === "chords-1")).toEqual({ done: 1, total: 4, percent: 25 });
    expect(overallProgress([], () => true)).toEqual({ done: 0, total: 0, percent: 0 });
  });
});

describe("stepSpeechText and exerciseIndex", () => {
  it("reads explain steps with their try-it line, and exercise steps by goal", () => {
    const chords = LESSONS[0]!;
    const first = stepSpeechText(chords.steps[0]!);
    expect(first.startsWith("What is a chord?")).toBe(true);
    expect(first).toContain("Try it:");
    expect(stepSpeechText(chords.steps[exerciseIndex(chords)]!)).toContain("Put G major in bar 2");
  });

  it("every lesson has exactly one exercise and a recap", () => {
    for (const l of LESSONS) {
      expect(l.steps.filter((s) => s.kind === "exercise")).toHaveLength(1);
      expect(exerciseIndex(l)).toBe(l.steps.length - 1);
      expect(l.recap.length).toBeGreaterThan(0);
    }
  });
});
