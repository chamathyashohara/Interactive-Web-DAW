import { KICK_MODULES } from "./kickCurriculum";
import { SEQ_MODULES } from "./seqCurriculum";
import { UNIT0, UNIT1, UNIT2, UNIT3, UNIT4, UNIT5, UNIT6 } from "./songCurriculum";
import { UNIT10, UNIT7, UNIT8, UNIT9 } from "./songCurriculum2";
import { COURSE_SPECIALS } from "./specials";
import type { StudioLesson, StudioModule } from "./types";

/**
 * The courses built from workspace lessons, each opened from its card on the main Lessons page, easiest first. The
 * song-making lessons sit in the course they belong to; each course ends with its Special task (specials.ts).
 */
export type CourseId = "kick" | "sequencer" | "mixing";
export interface Course {
  id: CourseId;
  title: string;
  intro: string;
  modules: StudioModule[];
  /** Special task ids at the end of the course. */
  specials: string[];
}

const byId = new Map([...KICK_MODULES.flatMap((m) => m.lessons), ...SEQ_MODULES.flatMap((m) => m.lessons), ...UNIT0, ...UNIT1, ...UNIT2, ...UNIT3, ...UNIT4, ...UNIT5, ...UNIT6, ...UNIT7, ...UNIT8, ...UNIT9, ...UNIT10].map((l) => [l.id, l]));
const pick = (...ids: string[]) => ids.map((id) => byId.get(id)!);
const module = (id: string, code: string, title: string, lessons: StudioLesson[]): StudioModule => ({ id, code, title, lessons });

export const COURSES: Record<CourseId, Course> = {
  kick: {
    id: "kick",
    title: "Kick Drums",
    intro: "From finding sounds to arranging a song: the sound browser and beats, clips and transitions, the build-up and the drop, the ending. Ends with a Special task: the song's transitions.",
    modules: [
      module("k1", "K1", "DAW basics and sounds", pick("M30.1", "M12.1", "M12.2", "M12.3", "M12.4", "M12.5", "M12.6")),
      module("k2", "K2", "Arranging with clips", pick("M33.1", "M33.2", "M34.1", "M34.2", "M36.2")),
      module("k3", "K3", "Build-up and drop", pick("M13.1", "M13.2", "M37.1", "M37.2", "M13.3", "M37.3", "M13.4", "M13.5", "M13.6")),
      module("k4", "K4", "The drop and the ending", pick("M38.4", "M39.1")),
    ],
    specials: COURSE_SPECIALS.kick,
  },
  sequencer: {
    id: "sequencer",
    title: "Drum sequencer",
    intro: "Program beats on the step sequencer: kick patterns, hats, clap and snare, then accents, four-bar patterns, loops and ramps. Ends with a Special task: the song's drum beat.",
    modules: [
      module("s1", "S1", "Kick basics", pick("M14.1", "M14.2", "M14.3", "M14.4", "M14.5")),
      module("s2", "S2", "Hats, clap and snare", pick("M32.2", "M32.3", "M14.7")),
      module("s3", "S3", "Shaping the beat", pick("M14.6", "M14.8", "M14.9", "M14.10")),
    ],
    specials: COURSE_SPECIALS.sequencer,
  },
  mixing: {
    id: "mixing",
    title: "Mixing",
    intro: "One channel per element, gain staging from the low end, EQ and compression, pan and stereo width, and master headroom. Ends with a Special task: the song's mix.",
    modules: [module("x1", "X1", "Mixing", UNIT10)],
    specials: COURSE_SPECIALS.mixing,
  },
};

/** Workspace lessons on the Piano learning path (L5-L7; the path lists them in curriculum.ts). */
export const PIANO_EXTRA_LESSONS: StudioLesson[] = pick("M31.3", "M31.4", "M38.2", "M38.3", "M35.1", "M35.2", "M36.1");

const ALL = Object.values(COURSES);
export const STUDIO_LESSONS: Record<string, StudioLesson> = Object.fromEntries([...ALL.flatMap((c) => c.modules.flatMap((m) => m.lessons)), ...PIANO_EXTRA_LESSONS].map((l) => [l.id, l]));
export const studioModuleOf = (id: string) => ALL.flatMap((c) => c.modules).find((m) => m.lessons.some((l) => l.id === id));
export const courseOf = (id: string): Course | undefined => ALL.find((c) => c.modules.some((m) => m.lessons.some((l) => l.id === id)) || c.specials.includes(id));

/** A course's lessons in order, then its Special tasks. */
export const courseItems = (c: Course) => c.modules.flatMap((m) => m.items ?? m.lessons.map((l) => ({ id: l.id, title: l.title })));

/** The next lesson after `id` in its course, or null at the end of the course. */
export function nextStudioLesson(id: string, course: CourseId | undefined = courseOf(id)?.id): { id: string; title: string } | null {
  if (!course) return null;
  const all = courseItems(COURSES[course]);
  const i = all.findIndex((l) => l.id === id);
  return i >= 0 ? (all[i + 1] ?? null) : null;
}
