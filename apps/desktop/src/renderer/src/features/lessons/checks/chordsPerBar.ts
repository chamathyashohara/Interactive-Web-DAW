import { TICKS_PER_BAR, type Clip, type Note } from "@daw/shared";
import { positionLabel } from "../theory";
import type { CheckResult, ChordAt, ChordTarget } from "../types";
import { compareChord, describeMismatch, notesHeardAt } from "./chordMatch";

/**
 * Notes heard on beat 1 of a bar: those starting in the bar's first beat (or just before it), plus notes still held
 * from the previous bar. Muted notes are ignored.
 */
export function notesOnBeatOne(notes: Note[], bar: number): Note[] {
  return notesHeardAt(notes, bar * TICKS_PER_BAR);
}

function finish(items: CheckResult["items"], problem: string | null, success: string): CheckResult {
  const correct = items.filter((i) => i.ok).length;
  const pass = correct === items.length;
  return { pass, score: items.length ? correct / items.length : 0, feedback: pass ? success : problem!, items };
}

/**
 * Pass when, for every bar, the pitch classes heard on beat 1 are exactly the target chord's. Inversions and octave
 * doublings are accepted (unless the chord names a `bass`); extra pitch classes are not. Score = correct bars / bars.
 */
export function checkChordsPerBar(clip: Clip, chords: ChordTarget[]): CheckResult {
  const notes = Object.values(clip.notes);
  const items: CheckResult["items"] = [];
  let firstProblem: string | null = null;

  chords.forEach((target, bar) => {
    const cmp = compareChord(notesOnBeatOne(notes, bar), target);
    items.push({ label: `Bar ${bar + 1}: ${target.name}`, ok: cmp.ok });
    if (!cmp.ok && firstProblem === null) firstProblem = describeMismatch(`Bar ${bar + 1}`, target, cmp);
  });

  return finish(items, firstProblem, chords.length === 1 ? `The chord is right: ${chords[0]!.name}.` : `All ${chords.length} chords are right: ${chords.map((c) => c.name).join(" → ")}.`);
}

/** Like `chordsPerBar`, but each chord is checked at its own moment (for example beats 1 and 3 of a bar). */
export function checkChordsAtTicks(clip: Clip, chords: ChordAt[]): CheckResult {
  const notes = Object.values(clip.notes);
  const items: CheckResult["items"] = [];
  let firstProblem: string | null = null;

  for (const target of chords) {
    const where = positionLabel(target.startTick);
    const cmp = compareChord(notesHeardAt(notes, target.startTick, target.window ?? 480), target);
    items.push({ label: `${where}: ${target.name}`, ok: cmp.ok });
    if (!cmp.ok && firstProblem === null) firstProblem = describeMismatch(where.charAt(0).toUpperCase() + where.slice(1), target, cmp);
  }

  return finish(items, firstProblem, `Every chord is in place: ${chords.map((c) => c.name).join(" → ")}.`);
}
