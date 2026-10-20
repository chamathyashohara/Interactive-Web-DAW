import type { Clip } from "@daw/shared";
import { listWords, pitchClass, pitchClassName, pitchClassOf } from "../theory";
import type { CheckResult, RootChord } from "../types";
import { notesOnBeatOne } from "./chordsPerBar";

/**
 * "Place just the root" check: in bar N the sounding pitch classes on beat 1 must be exactly the root of chord N.
 * Feedback tells a chord tone that is not the root ("B is part of G major, but it is the third") apart from a note that
 * is not in the chord at all. Score = correct bars / bars.
 */
export function checkRootNotes(clip: Clip, chords: RootChord[]): CheckResult {
  const notes = Object.values(clip.notes);
  const items: CheckResult["items"] = [];
  let firstProblem: string | null = null;

  chords.forEach((chord, bar) => {
    const rootPc = pitchClassOf(chord.root);
    if (rootPc === null) throw new Error(`Unknown root "${chord.root}"`);
    const tones = chord.notes.map((n) => pitchClassOf(n));
    const have = [...new Set(notesOnBeatOne(notes, bar).map((n) => pitchClass(n.pitch)))];
    const ok = have.length === 1 && have[0] === rootPc;
    items.push({ label: `Bar ${bar + 1}: ${chord.name} → ${chord.root}`, ok });
    if (ok || firstProblem !== null) return;

    const head = `Bar ${bar + 1} is ${chord.name}.`;
    if (have.length === 0) {
      firstProblem = `${head} Place its root note, ${chord.root}, on beat 1.`;
    } else if (have.length > 1) {
      const extras = have.filter((pc) => pc !== rootPc).map(pitchClassName);
      firstProblem = have.includes(rootPc)
        ? `${head} You have ${listWords(extras)} as well as the root. For now place only the root, ${chord.root}.`
        : `${head} Place only its root note, ${chord.root}.`;
    } else {
      const pc = have[0]!;
      firstProblem = tones.includes(pc)
        ? `${head} ${pitchClassName(pc)} is part of ${chord.name}, but it is not the root. The root is the note the chord is named after: ${chord.root}.`
        : `${head} ${pitchClassName(pc)} is not even in ${chord.name}. The root is the letter in the chord's name: ${chord.root}.`;
    }
  });

  const correct = items.filter((i) => i.ok).length;
  const pass = correct === chords.length;
  return {
    pass,
    score: chords.length ? correct / chords.length : 0,
    feedback: pass ? `Every root is right: ${chords.map((c) => c.root).join(", ")}.` : firstProblem!,
    items,
  };
}
