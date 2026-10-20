import { describe, expect, it } from "vitest";
import { TICKS_PER_BAR, applyOp, createProject, type Clip, type Note, type Op, type OpBody, type Project } from "@daw/shared";
import { runCheck } from "./checks";
import { checkRootNotes } from "./checks/rootNotes";
import { BUILT, EARLIER_LESSONS, MODULES, isBuilt, moduleProgress, searchPath } from "./curriculum";
import { m3RootNote as sub } from "./content/m3-root-note";
import { findExercise, resetExerciseOps, startExerciseOps } from "./setup";
import { HINT_LABELS, STAGES, WORKSPACE, WRONG_NOTE_COLOR, hintGuide, practiceStep, stageSpeech, toGuideNotes, tryStep, watchEvents, watchStepMs, wrongNoteColors } from "./subLesson";
import type { GuideNoteSpec, RootChord } from "./types";

const BAR = TICKS_PER_BAR;
let n = 0;
const note = (pitch: number, startTick: number, durationTicks = 1920, extra: Partial<Note> = {}): Note => ({ id: `n${++n}`, pitch, startTick, durationTicks, velocity: 96, ...extra });
const clipOf = (...notes: Note[]): Clip => ({ id: "c", startTick: 0, lengthTicks: 4 * BAR, notes: Object.fromEntries(notes.map((x) => [x.id, x])) });
const fromSpecs = (specs: GuideNoteSpec[]) => specs.map((s) => note(s.pitch, s.startTick, s.durationTicks));
const chords = (sub.practice.check.kind === "rootNotes" ? sub.practice.check.chords : []) as RootChord[];

describe("rootNotes check", () => {
  const run = (...notes: Note[]) => checkRootNotes(clipOf(...notes), chords);
  const roots = () => [note(60, 0), note(67, BAR), note(65, 2 * BAR), note(69, 3 * BAR)];

  it("passes one root per bar, in any octave", () => {
    expect(run(...roots()).pass).toBe(true);
    expect(run(note(48, 0), note(79, BAR), note(53, 2 * BAR), note(81, 3 * BAR)).pass).toBe(true);
  });

  it("says what to do for an empty bar", () => {
    const r = run(roots()[0]!);
    expect(r.feedback).toBe("Bar 2 is G major. Place its root note, G, on beat 1.");
    expect(r.score).toBe(0.25);
  });

  it("tells a chord tone that is not the root apart from a note that is not in the chord", () => {
    expect(run(note(60, 0), note(71, BAR)).feedback).toBe("Bar 2 is G major. B is part of G major, but it is not the root. The root is the note the chord is named after: G.");
    expect(run(note(60, 0), note(66, BAR)).feedback).toBe("Bar 2 is G major. F# is not even in G major. The root is the letter in the chord's name: G.");
  });

  it("asks for only the root when the whole chord is placed", () => {
    const r = run(note(60, 0), note(64, 0), note(67, 0));
    expect(r.pass).toBe(false);
    expect(r.feedback).toBe("Bar 1 is C major. You have E and G as well as the root. For now place only the root, C.");
  });

  it("ignores muted notes and fails an empty clip", () => {
    expect(run(...roots(), note(64, 0, 1920, { muted: true })).pass).toBe(true);
    expect(run().score).toBe(0);
  });
});

describe("M3 'The root note' sub-lesson data", () => {
  it("is plain data", () => {
    expect(JSON.parse(JSON.stringify(sub))).toEqual(sub);
  });

  it("has every stage's content and a valid quick check", () => {
    expect(sub.watch.steps.length).toBeGreaterThanOrEqual(3);
    expect(sub.quickCheck.options.length).toBeGreaterThanOrEqual(3);
    expect(sub.quickCheck.correct).toBeGreaterThanOrEqual(0);
    expect(sub.quickCheck.correct).toBeLessThan(sub.quickCheck.options.length);
    expect(sub.recap.length).toBeGreaterThan(0);
    expect(sub.practice.items).toHaveLength(chords.length);
  });

  it("keeps every guide note inside the visible piano roll (C2-B5) and inside the clip", () => {
    const all = [...sub.hook.notes, ...sub.watch.steps.flatMap((s) => s.notes), ...sub.tryIt.ghost, ...sub.practice.hints.answer];
    for (const g of all) {
      expect(g.pitch).toBeGreaterThanOrEqual(36);
      expect(g.pitch).toBeLessThanOrEqual(83);
      expect(g.startTick + g.durationTicks).toBeLessThanOrEqual(sub.bars * BAR);
    }
    for (const row of sub.practice.hints.rows) expect(row).toBeGreaterThanOrEqual(36);
  });

  it("Try: the ghost notes satisfy the Try check; an empty roll does not; nothing is red when the ghosts are followed", () => {
    const clip = clipOf(...fromSpecs(sub.tryIt.ghost));
    expect(runCheck(clip, sub.tryIt.check).pass).toBe(true);
    expect(runCheck(clipOf(), sub.tryIt.check).pass).toBe(false);
    expect(wrongNoteColors(clip, sub.tryIt.allowedPitchClasses)).toEqual({});
  });

  it("Practice: level-3 answer passes the check, a blank roll does not, and each hint level adds what it says", () => {
    expect(runCheck(clipOf(...fromSpecs(sub.practice.hints.answer)), sub.practice.check).pass).toBe(true);
    expect(runCheck(clipOf(), sub.practice.check).pass).toBe(false);
    expect(hintGuide(sub, 0)).toEqual({});
    expect(hintGuide(sub, 1)).toEqual({});
    expect(hintGuide(sub, 2).rows).toEqual(sub.practice.hints.rows);
    expect(hintGuide(sub, 2).notes).toBeUndefined();
    expect(hintGuide(sub, 3).notes).toHaveLength(sub.practice.hints.answer.length);
    expect(practiceStep(sub).exercise.hints).toHaveLength(HINT_LABELS.length);
    expect(practiceStep(sub).exercise.starterNotes).toEqual([]);
    expect(tryStep(sub).exercise.starterNotes).toEqual([]);
  });

  it("the highlighted rows contain the rows of the answer", () => {
    for (const a of sub.practice.hints.answer) expect(sub.practice.hints.rows).toContain(a.pitch);
  });

  it("the Try and Practice steps start from blank clips that do not already pass", () => {
    const p0 = createProject("p");
    for (const step of [tryStep(sub), practiceStep(sub)]) {
      const r = startExerciseOps(p0, WORKSPACE, step.exercise, () => `x${++n}`);
      if (!r.ok) throw new Error(r.reason);
      let p: Project = p0;
      for (const b of r.ops) {
        const res = applyOp(p, { opId: `o${++n}`, clientId: "t", ...b } as Op);
        if (!res.ok) throw new Error(res.reason);
        p = res.project;
      }
      expect(runCheck(findExercise(p, WORKSPACE.id)!.clip, step.exercise.check).pass).toBe(false);
    }
  });

  it("Try then Practice share one lesson track, and a reset empties it", () => {
    const p0 = createProject("p");
    const start = startExerciseOps(p0, WORKSPACE, tryStep(sub).exercise, () => `x${++n}`);
    if (!start.ok) throw new Error(start.reason);
    const apply = (p: Project, bodies: OpBody[]) => bodies.reduce((acc, b) => {
      const res = applyOp(acc, { opId: `o${++n}`, clientId: "t", ...b } as Op);
      if (!res.ok) throw new Error(res.reason);
      return res.project;
    }, p);
    let p = apply(p0, start.ops);
    p = apply(p, sub.tryIt.ghost.map((g, i): OpBody => ({ type: "addNote", trackId: start.trackId, clipId: start.clipId, note: { id: `g${i}`, pitch: g.pitch, startTick: g.startTick, durationTicks: g.durationTicks, velocity: 96 } })));
    expect(startExerciseOps(p, WORKSPACE, practiceStep(sub).exercise, () => "x")).toMatchObject({ ok: true, ops: [] });
    const found = findExercise(p, WORKSPACE.id)!;
    p = apply(p, resetExerciseOps(found, found.clip, practiceStep(sub).exercise, () => `x${++n}`));
    expect(Object.keys(findExercise(p, WORKSPACE.id)!.clip.notes)).toHaveLength(0);
  });
});

describe("major/minor third feedback", () => {
  const bar1 = (...pitches: number[]) => clipOf(...pitches.map((p) => note(p, 0)));
  it("names the third that makes a chord minor and says which way to move it", () => {
    const r = runCheck(bar1(60, 63, 67), { kind: "chordsPerBar", chords: [{ name: "C major", notes: ["C", "E", "G"] }] });
    expect(r.feedback).toBe("Bar 1 should be C major (C, E and G). E♭ makes it minor: raise it one row (a semitone) to E.");
  });
  it("and the other way round", () => {
    const r = runCheck(bar1(60, 64, 67), { kind: "chordsPerBar", chords: [{ name: "C minor", notes: ["C", "Eb", "G"] }] });
    expect(r.feedback).toBe("Bar 1 should be C minor (C, E♭ and G). E makes it major: lower it one row (a semitone) to E♭.");
  });
  it("uses sharps the way the chord is spelled (A major vs A minor)", () => {
    const r = runCheck(bar1(57, 60, 64), { kind: "chordsPerBar", chords: [{ name: "A major", notes: ["A", "C#", "E"] }] });
    expect(r.feedback).toBe("Bar 1 should be A major (A, C# and E). C makes it minor: raise it one row (a semitone) to C#.");
  });
  it("explains a wrong bottom note for an inversion", () => {
    const r = runCheck(bar1(60, 64, 67), { kind: "chordsPerBar", chords: [{ name: "C major", notes: ["C", "E", "G"], bass: "E" }] });
    expect(r.feedback).toBe("Bar 1 should be C major (C, E and G) with E at the bottom. Your lowest note is C. Make E the lowest note by moving it below the others.");
  });
});

describe("sub-lesson helpers", () => {
  it("turns specs into guide notes: ghosts are dashed, roots are marked", () => {
    const g = toGuideNotes(sub.tryIt.ghost, true);
    expect(g.map((x) => x.style)).toEqual(["ghost-root", "ghost", "ghost"]);
    expect(g[0]!.label).toBe("root");
    expect(toGuideNotes(sub.hook.notes, false).map((x) => x.style)).toEqual(["root", "demo", "demo"]);
  });

  it("turns notes outside the allowed pitch classes red immediately, ignoring muted ones", () => {
    const wrong = note(61, 0); // C#
    const colours = wrongNoteColors(clipOf(note(60, 0), wrong, note(66, 0, 960, { muted: true })), ["C", "E", "G"]);
    expect(colours).toEqual({ [wrong.id]: WRONG_NOTE_COLOR });
  });

  it("sounds a watch step's listed pitches at the project tempo, and lingers long enough to read", () => {
    const step = sub.watch.steps[1]!;
    expect(watchEvents(step, 120).map((e) => e.pitch)).toEqual([60, 64, 67]);
    expect(watchEvents({ ...step, play: [60] }, 120).map((e) => e.pitch)).toEqual([60]);
    expect(watchEvents(step, 120)[0]!.duration).toBe(1);
    expect(watchStepMs({ caption: "short", notes: [] })).toBe(3000);
    expect(watchStepMs({ caption: "x".repeat(100), notes: [] })).toBe(5500);
  });

  it("has the seven-stage flow minus the embedded Feedback stage, in order", () => {
    expect(STAGES.map((s) => s.id)).toEqual(["hook", "watch", "try", "practice", "quick", "done"]);
    for (const s of STAGES) expect(stageSpeech(sub, s.id).length).toBeGreaterThan(0);
  });
});

describe("curriculum", () => {
  it("matches the outline: M0-M5 and their sub-lesson counts", () => {
    expect(MODULES.map((m) => [m.code, m.items.length])).toEqual([["M0", 6], ["M1", 6], ["M2", 7], ["M3", 8], ["M4", 6], ["M5", 5]]);
  });

  it("has unique ids, and every built sub-lesson is on the path", () => {
    const ids = MODULES.flatMap((m) => m.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of Object.keys(BUILT)) expect(ids).toContain(id);
    expect(isBuilt("m3-root-note")).toBe(true);
    expect(isBuilt("m3-intervals")).toBe(true);
    expect(isBuilt("m5-motif")).toBe(true);
    expect(isBuilt("m9-nothing")).toBe(false);
  });

  it("does not reuse an id of the earlier lessons", () => {
    const ids = new Set(MODULES.flatMap((m) => m.items.map((i) => i.id)));
    for (const l of EARLIER_LESSONS) expect(ids.has(l.id)).toBe(false);
  });

  it("searches built and planned sub-lessons and the earlier lessons", () => {
    expect(searchPath("root")[0]).toMatchObject({ kind: "sub", id: "m3-root-note", built: true });
    expect(searchPath("motif")[0]).toMatchObject({ kind: "sub", built: true });
    expect(searchPath("pentatonic")[0]).toMatchObject({ kind: "sub", built: true });
    expect(searchPath("snare")[0]).toMatchObject({ kind: "earlier", id: "rhythm-1" });
    expect(searchPath("chords m3").length).toBeGreaterThan(1);
    expect(searchPath("")).toEqual([]);
  });

  it("counts module progress over built sub-lessons", () => {
    const m3 = MODULES.find((m) => m.id === "m3")!;
    expect(moduleProgress(m3, () => false)).toMatchObject({ done: 0, total: 8 });
    expect(moduleProgress(m3, (id) => id === "m3-root-note").done).toBe(1);
  });
});
