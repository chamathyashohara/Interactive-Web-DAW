import type { Lesson, Step } from "./types";

/** Pure helpers behind the Learn view, kept out of the components so they can be unit tested. */

/**
 * Lessons matching every word of `query` (case-insensitive) in their title, summary, concept, step titles or recap.
 * Title matches come first; an empty query returns nothing.
 */
export function searchLessons(lessons: Lesson[], query: string): Lesson[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const haystack = (l: Lesson) => [l.title, l.summary, l.concept.replace("-", " "), ...l.steps.map((s) => s.title), ...l.recap].join(" ").toLowerCase();
  const inTitle = (l: Lesson) => words.some((w) => l.title.toLowerCase().includes(w));
  return lessons.filter((l) => words.every((w) => haystack(l).includes(w))).sort((a, b) => Number(inTitle(b)) - Number(inTitle(a)));
}

export function overallProgress(lessons: Lesson[], isCompleted: (lessonId: string) => boolean) {
  const done = lessons.filter((l) => isCompleted(l.id)).length;
  return { done, total: lessons.length, percent: lessons.length ? Math.round((done / lessons.length) * 100) : 0 };
}

/** What voice guidance reads for a step. */
export function stepSpeechText(step: Step): string {
  if (step.kind === "exercise") return `${step.title}. ${step.goal}`;
  return [step.title, ...step.body, step.tryIt ? `Try it: ${step.tryIt}` : ""].filter(Boolean).join(" ");
}

/** Index of the lesson's exercise step (lessons have exactly one in this version), or -1. */
export const exerciseIndex = (lesson: Lesson) => lesson.steps.findIndex((s) => s.kind === "exercise");
