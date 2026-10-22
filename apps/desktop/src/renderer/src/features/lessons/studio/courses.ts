import { KICK_MODULES } from "./kickCurriculum";
import { SEQ_MODULES } from "./seqCurriculum";
import type { StudioLesson, StudioModule } from "./types";

/** The courses built from studio lessons (each opened from its card on the main Lessons page). */
export type CourseId = "kick" | "sequencer";
export interface Course {
  id: CourseId;
  title: string;
  intro: string;
  modules: StudioModule[];
}

export const COURSES: Record<CourseId, Course> = {
  kick: {
    id: "kick",
    title: "Kick Drums",
    intro: "Build beats from the sound browser, then use drums to shape a song: breakdown, build-up and drop. Each lesson: hook, watch, try, practice, quick check.",
    modules: KICK_MODULES,
  },
  sequencer: {
    id: "sequencer",
    title: "Drum sequencer",
    intro: "Program kick patterns on the step sequencer: sixteen pads per bar, accents, snare room, four-bar patterns, loops and ramps. Each lesson: hook, watch, try, practice, quick check.",
    modules: SEQ_MODULES,
  },
};

const ALL = Object.values(COURSES);
export const STUDIO_LESSONS: Record<string, StudioLesson> = Object.fromEntries(ALL.flatMap((c) => c.modules.flatMap((m) => m.lessons)).map((l) => [l.id, l]));
export const studioModuleOf = (id: string) => ALL.flatMap((c) => c.modules).find((m) => m.lessons.some((l) => l.id === id));
export const courseOf = (id: string): Course => ALL.find((c) => c.modules.some((m) => m.lessons.some((l) => l.id === id))) ?? COURSES.kick;

/** The next lesson after `id` in its own course, or null at the end of the course. */
export function nextStudioLesson(id: string): StudioLesson | null {
  const all = courseOf(id).modules.flatMap((m) => m.lessons);
  const i = all.findIndex((l) => l.id === id);
  return i >= 0 ? (all[i + 1] ?? null) : null;
}
