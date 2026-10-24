import type { Clip } from "@daw/shared";
import type { CheckResult, CheckSpec } from "../types";
import { checkChordsAtTicks, checkChordsPerBar } from "./chordsPerBar";
import { checkDrumPattern } from "./drumPattern";
import { checkMatchTarget } from "./matchTarget";
import { checkChordToneMelody, checkInSet, checkRepeatBars } from "./melodyChecks";
import { checkMelodyInKey } from "./melodyInKey";
import { checkChordSet } from "./progression";
import { checkRootNotes } from "./rootNotes";
import { checkSlots } from "./slots";

/** Project settings some checks read besides the clip. */
export interface CheckContext {
  tempo: number;
}

const DEFAULT_CONTEXT: CheckContext = { tempo: 120 };

/** Runs the pure check a lesson names. Never dispatches and never touches the DOM. */
export function runCheck(clip: Clip, spec: CheckSpec, ctx: CheckContext = DEFAULT_CONTEXT): CheckResult {
  switch (spec.kind) {
    case "chordsPerBar":
      return checkChordsPerBar(clip, spec.chords);
    case "chordsAtTicks":
      return checkChordsAtTicks(clip, spec.chords);
    case "melodyInKey":
      return checkMelodyInKey(clip, spec);
    case "drumPattern":
      return checkDrumPattern(clip, spec);
    case "matchTarget":
      return checkMatchTarget(clip, spec);
    case "rootNotes":
      return checkRootNotes(clip, spec.chords);
    case "slots":
      return checkSlots(clip, spec.slots, spec.extra);
    case "inSet":
      return checkInSet(clip, spec);
    case "chordSet":
      return checkChordSet(clip, spec);
    case "chordToneMelody":
      return checkChordToneMelody(clip, spec.rule);
    case "repeatBars":
      return checkRepeatBars(clip, spec);
    case "tempo": {
      const ok = ctx.tempo === spec.bpm;
      return {
        pass: ok,
        score: ok ? 1 : 0,
        feedback: ok ? `The tempo is ${spec.bpm} BPM.` : `The tempo is ${ctx.tempo} BPM. Type ${spec.bpm} in the Tempo box above the piano roll and press Enter.`,
        items: [{ label: `Tempo is ${spec.bpm} BPM`, ok }],
      };
    }
    case "all": {
      const results = spec.checks.map((c) => runCheck(clip, c, ctx));
      const failing = results.find((r) => !r.pass);
      return {
        pass: !failing,
        score: results.length ? results.reduce((sum, r) => sum + r.score, 0) / results.length : 0,
        feedback: failing ? failing.feedback : results.map((r) => r.feedback).join(" "),
        items: results.flatMap((r) => r.items),
      };
    }
  }
}

/** The tempo a check asks for, anywhere inside it (so tests and tools can set it), or null. */
export function requiredTempo(spec: CheckSpec): number | null {
  if (spec.kind === "tempo") return spec.bpm;
  if (spec.kind === "all") for (const c of spec.checks) { const t = requiredTempo(c); if (t !== null) return t; }
  return null;
}
