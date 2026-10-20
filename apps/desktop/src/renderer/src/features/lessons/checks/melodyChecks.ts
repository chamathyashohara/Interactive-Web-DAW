import { TICKS_PER_BAR, type Clip, type Note } from "@daw/shared";
import { pitchLabel } from "../../../pianoRoll/geometry";
import { listWords, pitchClass, pitchClassName, pitchClassOf, positionLabel } from "../theory";
import type { CheckResult, ChordToneRule } from "../types";
import { chordPcs } from "./chordMatch";

const sorted = (notes: Note[]) => [...notes].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);

/** Unmuted notes at or above `minPitch` (the melody, when an accompaniment sits lower). */
function melodyNotes(clip: Clip, minPitch = 0): Note[] {
  return sorted(Object.values(clip.notes).filter((n) => !n.muted && n.pitch >= minPitch));
}

function firstOverlap(notes: Note[]): number | null {
  let maxEnd = 0;
  for (const n of notes) {
    if (n.startTick < maxEnd) return n.startTick;
    maxEnd = Math.max(maxEnd, n.startTick + n.durationTicks);
  }
  return null;
}

/**
 * A melody made only of a chosen set of notes (a pentatonic scale, for example). Pass when every note is in the set, there
 * are enough notes, every `mustUse` note appears, the notes do not overlap (when monophonic) and the last is `endOn`.
 */
export function checkInSet(
  clip: Clip,
  spec: { label: string; allowed: string[]; minNotes: number; mustUse?: string[]; endOn?: string; monophonic: boolean; minPitch?: number },
): CheckResult {
  const allowed = new Set(spec.allowed.map((n) => pitchClassOf(n)));
  const notes = melodyNotes(clip, spec.minPitch);
  const outside = notes.filter((n) => !allowed.has(pitchClass(n.pitch)));
  const overlapAt = spec.monophonic ? firstOverlap(notes) : null;
  const used = new Set(notes.map((n) => pitchClass(n.pitch)));
  const unused = (spec.mustUse ?? []).filter((name) => !used.has(pitchClassOf(name)!));
  const endPc = spec.endOn === undefined ? null : pitchClassOf(spec.endOn);
  const last = notes[notes.length - 1];
  const endsRight = endPc === null || (last !== undefined && pitchClass(last.pitch) === endPc);
  const enough = notes.length >= spec.minNotes;

  const items: CheckResult["items"] = [
    { label: `At least ${spec.minNotes} notes (you have ${notes.length})`, ok: enough },
    { label: `Every note is in the ${spec.label} (${listWords(spec.allowed)})`, ok: outside.length === 0 },
  ];
  if (spec.mustUse?.length) items.push({ label: `Uses ${listWords(spec.mustUse)}`, ok: unused.length === 0 });
  if (spec.monophonic) items.push({ label: "One note at a time", ok: overlapAt === null });
  if (spec.endOn !== undefined) items.push({ label: `Ends on ${spec.endOn}`, ok: endsRight });

  const bad = outside[0];
  const feedback = bad
    ? `${pitchLabel(bad.pitch)} at ${positionLabel(bad.startTick)} is not in the ${spec.label}. Use only ${listWords(spec.allowed)}.`
    : overlapAt !== null
      ? `Two notes sound together at ${positionLabel(overlapAt)}. Play one note at a time.`
      : !enough
        ? `Your melody needs at least ${spec.minNotes} notes; you have ${notes.length}.`
        : unused.length
          ? `Try using ${listWords(unused)} too: it is part of the ${spec.label}.`
          : !endsRight
            ? `End on ${spec.endOn}. Your melody ends on ${last ? pitchLabel(last.pitch) : "nothing"}.`
            : `Nice: ${notes.length} notes, all in the ${spec.label}.`;
  const inSet = notes.length - outside.length;
  const denominator = Math.max(notes.length, spec.minNotes);
  return { pass: items.every((i) => i.ok), score: denominator ? inSet / denominator : 0, feedback, items };
}

/**
 * Melody over chords: on each strong beat of each bar there must be a melody note (pitch at or above `melodyMinPitch`)
 * and it must be a tone of that bar's chord. Score = strong beats done right / strong beats.
 */
export function checkChordToneMelody(clip: Clip, rule: ChordToneRule): CheckResult {
  const notes = melodyNotes(clip, rule.melodyMinPitch);
  const items: CheckResult["items"] = [];
  let firstProblem: string | null = null;
  const TOL = 150;

  rule.chords.forEach((chord, bar) => {
    const tones = chordPcs(chord);
    for (const beatTick of rule.strongBeats) {
      const tick = bar * TICKS_PER_BAR + beatTick;
      const where = positionLabel(tick);
      const here = notes.filter((n) => Math.abs(n.startTick - tick) <= TOL);
      const ok = here.length > 0 && here.every((n) => tones.includes(pitchClass(n.pitch)));
      items.push({ label: `${where.charAt(0).toUpperCase()}${where.slice(1)} (${chord.name})`, ok });
      if (ok || firstProblem !== null) continue;
      const wrong = here.find((n) => !tones.includes(pitchClass(n.pitch)));
      firstProblem = wrong
        ? `${where.charAt(0).toUpperCase()}${where.slice(1)}: ${pitchLabel(wrong.pitch)} is not in ${chord.name} (${listWords(chord.notes)}). On this beat use ${listWords(chord.notes).replace(" and ", " or ")}.`
        : `${where.charAt(0).toUpperCase()}${where.slice(1)}: add a melody note here. The chord is ${chord.name} (${listWords(chord.notes)}).`;
    }
  });

  const correct = items.filter((i) => i.ok).length;
  const pass = correct === items.length;
  return { pass, score: items.length ? correct / items.length : 0, feedback: pass ? "Every strong beat lands on a chord tone." : firstProblem!, items };
}

const signature = (notes: Note[], bar: number) =>
  notes
    .filter((n) => Math.floor(n.startTick / TICKS_PER_BAR) === bar)
    .map((n) => ({ pitch: n.pitch, start: n.startTick - bar * TICKS_PER_BAR, dur: n.durationTicks }))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);

const sameShape = (a: ReturnType<typeof signature>, b: ReturnType<typeof signature>, withPitch: boolean) =>
  a.length === b.length && a.every((x, i) => Math.abs(x.start - b[i]!.start) <= 60 && Math.abs(x.dur - b[i]!.dur) <= 60 && (!withPitch || x.pitch === b[i]!.pitch));

/**
 * A motif and its repetition: bar `from` has at least `minNotes` notes and bar `to` repeats it exactly (same pitches,
 * starts and lengths). Optionally a `variation` bar keeps the rhythm of another bar but changes at least one pitch.
 */
export function checkRepeatBars(clip: Clip, spec: { from: number; to: number; minNotes: number; variation?: { bar: number; compareTo: number } }): CheckResult {
  const notes = Object.values(clip.notes).filter((n) => !n.muted);
  const a = signature(notes, spec.from);
  const b = signature(notes, spec.to);
  const enough = a.length >= spec.minNotes;
  const repeated = enough && sameShape(a, b, true);
  const items: CheckResult["items"] = [
    { label: `A motif of at least ${spec.minNotes} notes in bar ${spec.from + 1}`, ok: enough },
    { label: `Bar ${spec.to + 1} repeats it exactly`, ok: repeated },
  ];
  let variationFeedback: string | null = null;
  if (spec.variation) {
    const v = signature(notes, spec.variation.bar);
    const base = signature(notes, spec.variation.compareTo);
    const sameRhythm = sameShape(v, base, false);
    const changed = sameRhythm && v.some((x, i) => x.pitch !== base[i]!.pitch);
    items.push({ label: `Bar ${spec.variation.bar + 1} keeps the rhythm but changes a note`, ok: changed });
    if (!changed) {
      variationFeedback = !sameRhythm
        ? `Bar ${spec.variation.bar + 1} should have the same rhythm as bar ${spec.variation.compareTo + 1}: same number of notes, starting at the same moments.`
        : `Bar ${spec.variation.bar + 1} is identical to bar ${spec.variation.compareTo + 1}. Change at least one pitch to make a variation.`;
    }
  }
  const correct = items.filter((i) => i.ok).length;
  const pass = correct === items.length;
  const feedback = pass
    ? "A motif, repeated, then varied: that is how melodies stick in the head."
    : !enough
      ? `Write a motif of at least ${spec.minNotes} notes in bar ${spec.from + 1}. You have ${a.length}.`
      : !repeated
        ? a.length !== b.length
          ? `Bar ${spec.to + 1} has ${b.length} notes but the motif has ${a.length}. Copy the motif exactly (select, copy, paste into bar ${spec.to + 1}).`
          : `Bar ${spec.to + 1} is close, but a note differs from the motif in bar ${spec.from + 1}. Repeat it exactly.`
        : variationFeedback!;
  return { pass, score: correct / items.length, feedback, items };
}

/** Names of the pitch classes used (for tests and feedback elsewhere). */
export const usedNames = (clip: Clip) => [...new Set(Object.values(clip.notes).map((n) => pitchClassName(n.pitch)))];
