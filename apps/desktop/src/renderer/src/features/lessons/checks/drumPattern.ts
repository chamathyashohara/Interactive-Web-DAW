import { TICKS_PER_BAR, type Clip, type Note } from "@daw/shared";
import { listWords, rhythmPosition } from "../theory";
import type { CheckResult, CheckSpec } from "../types";

type Spec = Extract<CheckSpec, { kind: "drumPattern" }>;

/**
 * Each voice's onsets repeat in every bar of the clip. A hit counts when a note of that drum starts within
 * `tolerance` ticks of an expected onset (each note is used once). Extra hits on a listed drum fail; drums that are not
 * listed are ignored. Score = hits found / (hits required + extra hits).
 */
export function checkDrumPattern(clip: Clip, spec: Spec): CheckResult {
  const bars = Math.max(1, Math.round(clip.lengthTicks / TICKS_PER_BAR));
  const notes = Object.values(clip.notes).filter((n) => !n.muted);
  const items: CheckResult["items"] = [];
  let firstProblem: string | null = null;
  let found = 0;
  let required = 0;
  let extraTotal = 0;

  for (const voice of spec.voices) {
    const expected: number[] = [];
    for (let bar = 0; bar < bars; bar++) for (const onset of voice.onsets) expected.push(bar * TICKS_PER_BAR + onset);
    const hits = notes.filter((n) => n.pitch === voice.pitch).sort((a, b) => a.startTick - b.startTick);
    const used = new Set<Note>();
    const missing: number[] = [];
    for (const e of expected) {
      let best: Note | null = null;
      for (const h of hits) {
        if (used.has(h) || Math.abs(h.startTick - e) > spec.tolerance) continue;
        if (!best || Math.abs(h.startTick - e) < Math.abs(best.startTick - e)) best = h;
      }
      if (best) used.add(best);
      else missing.push(e);
    }
    const extras = hits.filter((h) => !used.has(h));
    const got = expected.length - missing.length;
    found += got;
    required += expected.length;
    extraTotal += extras.length;
    const ok = missing.length === 0 && extras.length === 0;
    items.push({ label: `${voice.label}: ${got} of ${expected.length}${extras.length ? `, ${extras.length} extra` : ""}`, ok });
    if (!ok && firstProblem === null) {
      const at = (t: number) => rhythmPosition(t, bars > 1);
      const shown = missing.slice(0, 3).map(at);
      const more = missing.length - shown.length;
      firstProblem = missing.length
        ? `${voice.label}: ${got} of ${expected.length} found. Missing on ${more > 0 ? `${shown.join("; ")}; and ${more} more` : listWords(shown)}.`
        : `${voice.label}: extra ${extras.length > 1 ? "hits" : "hit"} on ${listWords(extras.map((x) => at(x.startTick)))}. Remove ${extras.length > 1 ? "them" : "it"}.`;
    }
  }

  const pass = items.every((i) => i.ok);
  return {
    pass,
    score: required + extraTotal ? found / (required + extraTotal) : 0,
    feedback: pass ? `Every part is in place: ${listWords(spec.voices.map((v) => v.label))}.` : firstProblem!,
    items,
  };
}
