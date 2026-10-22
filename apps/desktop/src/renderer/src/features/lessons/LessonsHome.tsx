import type { ReactNode } from "react";
import { MODULES, moduleProgress } from "./curriculum";
import { lessonEvents } from "./events";
import { ArrowRight, CheckIcon, DrumIcon, FadersIcon, GridIcon, PadsIcon, PianoKeysIcon } from "./Icons";
import { coursePath } from "./studio/CoursePath";
import { MAIN_LESSONS, type Accent, type MainLesson, type MainLessonId } from "./mainLessons";

/** Colour sets for the four cards (full class names, so Tailwind keeps them). */
export const ACCENTS: Record<Accent, { card: string; tile: string; check: string; button: string; text: string; bar: string }> = {
  teal: {
    card: "border-emerald-300/40 bg-gradient-to-br from-emerald-400/[0.13] via-[#0e1719] to-[#0b0f14] shadow-[0_0_44px_-14px_rgba(52,211,153,0.55)] hover:border-emerald-300/70",
    tile: "bg-emerald-400/20 text-emerald-200 ring-1 ring-emerald-300/30",
    check: "bg-emerald-400 text-slate-900",
    button: "bg-emerald-300 text-slate-900 hover:bg-emerald-200 focus-visible:ring-emerald-200",
    text: "text-emerald-300",
    bar: "bg-emerald-300",
  },
  purple: {
    card: "border-violet-400/40 bg-gradient-to-br from-violet-500/[0.16] via-[#141127] to-[#0c0c16] shadow-[0_0_44px_-14px_rgba(167,139,250,0.55)] hover:border-violet-400/70",
    tile: "bg-violet-500/25 text-violet-100 ring-1 ring-violet-400/30",
    check: "bg-violet-400 text-slate-900",
    button: "bg-violet-500 text-white hover:bg-violet-400 focus-visible:ring-violet-300",
    text: "text-violet-300",
    bar: "bg-violet-400",
  },
  rose: {
    card: "border-rose-400/40 bg-gradient-to-br from-rose-500/[0.14] via-[#1a1016] to-[#100c10] shadow-[0_0_44px_-14px_rgba(251,113,133,0.5)] hover:border-rose-400/70",
    tile: "bg-rose-500/25 text-rose-100 ring-1 ring-rose-400/30",
    check: "bg-rose-400 text-slate-900",
    button: "bg-rose-500 text-white hover:bg-rose-400 focus-visible:ring-rose-300",
    text: "text-rose-300",
    bar: "bg-rose-400",
  },
  blue: {
    card: "border-sky-400/40 bg-gradient-to-br from-sky-500/[0.15] via-[#0d1626] to-[#0b0e16] shadow-[0_0_44px_-14px_rgba(56,189,248,0.5)] hover:border-sky-400/70",
    tile: "bg-sky-500/25 text-sky-100 ring-1 ring-sky-400/30",
    check: "bg-sky-400 text-slate-900",
    button: "bg-sky-500 text-white hover:bg-sky-400 focus-visible:ring-sky-300",
    text: "text-sky-300",
    bar: "bg-sky-400",
  },
  amber: {
    card: "border-amber-400/40 bg-gradient-to-br from-amber-500/[0.14] via-[#1a150d] to-[#0f0d0b] shadow-[0_0_44px_-14px_rgba(251,191,36,0.5)] hover:border-amber-400/70",
    tile: "bg-amber-500/25 text-amber-100 ring-1 ring-amber-400/30",
    check: "bg-amber-400 text-slate-900",
    button: "bg-amber-400 text-slate-900 hover:bg-amber-300 focus-visible:ring-amber-200",
    text: "text-amber-300",
    bar: "bg-amber-400",
  },
};

const ICONS: Record<MainLessonId, (p: { size?: number }) => ReactNode> = { piano: PianoKeysIcon, kick: DrumIcon, sequencer: PadsIcon, mixing: FadersIcon, daw: GridIcon };

/** Decorative pictures in each card's top-right corner (hidden from screen readers). */
function Illustration({ id }: { id: MainLessonId }) {
  const common = "pointer-events-none absolute top-0 right-0 h-40 w-56 opacity-80";
  switch (id) {
    case "piano":
      return (
        <svg className={common} viewBox="0 0 224 160" aria-hidden="true">
          <defs>
            <linearGradient id="pk" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stopColor="#34d399" stopOpacity="0.9" />
              <stop offset="1" stopColor="#34d399" stopOpacity="0.1" />
            </linearGradient>
          </defs>
          <g transform="translate(60 18) skewX(-28) rotate(-8)">
            {Array.from({ length: 9 }, (_, i) => (
              <rect key={i} x={i * 18} y="0" width="16" height="96" rx="2" fill="url(#pk)" opacity={0.25 + i * 0.07} />
            ))}
            {[0, 1, 3, 4, 5, 7].map((i) => (
              <rect key={`b${i}`} x={i * 18 + 11} y="0" width="11" height="58" rx="2" fill="#0b1114" />
            ))}
          </g>
        </svg>
      );
    case "kick":
      return (
        <svg className={common} viewBox="0 0 224 160" aria-hidden="true">
          <circle cx="150" cy="70" r="56" fill="none" stroke="#a78bfa" strokeOpacity="0.55" strokeWidth="2" />
          <circle cx="150" cy="70" r="40" fill="none" stroke="#a78bfa" strokeOpacity="0.35" strokeWidth="1.5" />
          <ellipse cx="150" cy="70" rx="18" ry="18" fill="#a78bfa" fillOpacity="0.12" />
          <path d="M120 140 L175 90" stroke="#c4b5fd" strokeOpacity="0.8" strokeWidth="4" strokeLinecap="round" />
          <circle cx="178" cy="88" r="6" fill="#c4b5fd" fillOpacity="0.85" />
        </svg>
      );
    case "sequencer":
      return (
        <svg className={common} viewBox="0 0 224 160" aria-hidden="true">
          {Array.from({ length: 4 }, (_, r) =>
            Array.from({ length: 8 }, (_, c) => {
              const on = (r === 0 && c % 2 === 0) || (r === 1 && (c === 2 || c === 6)) || (r === 2 && c >= 4);
              return <rect key={`${r}-${c}`} x={70 + c * 18} y={24 + r * 22} width="14" height="16" rx="3" fill="#fb7185" fillOpacity={on ? 0.85 : 0.12} />;
            }),
          )}
          <circle cx="79" cy="14" r="3" fill="#fcd34d" />
        </svg>
      );
    case "mixing":
      return (
        <svg className={common} viewBox="0 0 224 160" aria-hidden="true">
          <path d="M20 80 L30 70 L36 92 L44 56 L52 100 L60 64 L68 88 L76 76 L84 80" fill="none" stroke="#38bdf8" strokeOpacity="0.5" strokeWidth="1.5" />
          {[110, 140, 170, 200].map((x, i) => (
            <g key={x}>
              <line x1={x} x2={x} y1="18" y2="130" stroke="#38bdf8" strokeOpacity="0.45" strokeWidth="2" />
              <rect x={x - 7} y={[50, 80, 40, 66][i]} width="14" height="12" rx="2" fill="#38bdf8" fillOpacity="0.85" />
            </g>
          ))}
        </svg>
      );
    case "daw":
      return (
        <svg className={common} viewBox="0 0 224 160" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((r) => (
            <rect key={r} x="40" y={22 + r * 22} width="176" height="18" rx="3" fill="#ffffff" fillOpacity="0.04" />
          ))}
          <rect x="44" y="26" width="34" height="10" rx="2" fill="#a855f7" fillOpacity="0.85" />
          <rect x="74" y="48" width="70" height="10" rx="2" fill="#3b82f6" fillOpacity="0.85" />
          <rect x="96" y="70" width="64" height="10" rx="2" fill="#10b981" fillOpacity="0.85" />
          <rect x="150" y="92" width="62" height="10" rx="2" fill="#f59e0b" fillOpacity="0.9" />
          <line x1="150" x2="150" y1="14" y2="140" stroke="#ffffff" strokeOpacity="0.75" strokeWidth="1.5" />
          <circle cx="150" cy="14" r="3" fill="#ffffff" />
        </svg>
      );
  }
}

export interface MainLessonCardProps {
  lesson: MainLesson;
  onOpen: () => void;
  /** Shown for collections with content: how far the learner has got. */
  progress?: { done: number; total: number };
}

/** One main lesson: icon, title, description, topic checklist, picture and a View Lessons button. */
export function MainLessonCard({ lesson, onOpen, progress }: MainLessonCardProps) {
  const a = ACCENTS[lesson.accent];
  const Icon = ICONS[lesson.id];
  const headingId = `main-lesson-${lesson.id}`;
  return (
    <article
      aria-labelledby={headingId}
      onClick={onOpen}
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-2xl border p-6 transition-colors ${a.card}`}
      data-testid={`main-card-${lesson.id}`}
    >
      <Illustration id={lesson.id} />
      <span className={`relative flex h-14 w-14 items-center justify-center rounded-2xl ${a.tile}`}>
        <Icon size={30} />
      </span>
      <h2 id={headingId} className="relative mt-5 text-2xl font-semibold text-white">
        {lesson.title}
      </h2>
      <p className="relative mt-2 max-w-sm text-[15px] leading-relaxed text-slate-300">{lesson.description}</p>
      <ul className="relative mt-5 flex flex-1 flex-col gap-2.5" aria-label={`${lesson.title} topics`}>
        {lesson.topics.map((t) => (
          <li key={t} className="flex items-center gap-3 text-[15px] text-slate-200">
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${a.check}`}>
              <CheckIcon size={12} />
            </span>
            {t}
          </li>
        ))}
      </ul>
      {progress && progress.total > 0 && (
        <div className="relative mt-5" data-testid={`main-progress-${lesson.id}`}>
          <div className="flex justify-between text-xs text-slate-400">
            <span>Your progress</span>
            <span>
              {progress.done} of {progress.total} sub-lessons done
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className={`h-full rounded-full ${a.bar}`} style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        </div>
      )}
      {!lesson.available && <div className={`relative mt-5 text-xs font-semibold tracking-wide uppercase ${a.text}`}>Coming soon</div>}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className={`relative mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-[15px] font-semibold transition-colors outline-none focus-visible:ring-2 ${a.button}`}
        aria-label={`View ${lesson.title} lessons${lesson.available ? "" : " (coming soon)"}`}
        data-testid={`open-${lesson.id}`}
      >
        View Lessons <ArrowRight size={18} />
      </button>
    </article>
  );
}

/** Soft waveform lines behind the heading. */
function WaveBackdrop() {
  return (
    <svg className="pointer-events-none absolute inset-x-0 top-0 h-64 w-full" viewBox="0 0 1200 260" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 200 C 150 40, 260 40, 380 160 S 620 260, 760 150" fill="none" stroke="#34d399" strokeOpacity="0.28" strokeWidth="1.5" />
      <path d="M560 210 C 700 260, 820 60, 960 120 S 1120 230, 1200 60" fill="none" stroke="#a78bfa" strokeOpacity="0.3" strokeWidth="1.5" />
      <path d="M760 240 C 880 120, 980 220, 1200 140" fill="none" stroke="#38bdf8" strokeOpacity="0.18" strokeWidth="1.2" />
    </svg>
  );
}

/** The main Lessons page: the entry to the learning system. */
export function LessonsHome({ onOpen }: { onOpen: (id: MainLessonId) => void }) {
  const piano = MODULES.reduce(
    (acc, m) => {
      const p = moduleProgress(m, lessonEvents.isCompleted);
      return { done: acc.done + p.done, total: acc.total + p.built };
    },
    { done: 0, total: 0 },
  );
  const courseProgress = (id: "kick" | "sequencer") =>
    coursePath(id).reduce(
      (acc, m) => {
        const p = moduleProgress(m, lessonEvents.isCompleted, () => true);
        return { done: acc.done + p.done, total: acc.total + p.built };
      },
      { done: 0, total: 0 },
    );
  const kick = courseProgress("kick");
  return (
    <div className="relative" data-testid="lessons-home">
      <WaveBackdrop />
      <div className="relative mx-auto max-w-5xl px-2 pt-6 pb-4 text-center">
        <div className="text-xs font-medium tracking-[0.45em] text-slate-400 uppercase">Welcome to Waveform / Studio</div>
        <h1 className="mt-4 text-4xl font-bold text-white md:text-5xl">
          What would you like to{" "}
          <span className="bg-gradient-to-r from-emerald-300 via-sky-400 to-violet-400 bg-clip-text text-transparent">learn?</span>
        </h1>
        <p className="mt-4 text-base text-slate-300 md:text-lg">Choose a main lesson to start your journey. Build real skills. Create your sound.</p>
      </div>
      <div className="relative mx-auto mt-8 grid max-w-5xl grid-cols-1 gap-6 md:grid-cols-2" data-testid="main-lessons-grid">
        {MAIN_LESSONS.map((l) => (
          <MainLessonCard key={l.id} lesson={l} onOpen={() => onOpen(l.id)} progress={l.id === "piano" ? piano : l.id === "kick" ? kick : l.id === "sequencer" ? courseProgress("sequencer") : undefined} />
        ))}
      </div>
      <div className="relative mt-8 flex items-center justify-center gap-4 text-sm text-slate-400">
        <span className="h-px w-14 bg-white/15" />
        You can always switch later
        <span className="h-px w-14 bg-white/15" />
      </div>
    </div>
  );
}
