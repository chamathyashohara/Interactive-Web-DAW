import type { Clip } from "@daw/shared";
import type { CheckResult, CheckSpec } from "../types";
import { checkChordsPerBar } from "./chordsPerBar";
import { checkDrumPattern } from "./drumPattern";
import { checkMatchTarget } from "./matchTarget";
import { checkMelodyInKey } from "./melodyInKey";
import { checkRootNotes } from "./rootNotes";

/** Runs the pure check a lesson names. Never dispatches and never touches the DOM. */
export function runCheck(clip: Clip, spec: CheckSpec): CheckResult {
  switch (spec.kind) {
    case "chordsPerBar":
      return checkChordsPerBar(clip, spec.chords);
    case "melodyInKey":
      return checkMelodyInKey(clip, spec);
    case "drumPattern":
      return checkDrumPattern(clip, spec);
    case "matchTarget":
      return checkMatchTarget(clip, spec);
    case "rootNotes":
      return checkRootNotes(clip, spec.chords);
  }
}
