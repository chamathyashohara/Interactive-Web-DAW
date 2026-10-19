import type { Clip } from "@daw/shared";
import type { CheckResult, CheckSpec } from "../types";
import { checkChordsPerBar } from "./chordsPerBar";

/** Runs the pure check a lesson names. Never dispatches and never touches the DOM. */
export function runCheck(clip: Clip, spec: CheckSpec): CheckResult {
  switch (spec.kind) {
    case "chordsPerBar":
      return checkChordsPerBar(clip, spec.chords);
  }
}
