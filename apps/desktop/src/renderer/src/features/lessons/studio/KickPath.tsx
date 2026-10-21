import type { PathModule } from "../curriculum";
import { ModuleCard } from "../LearningPath";
import { KICK_MODULES, STUDIO_LESSONS } from "./kickCurriculum";

export const KICK_PATH: PathModule[] = KICK_MODULES.map((m) => ({ id: m.id, code: m.code, title: m.title, items: m.lessons.map((l) => ({ id: l.id, title: l.title })) }));
const ready = (id: string) => id in STUDIO_LESSONS;

/** The Kick Drums course: its modules and lessons, opened from the main Lessons page. */
export function KickPath({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-5" data-testid="kick-path">
      <div>
        <h1 className="text-3xl font-semibold text-white">Kick Drums</h1>
        <p className="mt-1 text-[15px] text-slate-400">Build beats from the sound browser, then use drums to shape a song: breakdown, build-up and drop. Each lesson: learn, do it in the Studio, quick check.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {KICK_PATH.map((m) => (
          <ModuleCard key={m.id} m={m} onOpen={onOpen} ready={ready} />
        ))}
      </div>
    </div>
  );
}
