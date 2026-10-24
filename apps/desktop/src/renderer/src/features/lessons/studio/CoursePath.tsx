import type { PathModule } from "../curriculum";
import { ModuleCard } from "../LearningPath";
import { COURSES, STUDIO_LESSONS, type CourseId } from "./courses";

/** A course's modules in the shape the learning path's module cards use. */
export const coursePath = (id: CourseId): PathModule[] =>
  COURSES[id].modules.map((m) => ({ id: m.id, code: m.code, title: m.title, items: m.lessons.map((l) => ({ id: l.id, title: l.title })) }));
const ready = (id: string) => id in STUDIO_LESSONS;

/** A studio course (Kick Drums, Drum sequencer): its modules and lessons, opened from the main Lessons page. */
export function CoursePath({ course, onOpen }: { course: CourseId; onOpen: (id: string) => void }) {
  const c = COURSES[course];
  return (
    <div className="flex flex-col gap-5" data-testid={`${course === "kick" ? "kick" : course}-path`}>
      <div>
        <h1 className="text-3xl font-semibold text-white">{c.title}</h1>
        <p className="mt-1 text-[15px] text-slate-400">{c.intro}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {coursePath(course).map((m) => (
          <ModuleCard key={m.id} m={m} onOpen={onOpen} ready={ready} />
        ))}
      </div>
    </div>
  );
}
