import { lessonEvents } from "../events";
import { CheckIcon } from "../Icons";
import { SPECIAL_TASKS } from "./specials";

/** The Special task card(s) at the end of a course: one part of the course song each. */
export function SpecialCards({ ids, onOpen }: { ids: string[]; onOpen: (id: string) => void }) {
  return (
    <section className="flex flex-col rounded-2xl border border-amber-300/40 bg-gradient-to-br from-amber-400/[0.12] via-[#16130b] to-[#0f0e0b] p-5 shadow-[0_0_40px_-16px_rgba(251,191,36,0.5)]" data-testid="special-cards">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-300 text-lg text-slate-900" aria-hidden="true">
          ★
        </span>
        <h2 className="text-base font-semibold text-white">{ids.length > 1 ? "Special tasks" : "Special task"}</h2>
      </div>
      <p className="mt-2 text-xs text-amber-100/80">Build a part of the course song, then apply it to your song in the Studio. The last card on the Lessons page puts every part together.</p>
      <ul className="mt-4 flex flex-col gap-1">
        {ids.map((id, i) => {
          const t = SPECIAL_TASKS[id]!;
          const done = lessonEvents.isCompleted(id);
          return (
            <li key={id}>
              <button onClick={() => onOpen(id)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm text-slate-100 hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-amber-300/60 focus-visible:outline-none" data-testid={`path-${id}`}>
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${done ? "bg-emerald-300 text-slate-900" : "bg-amber-300 text-slate-900"}`}>{done ? <CheckIcon size={11} /> : i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{t.title.replace(/^Special task: /, "")}</span>
                {done ? <span className="rounded bg-emerald-300/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-200">Done</span> : <span className="rounded bg-amber-300 px-1.5 py-0.5 text-[10px] font-semibold text-slate-900">Start</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
