import { ArrowLeft, ArrowRight } from "./Icons";
import { ACCENTS } from "./LessonsHome";
import type { MainLesson, RelatedLesson } from "./mainLessons";

/**
 * A main lesson whose own lesson pages do not exist yet: a clear, intentional "not available yet" page that lists what
 * it will cover and links to the related lessons that already exist. Replace with the real collection when it is built.
 */
export function CollectionPage({ lesson, onBack, onOpenRelated }: { lesson: MainLesson; onBack: () => void; onOpenRelated: (r: RelatedLesson) => void }) {
  const a = ACCENTS[lesson.accent];
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5" data-testid={`collection-${lesson.id}`}>
      <button onClick={onBack} className="flex items-center gap-2 self-start text-sm text-slate-400 hover:text-slate-200" data-testid="back-to-lessons">
        <ArrowLeft size={16} /> Back to Lessons
      </button>
      <div>
        <h1 className="text-3xl font-semibold text-white">{lesson.title}</h1>
        <p className="mt-1 text-[15px] text-slate-400">{lesson.description}</p>
      </div>
      <div className={`rounded-2xl border p-5 ${a.card}`} role="status" data-testid="not-available">
        <div className={`text-xs font-semibold tracking-widest uppercase ${a.text}`}>Coming soon</div>
        <p className="mt-1 text-[15px] text-slate-200">The {lesson.title} lessons are not available yet. They will appear here when they are ready.</p>
      </div>
      <section aria-label="Planned topics" className="rounded-2xl border border-white/10 bg-[#11141c] p-5">
        <h2 className="text-base font-semibold text-white">What this course will cover</h2>
        <ol className="mt-3 flex flex-col gap-1">
          {lesson.topics.map((t, i) => (
            <li key={t} className="flex items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm text-slate-400">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ring-1 ring-white/15">{i + 1}</span>
              <span className="flex-1">{t}</span>
              <span className="text-[10px] text-slate-600">Soon</span>
            </li>
          ))}
        </ol>
      </section>
      {lesson.related.length > 0 && (
        <section aria-label="Related lessons you can take now" className="rounded-2xl border border-white/10 bg-[#11141c] p-5">
          <h2 className="text-base font-semibold text-white">Available now</h2>
          <p className="mt-1 text-sm text-slate-400">These existing lessons cover part of this topic.</p>
          <ul className="mt-3 flex flex-col gap-2">
            {lesson.related.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => onOpenRelated(r)}
                  className="flex w-full items-center gap-3 rounded-xl bg-white/[0.03] px-4 py-3 text-left ring-1 ring-white/10 hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
                  data-testid={`related-${r.id}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-slate-100">{r.title}</span>
                    <span className="block text-xs text-slate-400">{r.why}</span>
                  </span>
                  <ArrowRight size={16} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
