import { describe, expect, it } from "vitest";
import { createLessonEvents, type LessonCompletedEvent } from "./events";
import { memoryStore } from "./storage";
import { CSV_COLUMNS, createStudyLog } from "./studyLog";

function clock(start = Date.parse("2026-10-20T10:00:00.000Z")) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}
let id = 0;
const newId = () => `s${++id}`;

describe("studyLog", () => {
  it("records nothing without a study session", () => {
    const log = createStudyLog(memoryStore(), clock().now, newId);
    log.beginExercise("chords-1", 1, "build-progression");
    log.recordCheck(0.25, false);
    log.recordHint();
    expect(log.records()).toEqual([]);
  });

  it("rejects participant codes that look like names or emails", () => {
    const log = createStudyLog(memoryStore(), clock().now, newId);
    expect(log.startSession("Jane Doe").ok).toBe(false);
    expect(log.startSession("a@b.com").ok).toBe(false);
    expect(log.startSession("").ok).toBe(false);
    expect(log.startSession(" P07 ").ok).toBe(true);
    expect(log.session()?.participant).toBe("P07");
  });

  it("records attempts, scores, hints, resets and time until the pass", () => {
    const c = clock();
    const log = createStudyLog(memoryStore(), c.now, newId);
    log.startSession("P00");
    log.beginExercise("chords-1", 1, "build-progression");
    c.advance(30_000);
    log.recordCheck(0.25, false);
    log.recordHint();
    log.recordReset();
    c.advance(30_000);
    log.recordCheck(0.75, false);
    log.recordHint();
    c.advance(30_000);
    log.recordCheck(1, true);
    log.recordHint(); // after the pass: not counted
    const [r] = log.records();
    expect(r).toMatchObject({
      participant: "P00",
      lessonId: "chords-1",
      lessonVersion: 1,
      outcome: "passed",
      checks: 3,
      scores: [0.25, 0.75, 1],
      firstScore: 0.25,
      finalScore: 1,
      hintsShown: 2,
      resets: 1,
      durationMs: 90_000,
    });
  });

  it("continues the open record when the learner comes back to the same exercise", () => {
    const log = createStudyLog(memoryStore(), clock().now, newId);
    log.startSession("P01");
    log.beginExercise("chords-1", 1, "build-progression");
    log.recordCheck(0.5, false);
    log.beginExercise("chords-1", 1, "build-progression");
    expect(log.records()).toHaveLength(1);
    expect(log.records()[0]!.checks).toBe(1);
  });

  it("closes the open record as 'left' when the learner leaves or the session ends", () => {
    const log = createStudyLog(memoryStore(), clock().now, newId);
    log.startSession("P02");
    log.beginExercise("chords-1", 1, "build-progression");
    log.leaveExercise();
    log.beginExercise("chords-1", 1, "build-progression");
    log.endSession();
    expect(log.records().map((r) => r.outcome)).toEqual(["left", "left"]);
    expect(log.session()).toBeNull();
  });

  it("survives a restart, closing an interrupted record as 'abandoned' at its last activity", () => {
    const store = memoryStore();
    const c = clock();
    const log = createStudyLog(store, c.now, newId);
    log.startSession("P03");
    log.beginExercise("chords-1", 1, "build-progression");
    c.advance(20_000);
    log.recordCheck(0.5, false);
    c.advance(600_000); // app killed; time passes
    const reopened = createStudyLog(store, c.now, newId);
    const [r] = reopened.records();
    expect(r).toMatchObject({ outcome: "abandoned", checks: 1, durationMs: 20_000 });
    expect(reopened.session()?.participant).toBe("P03");
  });

  it("deletes one participant's data on withdrawal", () => {
    const log = createStudyLog(memoryStore(), clock().now, newId);
    log.startSession("P04");
    log.beginExercise("chords-1", 1, "build-progression");
    log.startSession("P05");
    log.beginExercise("chords-1", 1, "build-progression");
    expect(log.deleteParticipant("P04")).toBe(1);
    expect(log.records().map((r) => r.participant)).toEqual(["P05"]);
  });

  it("exports JSON without internal fields, and CSV with one row per record", () => {
    const log = createStudyLog(memoryStore(), clock().now, newId);
    log.startSession("P06");
    log.beginExercise("chords-1", 1, "build-progression");
    log.recordCheck(0.5, false);
    log.recordCheck(1, true);
    const json = JSON.parse(log.exportJson());
    expect(json.format).toBe("lessons-study-log");
    expect(json.records).toHaveLength(1);
    expect(json.records[0].lastActivityAt).toBeUndefined();
    const lines = log.exportCsv().trim().split("\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines[1]).toContain("P06");
    expect(lines[1]).toContain("0.5;1");
  });
});

describe("lesson-completed events", () => {
  const event: LessonCompletedEvent = {
    type: "lesson-completed",
    schema: 1,
    lessonId: "chords-1",
    lessonVersion: 1,
    concept: "chords",
    completedAt: "2026-10-20T10:00:00.000Z",
    trackId: "lesson-chords-1",
    clipId: "lesson-chords-1-clip",
  };

  it("notifies subscribers once and persists the completion", () => {
    const store = memoryStore();
    const events = createLessonEvents(store);
    const seen: LessonCompletedEvent[] = [];
    const off = events.onLessonCompleted((e) => seen.push(e));
    expect(events.complete(event)).toBe(true);
    expect(events.complete(event)).toBe(false);
    expect(seen).toEqual([event]);
    off();
    expect(createLessonEvents(store).completedLessons()).toEqual([event]);
    expect(createLessonEvents(store).isCompleted("chords-1")).toBe(true);
  });

  it("a failing subscriber does not stop the others", () => {
    const events = createLessonEvents(memoryStore());
    let called = false;
    events.onLessonCompleted(() => {
      throw new Error("boom");
    });
    events.onLessonCompleted(() => (called = true));
    const err = console.error;
    console.error = () => {};
    events.complete(event);
    console.error = err;
    expect(called).toBe(true);
  });
});
