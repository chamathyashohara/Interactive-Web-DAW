import { EARLIER_LESSONS, MODULES, isBuilt, moduleProgress, type PathModule } from "./curriculum";
import { lessonEvents } from "./events";
import { CheckIcon, ConceptIcon } from "./Icons";

function ModuleCard({ m, onOpen }: { m: PathModule; onOpen: (subId: string) => void }) {
  const p = moduleProgress(m, lessonEvents.isCompleted);
  return (
    <section className="flex flex-col rounded-2xl border border-white/10 bg-[#11141c] p-5" data-testid={`module-${m.id}`}>
      <div className="flex items-center gap-3">
        <span className="flex h-9 min-w-9 items-center justify-center rounded-lg bg-violet-500/20 px-2 text-sm font-bold text-violet-200">{m.code}</span>
        <h2 className="text-base font-semibold text-white">{m.title}</h2>
      </div>
      <div className="mt-3 flex items-center gap-3 text-xs text-slate-500">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-emerald-300" style={{ width: `${p.built ? (p.done / p.built) * 100 : 0}%` }} />
        </div>
        <span>
          {p.done}/{p.built} ready · {p.total} planned
        </span>
      </div>
      <ul className="mt-4 flex flex-col gap-1">
        {m.items.map((it, i) => {
          const built = isBuilt(it.id);
          const done = lessonEvents.isCompleted(it.id);
          return (
            <li key={it.id}>
              <button
                disabled={!built}
                onClick={() => onOpen(it.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${built ? "text-slate-100 hover:bg-white/5" : "cursor-default text-slate-500"}`}
                data-testid={`path-${it.id}`}
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${done ? "bg-emerald-300 text-slate-900" : built ? "bg-violet-500 text-white" : "ring-1 ring-white/15"}`}>
                  {done ? <CheckIcon size={11} /> : i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{it.title}</span>
                {it.optional && <span className="text-[10px] text-slate-500">optional</span>}
                {built ? <span className="rounded bg-emerald-300/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-200">{done ? "Done" : "Start"}</span> : <span className="text-[10px] text-slate-600">Soon</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The learning path: every module and sub-lesson of the course, with what is ready to open. */
export function LearningPath({ onOpenSub, onOpenEarlier }: { onOpenSub: (id: string) => void; onOpenEarlier: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-5" data-testid="learning-path">
      <div>
        <h1 className="text-3xl font-semibold text-white">Learning path</h1>
        <p className="mt-1 text-[15px] text-slate-400">Learn music production step by step. Each sub-lesson: hook, watch, try, practice, quick check.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {MODULES.map((m) => (
          <ModuleCard key={m.id} m={m} onOpen={onOpenSub} />
        ))}
        <section className="flex flex-col rounded-2xl border border-white/10 bg-[#11141c] p-5" data-testid="module-earlier">
          <h2 className="text-base font-semibold text-white">Earlier lessons</h2>
          <p className="mt-1 text-xs text-slate-500">Short single-exercise lessons. They will be folded into the modules above.</p>
          <ul className="mt-4 flex flex-col gap-1">
            {EARLIER_LESSONS.map((l) => (
              <li key={l.id}>
                <button onClick={() => onOpenEarlier(l.id)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm text-slate-100 hover:bg-white/5" data-testid={`earlier-${l.id}`}>
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/20 text-violet-200">
                    <ConceptIcon concept={l.concept} size={15} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{l.title}</span>
                  {lessonEvents.isCompleted(l.id) && <span className="rounded bg-emerald-300/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-200">Done</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
