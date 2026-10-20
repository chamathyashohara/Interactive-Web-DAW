import { PPQ, type Note } from "@daw/shared";
import { listWords, pitchClass, pitchClassName, pitchClassOf } from "../theory";
import type { ChordTarget } from "../types";

/** Shared by the chord checks: which notes are heard at a moment, and what to say when they are not the chord. */

/** A chord may start up to a 32nd early (snap off) and a held note must ring a 16th into the moment to count there. */
export const EARLY = PPQ / 8;
export const HOLD = PPQ / 4;

/**
 * Notes heard at `tick`: those starting within `window` ticks after it (or just before it), plus notes still held from
 * earlier. Muted notes are ignored.
 */
export function notesHeardAt(notes: Note[], tick: number, window = PPQ): Note[] {
  return notes.filter((n) => {
    if (n.muted) return false;
    const end = n.startTick + n.durationTicks;
    const startsHere = n.startTick >= tick - EARLY && n.startTick < tick + window;
    const heldOver = n.startTick < tick - EARLY && end > tick + HOLD;
    return startsHere || heldOver;
  });
}

export function chordPcs(target: ChordTarget): number[] {
  return target.notes.map((name) => {
    const pc = pitchClassOf(name);
    if (pc === null) throw new Error(`Unknown note name "${name}" in chord ${target.name}`);
    return pc;
  });
}

/** Distinct pitch classes, ordered from the lowest sounding note up (how the learner sees them in the roll). */
export function pitchClassesLowToHigh(notes: Note[]): number[] {
  const out: number[] = [];
  for (const n of [...notes].sort((a, b) => a.pitch - b.pitch)) if (!out.includes(pitchClass(n.pitch))) out.push(pitchClass(n.pitch));
  return out;
}

/** Display spelling: "Eb" -> "E♭" (data uses plain "b" so it is easy to type). */
export const pretty = (name: string) => (name.length === 2 && name.endsWith("b") ? `${name[0]}♭` : name);

/** "E" lowered by a semitone is "E♭", "C#" becomes "C"; falls back to the sharp name when that would need a double accidental. */
function lowered(name: string, pc: number): string {
  if (name.endsWith("#")) return name.slice(0, -1);
  if (name.endsWith("b") || name.endsWith("♭")) return pitchClassName(pc);
  return `${name}♭`;
}
function raised(name: string, pc: number): string {
  if (name.endsWith("b") || name.endsWith("♭")) return name.slice(0, -1);
  if (name.endsWith("#")) return pitchClassName(pc);
  return `${name}#`;
}

export interface ChordComparison {
  ok: boolean;
  have: number[];
  want: number[];
  /** Set when the target names a bass note. */
  bassOk: boolean | null;
}

export function compareChord(heard: Note[], target: ChordTarget): ChordComparison {
  const want = chordPcs(target);
  const have = pitchClassesLowToHigh(heard);
  const sameSet = have.length === want.length && want.every((pc) => have.includes(pc));
  const bassPc = target.bass ? pitchClassOf(target.bass) : null;
  const bassOk = bassPc === null ? null : have[0] === bassPc;
  return { ok: sameSet && bassOk !== false, have, want, bassOk };
}

/** The sentence a learner reads when `where` (for example "Bar 2") does not sound like `target`. */
export function describeMismatch(where: string, target: ChordTarget, cmp: ChordComparison): string {
  const { have, want } = cmp;
  const label = `${where} should be ${target.name} (${listWords(target.notes.map(pretty))})${target.bass ? ` with ${pretty(target.bass)} at the bottom` : ""}.`;
  if (have.length === 0) return `${label} It is still empty.`;

  // The classic mix-up: the right root and fifth with the third a semitone off (major vs minor).
  const root = want[0]!;
  const third = target.notes[1];
  if (third !== undefined && want.length === 3 && have.length === 3 && have.includes(root) && have.includes(want[2]!)) {
    const wantThird = want[1]!;
    const haveThird = have.find((pc) => pc !== root && pc !== want[2]);
    if (haveThird !== undefined) {
      if ((wantThird - root + 12) % 12 === 4 && (haveThird - root + 12) % 12 === 3) {
        return `${label} ${pretty(lowered(third, haveThird))} makes it minor: raise it one row (a semitone) to ${pretty(third)}.`;
      }
      if ((wantThird - root + 12) % 12 === 3 && (haveThird - root + 12) % 12 === 4) {
        return `${label} ${pretty(raised(third, haveThird))} makes it major: lower it one row (a semitone) to ${pretty(third)}.`;
      }
    }
  }

  const missing = want.filter((pc) => !have.includes(pc)).map(pitchClassName);
  const extra = have.filter((pc) => !want.includes(pc)).map(pitchClassName);
  if (missing.length === 0 && extra.length === 0 && cmp.bassOk === false) {
    return `${label} Your lowest note is ${pitchClassName(have[0]!)}. Make ${pretty(target.bass!)} the lowest note by moving it below the others.`;
  }
  const haveText = `You have ${listWords(have.map(pitchClassName))}`;
  if (missing.length === 1 && extra.length === 1) return `${label} ${haveText}: change ${extra[0]} to ${missing[0]}.`;
  const parts: string[] = [];
  if (extra.length) parts.push(`${listWords(extra)} ${extra.length > 1 ? "don't" : "doesn't"} belong in this chord`);
  if (missing.length) parts.push(`${listWords(missing)} ${missing.length > 1 ? "are" : "is"} missing`);
  return `${label} ${haveText}: ${parts.join(", and ")}.`;
}
