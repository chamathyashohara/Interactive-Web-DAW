import { describe, expect, it } from "vitest";
import { TICKS_PER_BAR, applyOp, createProject, type Clip, type Note, type Op, type OpBody, type Project } from "@daw/shared";
import { requiredTempo, runCheck } from "./checks";
import { MODULES, BUILT } from "./curriculum";
import { findExercise, startExerciseOps } from "./setup";
import { HINT_LABELS, WORKSPACE, hintGuide, practiceStep, stageSpeech, tryStep, watchEvents, wrongNoteColors } from "./subLesson";
import type { GuideNoteSpec, StarterNote, SubLesson } from "./types";
import { STAGES } from "./subLesson";

/**
 * Generic checks that every sub-lesson on the path must pass. They run each lesson's own model answers through its own
 * checks, so a wrong target, an unreachable goal or a goal that is already met at the start fails here, not in front of a learner.
 */

const BAR = TICKS_PER_BAR;
let n = 0;
const noteOf = (g: GuideNoteSpec | StarterNote): Note => ({ id: `t${++n}`, pitch: g.pitch, startTick: g.startTick, durationTicks: g.durationTicks, velocity: 96 });
const clipOf = (sub: SubLesson, notes: (GuideNoteSpec | StarterNote)[]): Clip => ({ id: "c", startTick: 0, lengthTicks: sub.bars * BAR, notes: Object.fromEntries(notes.map(noteOf).map((x) => [x.id, x])) });
const subs = Object.values(BUILT);

describe("every sub-lesson on the path", () => {
  it("is on the outline, in the outline's own words and module", () => {
    for (const sub of subs) {
      const m = MODULES.find((mod) => mod.items.some((i) => i.id === sub.id));
      expect(m, `${sub.id} is not on the learning path`).toBeDefined();
      expect(sub.title).toBe(m!.items.find((i) => i.id === sub.id)!.title);
      expect(sub.moduleId).toBe(m!.id);
    }
  });

  for (const done of ["m0", "m1"]) {
    it(`${done.toUpperCase()} is complete`, () => {
      for (const item of MODULES.find((m) => m.id === done)!.items) expect(BUILT[item.id], item.id).toBeDefined();
    });
  }

  for (const sub of subs) {
    describe(sub.id, () => {
      const ctxFor = (spec: SubLesson["tryIt"]["check"]) => ({ tempo: requiredTempo(spec) ?? 120 });

      it("is plain data and fully written", () => {
        expect(JSON.parse(JSON.stringify(sub))).toEqual(sub);
        expect(sub.hook.text.length).toBeGreaterThan(0);
        expect(sub.hook.headline.length).toBeGreaterThan(3);
        expect(sub.watch.steps.length).toBeGreaterThanOrEqual(3);
        for (const s of sub.watch.steps) expect(s.caption.length).toBeGreaterThan(15);
        expect(sub.recap.length).toBeGreaterThanOrEqual(2);
        expect(sub.tryIt.instruction.length).toBeGreaterThan(20);
        expect(sub.practice.task.length).toBeGreaterThan(20);
        expect(sub.practice.items.length).toBeGreaterThan(0);
        expect(sub.practice.hints.reminder.length).toBeGreaterThan(10);
        expect(sub.tryIt.tools.length).toBeGreaterThan(0);
        expect(sub.practice.tools.length).toBeGreaterThan(0);
        for (const stage of STAGES) expect(stageSpeech(sub, stage.id).length).toBeGreaterThan(0);
      });

      it("has a valid quick check with plausible wrong answers", () => {
        const q = sub.quickCheck;
        expect(q.options.length).toBeGreaterThanOrEqual(3);
        expect(new Set(q.options).size).toBe(q.options.length);
        expect(q.correct).toBeGreaterThanOrEqual(0);
        expect(q.correct).toBeLessThan(q.options.length);
        expect(q.explanation.length).toBeGreaterThan(10);
      });

      it("keeps every guide note inside the visible roll (C2-B5) and inside the clip", () => {
        const all = [...sub.hook.notes, ...sub.watch.steps.flatMap((s) => s.notes), ...(sub.tryIt.starter ?? []), ...sub.tryIt.ghost, ...(sub.practice.starter ?? []), ...sub.practice.hints.answer];
        for (const g of all) {
          expect(g.pitch).toBeGreaterThanOrEqual(36);
          expect(g.pitch).toBeLessThanOrEqual(83);
          expect(g.startTick).toBeGreaterThanOrEqual(0);
          expect(g.startTick + g.durationTicks).toBeLessThanOrEqual(sub.bars * BAR);
        }
        for (const row of sub.practice.hints.rows) expect(row).toBeGreaterThanOrEqual(36);
        for (const row of sub.practice.hints.rows) expect(row).toBeLessThanOrEqual(83);
      });

      it("Try: the finished state (the ghost notes) passes, the starting state does not, and following the ghosts shows nothing red", () => {
        const done = runCheck(clipOf(sub, sub.tryIt.ghost), sub.tryIt.check, ctxFor(sub.tryIt.check));
        expect(done.feedback.length).toBeGreaterThan(0);
        expect(done.pass, `ghost does not pass: ${done.feedback}`).toBe(true);
        const start = runCheck(clipOf(sub, sub.tryIt.starter ?? []), sub.tryIt.check, { tempo: 120 });
        expect(start.pass, "Try is already met at the start").toBe(false);
        expect(wrongNoteColors(clipOf(sub, sub.tryIt.ghost), sub.tryIt.allowedPitchClasses)).toEqual({});
        expect(wrongNoteColors(clipOf(sub, sub.tryIt.starter ?? []), sub.tryIt.allowedPitchClasses)).toEqual({});
      });

      it("Practice: the level-3 answer passes, the starting state does not, and the hint levels add what they promise", () => {
        const answer = runCheck(clipOf(sub, sub.practice.hints.answer), sub.practice.check, ctxFor(sub.practice.check));
        expect(answer.pass, `answer does not pass: ${answer.feedback}`).toBe(true);
        const start = runCheck(clipOf(sub, sub.practice.starter ?? []), sub.practice.check, { tempo: 120 });
        expect(start.pass, "Practice is already met at the start").toBe(false);
        expect(start.feedback.length).toBeGreaterThan(10);
        expect(hintGuide(sub, 1)).toEqual({});
        expect(hintGuide(sub, 2).notes).toBeUndefined();
        expect(hintGuide(sub, 3).notes).toHaveLength(sub.practice.hints.answer.length);
        expect(practiceStep(sub).exercise.hints).toHaveLength(HINT_LABELS.length);
        for (const h of practiceStep(sub).exercise.hints) expect(h.length).toBeGreaterThan(10);
      });

      it("Practice: the highlighted rows include every row the learner still has to fill", () => {
        if (!sub.practice.hints.rows.length) return;
        const given = new Set((sub.practice.starter ?? []).map((s) => `${s.pitch}@${s.startTick}`));
        for (const a of sub.practice.hints.answer) if (!given.has(`${a.pitch}@${a.startTick}`)) expect(sub.practice.hints.rows).toContain(a.pitch);
      });

      it("Watch: every step can be sounded", () => {
        for (const step of sub.watch.steps) {
          const events = watchEvents(step, 120);
          expect(events.length, `step has nothing to hear: ${step.caption}`).toBeGreaterThan(0);
        }
        for (const g of sub.hook.notes) expect(g.pitch).toBeGreaterThan(0);
        expect(sub.hook.notes.length).toBeGreaterThan(0);
      });

      it("the practice track applies cleanly: Try and Practice start states are valid ops", () => {
        const p0 = createProject("p");
        for (const step of [tryStep(sub), practiceStep(sub)]) {
          const r = startExerciseOps(p0, WORKSPACE, step.exercise, () => `x${++n}`);
          if (!r.ok) throw new Error(r.reason);
          let p: Project = p0;
          for (const b of r.ops as OpBody[]) {
            const res = applyOp(p, { opId: `o${++n}`, clientId: "t", ...b } as Op);
            if (!res.ok) throw new Error(res.reason);
            p = res.project;
          }
          const found = findExercise(p, WORKSPACE.id)!;
          expect(Object.keys(found.clip.notes)).toHaveLength(step.exercise.starterNotes.length);
          expect(found.clip.lengthTicks).toBe(sub.bars * BAR);
        }
      });
    });
  }
});
