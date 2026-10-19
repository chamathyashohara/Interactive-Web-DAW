import { PPQ, TICKS_PER_BAR, type Clip, type Note } from "@daw/shared";
import { listWords, pitchClass, pitchClassName, pitchClassOf } from "../theory";
import type { CheckResult, ChordTarget } from "../types";

/** A chord may start up to a 32nd early (snap off) and a held note must ring a 16th into the bar to count there. */
const EARLY = PPQ / 8;
const HOLD = PPQ / 4;

/**
 * Notes heard on beat 1 of a bar: those starting in the bar's first beat (or just before it), plus notes still held
 * from the previous bar. Muted notes are ignored.
 */
export function notesOnBeatOne(notes: Note[], bar: number): Note[] {
  const start = bar * TICKS_PER_BAR;
  return notes.filter((n) => {
    if (n.muted) return false;
    const end = n.startTick + n.durationTicks;
    const startsHere = n.startTick >= start - EARLY && n.startTick < start + PPQ;
    const heldOver = n.startTick < start - EARLY && end > start + HOLD;
    return startsHere || heldOver;
  });
}

/** Distinct pitch classes, ordered from the lowest sounding note up (how the learner sees them in the roll). */
function pitchClassesLowToHigh(notes: Note[]): number[] {
  const out: number[] = [];
  for (const n of [...notes].sort((a, b) => a.pitch - b.pitch)) if (!out.includes(pitchClass(n.pitch))) out.push(pitchClass(n.pitch));
  return out;
}

function barFeedback(bar: number, target: ChordTarget, have: number[], want: number[]): string {
  const label = `Bar ${bar + 1} should be ${target.name} (${listWords(target.notes)}).`;
  if (have.length === 0) return `${label} It is still empty.`;
  const missing = want.filter((pc) => !have.includes(pc)).map(pitchClassName);
  const extra = have.filter((pc) => !want.includes(pc)).map(pitchClassName);
  const haveText = `You have ${listWords(have.map(pitchClassName))}`;
  if (missing.length === 1 && extra.length === 1) return `${label} ${haveText}: change ${extra[0]} to ${missing[0]}.`;
  const parts: string[] = [];
  if (extra.length) parts.push(`${listWords(extra)} ${extra.length > 1 ? "don't" : "doesn't"} belong in this chord`);
  if (missing.length) parts.push(`${listWords(missing)} ${missing.length > 1 ? "are" : "is"} missing`);
  return `${label} ${haveText}: ${parts.join(", and ")}.`;
}

/**
 * Pass when, for every bar, the pitch classes heard on beat 1 are exactly the target chord's. Inversions and octave
 * doublings are accepted; extra pitch classes are not. Score = correct bars / bars.
 */
export function checkChordsPerBar(clip: Clip, chords: ChordTarget[]): CheckResult {
  const notes = Object.values(clip.notes);
  const items: CheckResult["items"] = [];
  let firstProblem: string | null = null;

  chords.forEach((target, bar) => {
    const want = target.notes.map((name) => {
      const pc = pitchClassOf(name);
      if (pc === null) throw new Error(`Unknown note name "${name}" in chord ${target.name}`);
      return pc;
    });
    const have = pitchClassesLowToHigh(notesOnBeatOne(notes, bar));
    const ok = have.length === want.length && want.every((pc) => have.includes(pc));
    items.push({ label: `Bar ${bar + 1}: ${target.name}`, ok });
    if (!ok && firstProblem === null) firstProblem = barFeedback(bar, target, have, want);
  });

  const correct = items.filter((i) => i.ok).length;
  const pass = correct === chords.length;
  return {
    pass,
    score: chords.length ? correct / chords.length : 0,
    feedback: pass ? `All ${chords.length} chords are right: ${chords.map((c) => c.name).join(" → ")}.` : firstProblem!,
    items,
  };
}
