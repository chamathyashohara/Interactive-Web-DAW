import { isBuilt, type PathModule } from "../curriculum";
import { ModuleCard } from "../LearningPath";
import { COURSES, STUDIO_LESSONS, type CourseId } from "./courses";
import { SpecialCards } from "./SpecialCards";

/** A course's modules in the shape the learning path's module cards use. */
export const coursePath = (id: CourseId): PathModule[] =>
  COURSES[id].modules.map((m) => ({ id: m.id, code: m.code, title: m.title, items: m.items ?? m.lessons.map((l) => ({ id: l.id, title: l.title })) }));
/** A lesson of this app: a studio lesson or a Piano sub-lesson (linked from Make a Song). */
const ready = (id: string) => id in STUDIO_LESSONS || isBuilt(id);

/** A studio course (Kick Drums, Drum sequencer): its modules and lessons, opened from the main Lessons page. */
export function CoursePath({ course, onOpen }: { course: CourseId; onOpen: (id: string) => void }) {
  const c = COURSES[course];
  return (
    <div className="flex flex-col gap-5" data-testid={`${course}-path`}>
      <div>
        <h1 className="text-3xl font-semibold text-white">{c.title}</h1>
        <p className="mt-1 text-[15px] text-slate-400">{c.intro}</p>
      </div>
      <div className={`grid gap-4 md:grid-cols-2 ${c.modules.length > 4 ? "xl:grid-cols-3" : ""}`}>
        {coursePath(course).map((m) => (
          <ModuleCard key={m.id} m={m} onOpen={onOpen} ready={ready} />
        ))}
        {c.specials.length > 0 && <SpecialCards ids={c.specials} onOpen={onOpen} />}
      </div>
    </div>
  );
}
