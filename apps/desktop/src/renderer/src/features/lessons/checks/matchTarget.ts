import { PPQ, type Clip, type Note } from "@daw/shared";
import { pitchLabel } from "../../../pianoRoll/geometry";
import { positionLabel } from "../theory";
import type { CheckResult, CheckSpec } from "../types";

type Spec = Extract<CheckSpec, { kind: "matchTarget" }>;
type Category = "timing" | "length" | "loudness" | "cleanup";
interface Issue {
  category: Category;
  tick: number;
  text: string;
}

const CATEGORY_LABEL: Record<Category, string> = {
  timing: "Notes are on the beat",
  length: "Note lengths are right",
  loudness: "Loudness is even",
  cleanup: "No missing, extra or doubled notes",
};
const CATEGORY_ORDER: Category[] = ["timing", "length", "loudness", "cleanup"];

/**
 * "Fix the recording" check. Notes are matched to the target by pitch, start (within `tolerance.start`) and length
 * (within `tolerance.duration`). A note that is close to a target but off in time or length is a fix-me, not a
 * missing note, so the feedback can say what to do. Loudness is checked on every note. Score = notes that are right
 * (matched and within the velocity range) / max(target notes, notes present).
 */
export function checkMatchTarget(clip: Clip, spec: Spec): CheckResult {
  const [vMin, vMax] = spec.velocityRange;
  const present = Object.values(clip.notes)
    .filter((n) => !n.muted)
    .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  const targets = [...spec.target].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  const used = new Set<Note>();
  const issues: Issue[] = [];
  const goodNotes = new Set<Note>();
  const nearest = (candidates: Note[], tick: number) =>
    candidates.reduce<Note | null>((best, n) => (!best || Math.abs(n.startTick - tick) < Math.abs(best.startTick - tick) ? n : best), null);

  // 1. Exact matches first, so a near-miss never steals a note that fits another target.
  const unmatched: typeof targets = [];
  for (const t of targets) {
    const fits = present.filter(
      (n) => !used.has(n) && n.pitch === t.pitch && Math.abs(n.startTick - t.startTick) <= spec.tolerance.start && Math.abs(n.durationTicks - t.durationTicks) <= spec.tolerance.duration,
    );
    const hit = nearest(fits, t.startTick);
    if (hit) {
      used.add(hit);
      goodNotes.add(hit);
    } else unmatched.push(t);
  }

  // 2. Near misses (same pitch within a beat): say what to fix. Otherwise the note is missing.
  for (const t of unmatched) {
    const name = pitchLabel(t.pitch);
    const where = positionLabel(t.startTick);
    const near = nearest(present.filter((n) => !used.has(n) && n.pitch === t.pitch && Math.abs(n.startTick - t.startTick) <= PPQ), t.startTick);
    if (!near) {
      issues.push({ category: "cleanup", tick: t.startTick, text: `The ${name} at ${where} is missing. Draw it back in.` });
      continue;
    }
    used.add(near);
    if (Math.abs(near.startTick - t.startTick) > spec.tolerance.start) {
      issues.push({ category: "timing", tick: t.startTick, text: `The ${name} at ${where} is not on the beat. Use Quantize, or drag it onto the beat.` });
    }
    if (Math.abs(near.durationTicks - t.durationTicks) > spec.tolerance.duration) {
      const long = near.durationTicks > t.durationTicks;
      issues.push({ category: "length", tick: t.startTick, text: `The ${name} at ${where} is too ${long ? "long" : "short"}. Drag its right edge to ${long ? "shorten" : "lengthen"} it.` });
    }
  }

  // 3. Anything left over is extra; a note stacked exactly on a matched one is a duplicate.
  for (const n of present) {
    if (used.has(n)) continue;
    const doubled = present.some((m) => m !== n && used.has(m) && m.pitch === n.pitch && Math.abs(m.startTick - n.startTick) <= spec.tolerance.start);
    const name = pitchLabel(n.pitch);
    const where = positionLabel(n.startTick);
    issues.push({
      category: "cleanup",
      tick: n.startTick,
      text: doubled ? `Two ${name} notes are stacked at ${where}. Delete one of them.` : `The ${name} at ${where} is not part of the tune. Delete it.`,
    });
  }

  // 4. Loudness applies to every note.
  for (const n of present) {
    if (n.velocity >= vMin && n.velocity <= vMax) continue;
    goodNotes.delete(n);
    const loud = n.velocity > vMax;
    issues.push({ category: "loudness", tick: n.startTick, text: `The ${pitchLabel(n.pitch)} at ${positionLabel(n.startTick)} is too ${loud ? "loud" : "quiet"} (${n.velocity}). Change it in the velocity lane.` });
  }

  issues.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.tick - b.tick);
  const items = CATEGORY_ORDER.map((c) => ({ label: CATEGORY_LABEL[c], ok: !issues.some((i) => i.category === c) }));
  const denominator = Math.max(targets.length, present.length);
  return {
    pass: issues.length === 0,
    score: denominator ? goodNotes.size / denominator : 0,
    feedback: issues.length === 0 ? "All the mistakes are fixed: the notes are on the beat, the right length, evenly loud and none are doubled." : issues[0]!.text,
    items,
  };
}
