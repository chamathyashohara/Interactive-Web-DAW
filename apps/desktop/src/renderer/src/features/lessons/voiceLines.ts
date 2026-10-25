import { LESSONS, SUB_LESSONS } from "./content";
import { stepSpeechText } from "./learnModel";
import { stageSpeech, type StageId } from "./subLesson";
import { STUDIO_LESSONS } from "./studio/courses";
import type { StudioLesson } from "./studio/types";
import { normalizeLine } from "./voiceKey";

/**
 * Every line voice guidance can read, so each one can be recorded ahead of time with a natural voice
 * (docs/lessons/VOICE.md; the recordings are ./voice/<voiceKey>.ogg and speech.ts plays them).
 */

const STAGE_IDS: StageId[] = ["hook", "watch", "try", "practice", "quick", "done"];

/** What voice guidance reads for a workspace lesson's stage (Watch: one caption at a time). */
export function studioSpeech(lesson: StudioLesson, s: StageId, watchIndex = 0): string {
  switch (s) {
    case "hook":
      return `${lesson.hook.headline}. ${lesson.hook.text}`;
    case "watch":
      return lesson.watch.steps[Math.max(0, watchIndex)]?.caption ?? "";
    case "try":
      return lesson.tryIt.instruction;
    case "practice":
      return lesson.practice.instruction;
    case "quick":
      return lesson.quick.question;
    case "done":
      return `Well done. ${lesson.recap.join(" ")}`;
  }
}

/** Every line, once each (empty ones left out). */
export function voiceLines(): string[] {
  const out: string[] = [];
  for (const lesson of LESSONS) {
    for (const step of lesson.steps) {
      out.push(stepSpeechText(step));
      if (step.kind !== "exercise" && step.tryIt) out.push(step.tryIt);
    }
    out.push(`What you learned. ${lesson.recap.join(" ")}`);
  }
  for (const sub of SUB_LESSONS) {
    for (const stage of STAGE_IDS) if (stage !== "watch") out.push(stageSpeech(sub, stage));
    sub.watch.steps.forEach((_, i) => out.push(stageSpeech(sub, "watch", i)));
  }
  for (const lesson of Object.values(STUDIO_LESSONS)) {
    for (const stage of STAGE_IDS) if (stage !== "watch") out.push(studioSpeech(lesson, stage));
    lesson.watch.steps.forEach((_, i) => out.push(studioSpeech(lesson, "watch", i)));
  }
  return [...new Set(out.map(normalizeLine).filter(Boolean))];
}
