import { describe, expect, it } from "vitest";
import { MAX_TRACKS, TICKS_PER_BAR, applyOp, createProject, createTrack, type Op, type OpBody, type Project } from "@daw/shared";
import { runCheck } from "./checks";
import { LESSONS } from "./content";
import { chords1 } from "./content/chords-1";
import { findExercise, lessonClipId, lessonTrackId, resetExerciseOps, startExerciseOps } from "./setup";
import type { Exercise } from "./types";

let c = 0;
const newId = () => `id${++c}`;

function applyAll(p: Project, bodies: OpBody[]): Project {
  let out = p;
  for (const b of bodies) {
    const r = applyOp(out, { opId: `op${++c}`, clientId: "test", ...b } as Op);
    if (!r.ok) throw new Error(r.reason);
    out = r.project;
  }
  return out;
}

const exerciseOf = (lessonId: string): Exercise => {
  const step = LESSONS.find((l) => l.id === lessonId)!.steps.find((s) => s.kind === "exercise");
  if (step?.kind !== "exercise") throw new Error("no exercise");
  return step.exercise;
};
const ex = exerciseOf("chords-1");

describe("startExerciseOps", () => {
  it("adds a lesson track with the starter clip to a fresh project", () => {
    const p0 = createProject("p");
    const r = startExerciseOps(p0, chords1, ex, newId);
    if (!r.ok) throw new Error(r.reason);
    const p = applyAll(p0, r.ops);
    const found = findExercise(p, "chords-1")!;
    expect(found.track.name).toBe("Lesson: Chords");
    expect(found.track.instrument).toBe("synth");
    expect(found.clip.lengthTicks).toBe(4 * TICKS_PER_BAR);
    expect(Object.values(found.clip.notes).map((n) => n.pitch).sort()).toEqual([60, 64, 67]);
    expect(p.trackOrder).toEqual(["track-1", lessonTrackId("chords-1")]);
    expect(p.tracks["track-1"]).toEqual(p0.tracks["track-1"]); // the learner's own track is untouched
  });

  it("is the starting state the check expects: bar 1 right, the rest to do", () => {
    const p0 = createProject("p");
    const r = startExerciseOps(p0, chords1, ex, newId);
    if (!r.ok) throw new Error(r.reason);
    const result = runCheck(findExercise(applyAll(p0, r.ops), "chords-1")!.clip, ex.check);
    expect(result.items.map((i) => i.ok)).toEqual([true, false, false, false]);
  });

  it("reuses the existing exercise (no ops) so the learner keeps their work", () => {
    const p0 = createProject("p");
    const first = startExerciseOps(p0, chords1, ex, newId);
    if (!first.ok) throw new Error(first.reason);
    const again = startExerciseOps(applyAll(p0, first.ops), chords1, ex, newId);
    expect(again).toEqual({ ok: true, ops: [], trackId: first.trackId, clipId: first.clipId });
  });

  it("re-adds the clip if the learner deleted it but kept the track", () => {
    const p0 = createProject("p");
    const first = startExerciseOps(p0, chords1, ex, newId);
    if (!first.ok) throw new Error(first.reason);
    const p1 = applyAll(p0, [...first.ops, { type: "deleteClip", trackId: first.trackId, clipId: first.clipId }]);
    const r = startExerciseOps(p1, chords1, ex, newId);
    if (!r.ok) throw new Error(r.reason);
    expect(r.ops.map((o) => o.type)).toEqual(["addClip"]);
    expect(findExercise(applyAll(p1, r.ops), "chords-1")).not.toBeNull();
  });

  it("lengthens a song that is shorter than the exercise, before adding the track", () => {
    const p0 = applyAll(createProject("p"), [{ type: "updateClip", trackId: "track-1", clipId: "clip-1", changes: { lengthTicks: TICKS_PER_BAR } }, { type: "setSongLength", bars: 2 }]);
    const r = startExerciseOps(p0, chords1, ex, newId);
    if (!r.ok) throw new Error(r.reason);
    expect(r.ops.map((o) => o.type)).toEqual(["setSongLength", "addTrack"]);
    expect(applyAll(p0, r.ops).songBars).toBe(4);
  });

  it("refuses with a clear reason when the project already has the maximum number of tracks", () => {
    let p = createProject("p");
    for (let i = 2; i <= MAX_TRACKS; i++) p = applyAll(p, [{ type: "addTrack", track: createTrack(`t${i}`, `T${i}`, "synth", "#22d3ee", `c${i}`) }]);
    const r = startExerciseOps(p, chords1, ex, newId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`${MAX_TRACKS} tracks`);
  });
});

describe("resetExerciseOps", () => {
  it("restores the starter notes and clip length as one valid batch", () => {
    const p0 = createProject("p");
    const r = startExerciseOps(p0, chords1, ex, newId);
    if (!r.ok) throw new Error(r.reason);
    const p = applyAll(p0, r.ops);
    // The learner shortens the starter notes, adds one of their own, and shrinks the clip to 2 bars.
    const edited = applyAll(p, [
      ...Object.values(findExercise(p, "chords-1")!.clip.notes).map((n): OpBody => ({ type: "updateNote", trackId: r.trackId, clipId: r.clipId, noteId: n.id, changes: { durationTicks: 480 } })),
      { type: "addNote", trackId: r.trackId, clipId: r.clipId, note: { id: "x", pitch: 62, startTick: 960, durationTicks: 480, velocity: 96 } },
      { type: "updateClip", trackId: r.trackId, clipId: r.clipId, changes: { lengthTicks: 2 * TICKS_PER_BAR } },
    ]);
    const found = findExercise(edited, "chords-1")!;
    expect(found.clip.lengthTicks).toBe(2 * TICKS_PER_BAR);
    const reset = applyAll(edited, resetExerciseOps(found, found.clip, ex, newId));
    const clip = findExercise(reset, "chords-1")!.clip;
    expect(clip.lengthTicks).toBe(4 * TICKS_PER_BAR);
    expect(Object.values(clip.notes).map((n) => [n.pitch, n.startTick, n.durationTicks]).sort()).toEqual([
      [60, 0, TICKS_PER_BAR],
      [64, 0, TICKS_PER_BAR],
      [67, 0, TICKS_PER_BAR],
    ]);
  });
});

describe("lesson content", () => {
  it("lesson and lesson-track ids are unique", () => {
    const ids = LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(lessonClipId("chords-1")).not.toBe(lessonTrackId("chords-1"));
  });

  for (const lesson of LESSONS) {
    describe(lesson.id, () => {
      it("is plain data (survives a JSON round-trip unchanged)", () => {
        expect(JSON.parse(JSON.stringify(lesson))).toEqual(lesson);
      });

      it("has unique step ids and at least one exercise", () => {
        const ids = lesson.steps.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(lesson.steps.some((s) => s.kind === "exercise")).toBe(true);
      });

      for (const step of lesson.steps) {
        if (step.kind !== "exercise") continue;
        const e = step.exercise;
        it(`${step.id}: starter notes are visible in the piano roll and inside the clip`, () => {
          for (const n of e.starterNotes) {
            expect(n.pitch).toBeGreaterThanOrEqual(36); // piano roll shows C2..B5
            expect(n.pitch).toBeLessThanOrEqual(83);
            expect(n.startTick + n.durationTicks).toBeLessThanOrEqual(e.bars * TICKS_PER_BAR);
          }
          expect(e.hints.length).toBeGreaterThan(0);
        });
        it(`${step.id}: setup applies cleanly to a fresh project and the starting state does not already pass`, () => {
          const p0 = createProject("p");
          const r = startExerciseOps(p0, lesson, e, newId);
          if (!r.ok) throw new Error(r.reason);
          const clip = findExercise(applyAll(p0, r.ops), lesson.id)!.clip;
          expect(runCheck(clip, e.check).pass).toBe(false);
        });
      }
    });
  }
});
