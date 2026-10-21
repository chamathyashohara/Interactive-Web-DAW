import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProgressStore } from "./progressStore";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "daw-progress-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("ProgressStore", () => {
  it("starts with nothing completed and the chosen default mode", () => {
    expect(new ProgressStore(tmp()).get()).toEqual({ mode: "all", completedLessons: [] });
    expect(new ProgressStore(tmp(), "beginner").get().mode).toBe("beginner");
  });

  it("records a lesson, persists it, and reports whether it was new", () => {
    const dir = tmp();
    const a = new ProgressStore(dir, "beginner");
    const first = a.completeLesson("M2.6");
    expect(first).toMatchObject({ ok: true, newlyCompleted: true });
    const again = a.completeLesson("M2.6");
    expect(again).toMatchObject({ ok: true, newlyCompleted: false });
    expect(a.get().completedLessons).toEqual(["M2.6"]); // idempotent: no duplicates

    const b = new ProgressStore(dir, "all"); // a new process: the saved mode wins over the default
    expect(b.get()).toEqual({ mode: "beginner", completedLessons: ["M2.6"] });
  });

  it("rejects things that are not lesson ids", () => {
    const s = new ProgressStore(tmp());
    for (const bad of ["", "lesson 1", "M0", "../x", 5, null, undefined, { id: "M0.1" }]) {
      expect(s.completeLesson(bad).ok).toBe(false);
    }
    expect(s.get().completedLessons).toEqual([]);
  });

  it("changes mode, ignores unknown modes, and persists", () => {
    const dir = tmp();
    const s = new ProgressStore(dir, "all");
    expect(s.setMode("beginner").mode).toBe("beginner");
    expect(s.setMode("expert").mode).toBe("beginner");
    expect(new ProgressStore(dir).get().mode).toBe("beginner");
  });

  it("reset forgets lessons but keeps the mode", () => {
    const s = new ProgressStore(tmp(), "beginner");
    s.completeLesson("M0.4");
    expect(s.reset()).toEqual({ mode: "beginner", completedLessons: [] });
  });

  it("survives a corrupt or hand-edited file", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "progress.json"), "{not json");
    expect(new ProgressStore(dir, "beginner").get()).toEqual({ mode: "beginner", completedLessons: [] });
    fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify({ mode: "weird", completedLessons: ["M1.1", "nope", "M1.1", 7] }));
    expect(new ProgressStore(dir, "all").get()).toEqual({ mode: "all", completedLessons: ["M1.1"] });
  });

  it("writes an anonymous event log (no names, no project content)", () => {
    const dir = tmp();
    let t = 1000;
    const s = new ProgressStore(dir, "beginner", () => (t += 10));
    s.completeLesson("M0.4");
    s.completeLesson("M0.4"); // not new: no second event
    s.setMode("all");
    const lines = fs.readFileSync(path.join(dir, "progress-events.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { t: "lesson.completed", lessonId: "M0.4", at: 1010 },
      { t: "mode.changed", mode: "all", at: 1020 },
    ]);
  });
});
