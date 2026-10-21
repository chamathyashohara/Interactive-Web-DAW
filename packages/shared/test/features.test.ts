import { describe, expect, it } from "vitest";
import { FEATURES, LESSON_TITLES, defaultProgress, featureDef, isLessonId, isUnlocked, lockReason, unlockedByLesson, type Progress } from "../src";

const beginner = (completed: string[] = []): Progress => ({ mode: "beginner", completedLessons: completed });

describe("feature registry", () => {
  it("has unique ids and every non-starter feature names a valid lesson", () => {
    const ids = FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FEATURES) if (f.unlockedBy !== null) expect(isLessonId(f.unlockedBy)).toBe(true);
  });
  it("has a starter set that is enough to place, hear and remove notes", () => {
    const starter = FEATURES.filter((f) => f.unlockedBy === null).map((f) => f.id);
    expect(starter).toEqual(expect.arrayContaining(["transport.basic", "tool.draw", "tool.delete", "history.undo"]));
  });
  it("every lesson that unlocks something has a title for the lock message", () => {
    for (const f of FEATURES) if (f.unlockedBy) expect(LESSON_TITLES[f.unlockedBy], f.unlockedBy).toBeTruthy();
  });
  it("matches the unlock map in docs/lessons/CURRICULUM.md", () => {
    const map: Record<string, string | null> = {
      "tool.select": "M0.4", "snap.grid": "M0.4", "edit.clipboard": "M0.5", "key.help": "M2.6", "tool.paint": "M6.4", "edit.quantize": "M6.4",
      "tool.mute": "M7.4", "tool.slice": "M8.4", "tracks.multiple": "M4.6", "tracks.drums": "M6.2", "arrangement.clips": "M8.2",
      "mixer.panel": "M9.2", "mixer.muteSolo": "M9.4", "export.wav": "M10.3",
    };
    for (const [id, lesson] of Object.entries(map)) expect(featureDef(id as never).unlockedBy).toBe(lesson);
  });
});

describe("unlocking", () => {
  it("the default progress has everything available (until the lessons exist)", () => {
    const p = defaultProgress();
    expect(p.mode).toBe("all");
    for (const f of FEATURES) expect(isUnlocked(p, f.id)).toBe(true);
  });
  it("beginner mode keeps lesson-gated features locked and the starter set open", () => {
    const p = beginner();
    expect(isUnlocked(p, "tool.draw")).toBe(true);
    expect(isUnlocked(p, "tool.paint")).toBe(false);
    expect(isUnlocked(p, "export.wav")).toBe(false);
  });
  it("completing a lesson unlocks exactly its features", () => {
    const p = beginner(["M0.4"]);
    expect(isUnlocked(p, "tool.select")).toBe(true);
    expect(isUnlocked(p, "snap.grid")).toBe(true);
    expect(isUnlocked(p, "edit.clipboard")).toBe(false);
    expect(unlockedByLesson("M0.4").map((f) => f.id).sort()).toEqual(["snap.grid", "tool.select"]);
    expect(unlockedByLesson("M99.9")).toEqual([]);
  });
  it("lock messages name the lesson and its title", () => {
    expect(lockReason(beginner(), "tool.paint")).toBe("Locked. Unlocked by lesson M6.4: Variations and off-beats.");
    expect(lockReason(beginner(["M6.4"]), "tool.paint")).toBeNull();
    expect(lockReason(defaultProgress(), "tool.paint")).toBeNull();
  });
  it("validates lesson ids", () => {
    for (const ok of ["M0.1", "M3.4", "M10.3", "M11.4"]) expect(isLessonId(ok)).toBe(true);
    for (const bad of ["", "m0.1", "M0", "M0.1.2", "lesson1", "M100.1", 5, null]) expect(isLessonId(bad)).toBe(false);
  });
});
