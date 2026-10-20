import type { Clip } from "@daw/shared";
import { pitchLabel } from "../../../pianoRoll/geometry";
import { inKeyNeighbours, majorScale, pitchClass, pitchClassOf, positionLabel } from "../theory";
import type { CheckResult, CheckSpec } from "../types";

type Spec = Extract<CheckSpec, { kind: "melodyInKey" }>;

/**
 * Pass when the (unmuted) notes are all in the key, there are at least `minNotes` of them, none overlap (when
 * `monophonic`) and the last note is `endOn`. Score = in-key notes / max(notes, minNotes): note accuracy only, so a
 * perfect score with a failed rule (for example not ending on the home note) is possible.
 */
export function checkMelodyInKey(clip: Clip, spec: Spec): CheckResult {
  const rootPc = pitchClassOf(spec.key);
  if (rootPc === null) throw new Error(`Unknown key "${spec.key}"`);
  const endPc = spec.endOn === undefined ? null : pitchClassOf(spec.endOn);
  if (spec.endOn !== undefined && endPc === null) throw new Error(`Unknown note "${spec.endOn}"`);
  const scale = majorScale(rootPc);
  const keyName = `${spec.key} major`;

  const notes = Object.values(clip.notes)
    .filter((n) => !n.muted && n.pitch >= (spec.minPitch ?? 0))
    .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);

  const outOfKey = notes.filter((n) => !scale.has(pitchClass(n.pitch)));
  let maxEnd = 0;
  let overlapAt: number | null = null;
  for (const n of notes) {
    if (overlapAt === null && n.startTick < maxEnd) overlapAt = n.startTick;
    maxEnd = Math.max(maxEnd, n.startTick + n.durationTicks);
  }
  const enough = notes.length >= spec.minNotes;
  const last = notes[notes.length - 1];
  const endsRight = endPc === null || (last !== undefined && pitchClass(last.pitch) === endPc);

  const items: CheckResult["items"] = [
    { label: `At least ${spec.minNotes} notes (you have ${notes.length})`, ok: enough },
    { label: `Every note is in ${keyName}`, ok: outOfKey.length === 0 },
  ];
  if (spec.monophonic) items.push({ label: "One note at a time", ok: overlapAt === null });
  if (spec.endOn !== undefined) items.push({ label: `Ends on ${spec.endOn}`, ok: endsRight });

  let feedback: string;
  const bad = outOfKey[0];
  if (bad) {
    const [below, above] = inKeyNeighbours(pitchClass(bad.pitch), scale);
    feedback = `${pitchLabel(bad.pitch)} at ${positionLabel(bad.startTick)} is not in ${keyName}. Try ${below} or ${above}.`;
  } else if (spec.monophonic && overlapAt !== null) {
    feedback = `Two notes sound together at ${positionLabel(overlapAt)}. A melody plays one note at a time: shorten the first note or move the second.`;
  } else if (!enough) {
    feedback = `Your melody needs at least ${spec.minNotes} notes; you have ${notes.length}.`;
  } else if (!endsRight) {
    feedback = `End the melody on ${spec.endOn}, the home note of ${keyName}. It currently ends on ${last ? pitchLabel(last.pitch) : "nothing"}.`;
  } else {
    feedback = `Nice melody: ${notes.length} notes, all in ${keyName}${spec.endOn ? `, ending on ${spec.endOn}` : ""}.`;
  }

  const inKey = notes.length - outOfKey.length;
  const denominator = Math.max(notes.length, spec.minNotes);
  return { pass: items.every((i) => i.ok), score: denominator ? inKey / denominator : 0, feedback, items };
}
