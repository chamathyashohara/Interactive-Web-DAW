import type { Clip } from "@daw/shared";
import { listWords, pitchClassName } from "../theory";
import type { CheckResult, ChordTarget } from "../types";
import { chordPcs, pitchClassesLowToHigh } from "./chordMatch";
import { notesOnBeatOne } from "./chordsPerBar";

/**
 * A progression the learner writes freely: every bar must be one of the `allowed` chords (one chord per bar, any
 * inversion), optionally starting and/or ending on a named chord, optionally with no chord repeated twice in a row.
 */
export function checkChordSet(clip: Clip, spec: { bars: number; allowed: ChordTarget[]; first?: string; last?: string; noAdjacentRepeat?: boolean }): CheckResult {
  const notes = Object.values(clip.notes);
  const allowedNames = spec.allowed.map((c) => c.name);
  const items: CheckResult["items"] = [];
  const found: (string | null)[] = [];
  let barProblem: string | null = null;

  for (let bar = 0; bar < spec.bars; bar++) {
    const have = pitchClassesLowToHigh(notesOnBeatOne(notes, bar));
    const match = spec.allowed.find((c) => {
      const want = chordPcs(c);
      return have.length === want.length && want.every((pc) => have.includes(pc));
    });
    found.push(match?.name ?? null);
    items.push({ label: `Bar ${bar + 1}: ${match ? match.name : "a chord from the list"}`, ok: Boolean(match) });
    if (!match && barProblem === null) {
      barProblem = have.length
        ? `Bar ${bar + 1} (${listWords(have.map(pitchClassName))}) is not one of the chords for this exercise: ${listWords(allowedNames)}.`
        : `Bar ${bar + 1} is empty. Build one of these chords: ${listWords(allowedNames)}.`;
    }
  }

  let ruleProblem: string | null = null;
  if (spec.first) {
    const ok = found[0] === spec.first;
    items.push({ label: `Starts on ${spec.first}`, ok });
    if (!ok) ruleProblem ??= `Start on ${spec.first}: it is the home chord, so the progression feels like it begins at home.`;
  }
  if (spec.last) {
    const ok = found[spec.bars - 1] === spec.last;
    items.push({ label: `Ends on ${spec.last}`, ok });
    if (!ok) ruleProblem ??= `End on ${spec.last}: going back home makes the progression feel finished.`;
  }
  if (spec.noAdjacentRepeat) {
    const repeatAt = found.findIndex((name, i) => i > 0 && name !== null && name === found[i - 1]);
    items.push({ label: "No chord twice in a row", ok: repeatAt < 0 });
    if (repeatAt >= 0) ruleProblem ??= `Bars ${repeatAt} and ${repeatAt + 1} are the same chord. Change one so the music moves.`;
  }

  const correct = items.filter((i) => i.ok).length;
  const pass = correct === items.length;
  return {
    pass,
    score: items.length ? correct / items.length : 0,
    feedback: pass ? `Your progression: ${found.join(" → ")}.` : (barProblem ?? ruleProblem)!,
    items,
  };
}
