import type { ChordTarget, GuideNoteSpec, QuickCheckQuestion, Slot } from "../types";

/** Small builders so sub-lessons read like the music they describe. Bars and beats are 1-based, like the roll's ruler. */

export const BEAT = 960;
export const BAR = 3840;

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as const;

/** "C4" -> 60 (middle C is C4), "F#3", "Bb5". */
export function pitch(name: string): number {
  const m = /^([A-G])(#|b|♭)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`Bad note name "${name}" (write C4, F#3 or Bb5)`);
  return (Number(m[3]) + 1) * 12 + LETTER[m[1] as keyof typeof LETTER] + (m[2] === "#" ? 1 : m[2] ? -1 : 0);
}

export const rows = (...names: string[]) => names.map(pitch);

/** Ticks from the clip start to `beat` of `bar` (both 1-based; the beat may be fractional, e.g. 1.5). */
export const at = (bar: number, beat = 1): number => (bar - 1) * BAR + Math.round((beat - 1) * BEAT);

/** A length in beats as ticks. */
export const beats = (n: number): number => Math.round(n * BEAT);

export interface Mark {
  root?: boolean;
  label?: string;
}

/** One guide note: `name` like "C4", at `bar`/`beat`, lasting `length` beats. */
export function g(name: string, bar: number, beat: number, length: number, mark: Mark = {}): GuideNoteSpec {
  return { pitch: pitch(name), startTick: at(bar, beat), durationTicks: beats(length), ...(mark.root ? { root: true } : {}), ...(mark.label ? { label: mark.label } : {}) };
}

/** Notes played together; with `root`, the first is marked as the root (label "root" unless given). */
export function chordAt(bar: number, beat: number, length: number, names: string[], opts: { root?: boolean | string } = {}): GuideNoteSpec[] {
  return names.map((name, i) => g(name, bar, beat, length, i === 0 && opts.root ? { root: true, label: typeof opts.root === "string" ? opts.root : "root" } : {}));
}

/** Notes one after another from `bar`/`beat`, each lasting `each` beats (they flow on into later bars). */
export function run(names: string[], bar: number, beat: number, each = 1, labels?: string[]): GuideNoteSpec[] {
  const start = at(bar, beat);
  return names.map((name, i) => ({ pitch: pitch(name), startTick: start + i * beats(each), durationTicks: beats(each), ...(labels?.[i] ? { label: labels[i] } : {}) }));
}

/** The same notes without any root mark or label (a plain demonstration). */
export const plain = (notes: GuideNoteSpec[]): GuideNoteSpec[] => notes.map(({ pitch: p, startTick, durationTicks }) => ({ pitch: p, startTick, durationTicks }));

/** A chord for the chord checks: `name` as the learner reads it, pitch-class names root first (no octaves). */
export const chord = (name: string, ...notes: string[]): ChordTarget => ({ name, notes });

const TOL = 120;

/**
 * A slot for the placement check: a note that must start near `bar`/`beat`. `names` are pitch classes (any octave);
 * `exact` pins one pitch; `len` is the length in beats (with a little give).
 */
export function slotAt(label: string, bar: number, beat: number, o: { names?: string[]; exact?: string; len?: number; lenMin?: number; lenMax?: number; tol?: number } = {}): Slot {
  const tol = o.tol ?? TOL;
  const start = at(bar, beat);
  const slot: Slot = { label, startMin: start - tol, startMax: start + tol };
  if (o.names) slot.pitchClasses = o.names;
  if (o.exact) slot.pitchMin = slot.pitchMax = pitch(o.exact);
  if (o.len !== undefined) {
    slot.durationMin = beats(o.len) - TOL;
    slot.durationMax = beats(o.len) + TOL;
  }
  if (o.lenMin !== undefined) slot.durationMin = beats(o.lenMin);
  if (o.lenMax !== undefined) slot.durationMax = beats(o.lenMax);
  return slot;
}

export const quick = (question: string, options: string[], correct: number, explanation: string): QuickCheckQuestion => ({ question, options, correct, explanation });

/** Target notes for the "match" check: a note by name, bar, beat and length in beats. */
export const target = (name: string, bar: number, beat: number, length: number) => ({ pitch: pitch(name), startTick: at(bar, beat), durationTicks: beats(length) });

export const MATCH = { tolerance: { start: 150, duration: 150 }, velocityRange: [1, 127] as [number, number] };
