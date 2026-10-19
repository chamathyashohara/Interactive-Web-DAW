import { describe, expect, it } from "vitest";
import { PPQ, TICKS_PER_BAR, type Clip, type Note } from "@daw/shared";
import { LESSONS } from "../content";
import { midiEditing1 } from "../content/midi-editing-1";
import { startExerciseOps, findExercise } from "../setup";
import { applyOp, createProject, type Op } from "@daw/shared";
import type { CheckSpec } from "../types";
import { runCheck } from "./index";

const BAR = TICKS_PER_BAR;
let n = 0;
const note = (pitch: number, startTick: number, durationTicks = PPQ, extra: Partial<Note> = {}): Note => ({ id: `n${++n}`, pitch, startTick, durationTicks, velocity: 96, ...extra });
const clipOf = (bars: number, ...notes: Note[]): Clip => ({ id: "c", startTick: 0, lengthTicks: bars * BAR, notes: Object.fromEntries(notes.map((x) => [x.id, x])) });
const spec = (lessonId: string): CheckSpec => {
  const step = LESSONS.find((l) => l.id === lessonId)!.steps.find((s) => s.kind === "exercise");
  if (step?.kind !== "exercise") throw new Error("no exercise");
  return step.exercise.check;
};

describe("melodyInKey", () => {
  const s = spec("melody-1");
  const run = (...notes: Note[]) => runCheck(clipOf(2, ...notes), s);
  // C D E F G A B C: eight consecutive quarter notes, ending on C5.
  const tune = (pitches = [60, 62, 64, 65, 67, 69, 71, 72]) => pitches.map((p, i) => note(p, i * PPQ, PPQ));

  it("passes a stepwise white-key melody ending on C", () => {
    const r = run(...tune());
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
    expect(r.feedback).toBe("Nice melody: 8 notes, all in C major, ending on C.");
  });

  it("names an out-of-key note, where it is, and in-key neighbours", () => {
    const r = run(...tune([60, 62, 64, 66, 67, 69, 71, 72])); // F#4 on beat 4
    expect(r.pass).toBe(false);
    expect(r.feedback).toBe("F#4 at bar 1, beat 4 is not in C major. Try F or G.");
    expect(r.score).toBe(7 / 8);
  });

  it("suggests neighbours for a black key between two white keys a tone apart", () => {
    expect(run(...tune([60, 61, 64, 65, 67, 69, 71, 72])).feedback).toBe("C#4 at bar 1, beat 2 is not in C major. Try C or D.");
  });

  it("fails fewer notes than required and says how many", () => {
    const r = run(...tune([60, 62, 64, 65, 67, 69, 72]));
    expect(r.pass).toBe(false);
    expect(r.feedback).toBe("Your melody needs at least 8 notes; you have 7.");
    expect(r.score).toBe(7 / 8);
  });

  it("fails overlapping notes", () => {
    const notes = tune();
    notes[2]!.durationTicks = 2 * PPQ; // E4 rings into F4
    const r = run(...notes);
    expect(r.pass).toBe(false);
    expect(r.feedback).toContain("Two notes sound together at bar 1, beat 4");
  });

  it("requires the last note to be the home note", () => {
    const r = run(...tune([60, 62, 64, 65, 67, 69, 71, 69]));
    expect(r.pass).toBe(false);
    expect(r.feedback).toBe("End the melody on C, the home note of C major. It currently ends on A4.");
    expect(r.score).toBe(1);
  });

  it("accepts any octave of C at the end", () => {
    expect(run(...tune([72, 71, 69, 67, 65, 64, 62, 60])).pass).toBe(true);
  });

  it("ignores muted notes (a muted wrong note is not heard)", () => {
    expect(run(...tune(), note(66, 8 * PPQ, PPQ, { muted: true })).pass).toBe(true);
  });

  it("starting state (one C) fails with the note-count message", () => {
    expect(run(note(60, 0)).feedback).toBe("Your melody needs at least 8 notes; you have 1.");
  });
});

describe("drumPattern", () => {
  const s = spec("rhythm-1");
  const run = (...notes: Note[]) => runCheck(clipOf(1, ...notes), s);
  const kick = [0, 960, 1920, 2880].map((t) => note(36, t));
  const snare = [960, 2880].map((t) => note(38, t));
  const hat = [0, 480, 960, 1440, 1920, 2400, 2880, 3360].map((t) => note(42, t));

  it("passes the classic beat", () => {
    const r = run(...kick, ...snare, ...hat);
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
    expect(r.feedback).toBe("Every part is in place: Kick, Snare and Closed Hat.");
  });

  it("names the missing kick beat", () => {
    const r = run(...kick.slice(0, 3), ...snare, ...hat);
    expect(r.pass).toBe(false);
    expect(r.feedback).toBe("Kick: 3 of 4 found. Missing on beat 4.");
    expect(r.items[0]).toEqual({ label: "Kick: 3 of 4", ok: false });
  });

  it("names a missing offbeat hat in beginner words", () => {
    const r = run(...kick, ...snare, ...hat.filter((h) => h.startTick !== 1440));
    expect(r.feedback).toBe('Closed Hat: 7 of 8 found. Missing on the "and" of beat 2.');
  });

  it("fails an extra snare and says where", () => {
    const r = run(...kick, ...snare, note(38, 1920), ...hat);
    expect(r.pass).toBe(false);
    expect(r.feedback).toBe("Snare: extra hit on beat 3. Remove it.");
    expect(r.score).toBeCloseTo(14 / 15);
  });

  it("accepts notes slightly off the grid within the tolerance, rejects beyond it", () => {
    const wobble = kick.map((k) => ({ ...k, startTick: k.startTick + 50 }));
    expect(run(...wobble, ...snare, ...hat).pass).toBe(true);
    const late = kick.map((k, i) => (i === 0 ? { ...k, startTick: 120 } : k));
    expect(run(...late, ...snare, ...hat).pass).toBe(false);
  });

  it("does not let one note satisfy two expected onsets", () => {
    const r = run(...kick.slice(0, 3), note(36, 2880 - 40), ...snare, ...hat); // fine: 4 separate kicks
    expect(r.pass).toBe(true);
    const twoHatsOneNote = run(...kick, ...snare, ...hat.filter((h) => h.startTick !== 480)); // 480 and 0/960 are 480 apart
    expect(twoHatsOneNote.pass).toBe(false);
  });

  it("ignores drums that are not part of the pattern and muted hits", () => {
    expect(run(...kick, ...snare, ...hat, note(39, 0), note(36, 1000, PPQ, { muted: true })).pass).toBe(true);
  });

  it("repeats the pattern in every bar of a longer clip and says which bar", () => {
    const twoBars = clipOf(2, ...kick, ...snare, ...hat);
    const r = runCheck(twoBars, s);
    expect(r.pass).toBe(false);
    expect(r.feedback).toBe("Kick: 4 of 8 found. Missing on bar 2, beat 1; bar 2, beat 2; bar 2, beat 3; and 1 more.");
  });

  it("empty clip fails with score 0", () => {
    const r = run();
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
  });
});

describe("matchTarget", () => {
  const s = spec("midi-editing-1");
  const target = midiEditing1.steps.find((x) => x.kind === "exercise")!;
  if (target.kind !== "exercise") throw new Error("no exercise");
  const fixed = () => (s.kind === "matchTarget" ? s.target : []).map((t) => note(t.pitch, t.startTick, t.durationTicks, { velocity: 90 }));
  const run = (notes: Note[]) => runCheck(clipOf(2, ...notes), s);

  it("passes when the notes equal the target", () => {
    const r = run(fixed());
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
    expect(r.items.every((i) => i.ok)).toBe(true);
  });

  it("accepts small timing and length differences within tolerance and any velocity in range", () => {
    const notes = fixed().map((x, i) => ({ ...x, startTick: x.startTick + (i % 2 ? 20 : 0), durationTicks: x.durationTicks - 50, velocity: 60 + i * 7 }));
    expect(run(notes).pass).toBe(true);
  });

  it("the lesson's starting state fails, with all four problem types flagged", () => {
    const p0 = createProject("p");
    const r0 = startExerciseOps(p0, midiEditing1, target.exercise, () => `s${++n}`);
    if (!r0.ok) throw new Error(r0.reason);
    let p = p0;
    for (const b of r0.ops) {
      const res = applyOp(p, { opId: `o${++n}`, clientId: "t", ...b } as Op);
      if (!res.ok) throw new Error(res.reason);
      p = res.project;
    }
    const r = runCheck(findExercise(p, midiEditing1.id)!.clip, s);
    expect(r.pass).toBe(false);
    expect(r.items.map((i) => i.ok)).toEqual([false, false, false, false]);
    expect(r.feedback).toBe("The E4 at bar 1, beat 2 is not on the beat. Use Quantize, or drag it onto the beat.");
  });

  it("reports a long note with the way to fix it", () => {
    const notes = fixed();
    notes[2]!.durationTicks = 2880;
    const r = run(notes);
    expect(r.feedback).toBe("The G4 at bar 1, beat 3 is too long. Drag its right edge to shorten it.");
    expect(r.items.map((i) => i.ok)).toEqual([true, false, true, true]);
  });

  it("reports a short note", () => {
    const notes = fixed();
    notes[6]!.durationTicks = 480;
    expect(run(notes).feedback).toBe("The G4 at bar 2, beat 3 is too short. Drag its right edge to lengthen it.");
  });

  it("reports a loud and a quiet note, and counts them as not right in the score", () => {
    const notes = fixed();
    notes[5]!.velocity = 127;
    notes[0]!.velocity = 20;
    const r = run(notes);
    expect(r.pass).toBe(false);
    expect(r.feedback).toBe("The C4 at bar 1, beat 1 is too quiet (20). Change it in the velocity lane.");
    expect(r.score).toBe(5 / 7);
  });

  it("reports a doubled note as a duplicate", () => {
    const r = run([...fixed(), note(67, 5760, 1920, { velocity: 90 })]);
    expect(r.feedback).toBe("Two G4 notes are stacked at bar 2, beat 3. Delete one of them.");
    expect(r.items[3]!.ok).toBe(false);
  });

  it("reports a missing note and an extra one", () => {
    const missing = fixed().filter((x) => x.pitch !== 69);
    expect(run(missing).feedback).toBe("The A4 at bar 2, beat 2 is missing. Draw it back in.");
    expect(run([...fixed(), note(72, 0, 960, { velocity: 90 })]).feedback).toBe("The C5 at bar 1, beat 1 is not part of the tune. Delete it.");
  });

  it("ignores muted notes", () => {
    expect(run([...fixed(), note(72, 0, 960, { muted: true })]).pass).toBe(true);
  });

  it("empty clip fails with score 0", () => {
    const r = run([]);
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
  });
});
