import { useEffect, useState } from "react";
import type { Project } from "@daw/shared";
import { LESSONS } from "./content";
import { BUILT, MODULES, searchPath, type PathHit } from "./curriculum";
import { lessonEvents } from "./events";
import { ArrowLeft, ArrowRight, BookIcon, ConceptIcon, SearchIcon, SpeakerIcon } from "./Icons";
import { overallProgress } from "./learnModel";
import { LearningPath } from "./LearningPath";
import { LessonPage } from "./LessonPage";
import { onVoicesReady, speechAvailable, stopSpeaking } from "./speech";
import { browserStore, readJson, writeJson } from "./storage";
import { StudySection } from "./StudySection";
import { SubLessonPage } from "./SubLessonPage";

if (import.meta.env.DEV) lessonEvents.onLessonCompleted((e) => console.info("[lessons] lesson-completed", e));

const store = browserStore();
const VOICE_KEY = "lessons.voice.v1";

export interface LearnViewProps {
  project: Project;
  /** Shows a track/clip in the studio's arrangement and piano roll (App's own selection). */
  onOpenClip: (trackId: string, clipId: string | null) => void;
  /** Back to the studio. */
  onExit: () => void;
}

type View = { kind: "path" } | { kind: "sub"; id: string } | { kind: "earlier"; id: string };

function PathSearch({ onOpen }: { onOpen: (hit: PathHit) => void }) {
  const [query, setQuery] = useState("");
  const results = searchPath(query);
  const open = (hit: PathHit) => {
    if (!hit.built) return;
    onOpen(hit);
    setQuery("");
  };
  return (
    <div className="relative w-[360px]">
      <div className="flex items-center gap-2.5 rounded-xl bg-white/5 px-3.5 py-2 ring-1 ring-white/10 focus-within:ring-violet-400/50">
        <SearchIcon size={17} className="text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) open(results[0]);
            if (e.key === "Escape") setQuery("");
          }}
          placeholder="Search lessons, topics…"
          className="min-w-0 flex-1 bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-500"
          aria-label="Search lessons"
          data-testid="learn-search"
        />
      </div>
      {query.trim() && (
        <div className="absolute top-full right-0 left-0 z-30 mt-2 max-h-80 overflow-y-auto rounded-xl border border-white/10 bg-[#161a23] shadow-2xl">
          {results.length ? (
            results.map((h) => (
              <button
                key={`${h.kind}-${h.id}`}
                onClick={() => open(h)}
                disabled={!h.built}
                className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-white/5 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                data-testid={`learn-result-${h.id}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-100">{h.title}</span>
                  <span className="block truncate text-xs text-slate-400">{h.where}</span>
                </span>
                <span className="text-[10px] text-slate-500">{h.built ? "Open" : "Soon"}</span>
              </button>
            ))
          ) : (
            <div className="px-3.5 py-3 text-sm text-slate-500">No lessons match “{query.trim()}”.</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Full-page learning space: the learning path and its lessons with the real piano roll, opened from the studio's Lessons button. */
export function LearnView({ project, onOpenClip, onExit }: LearnViewProps) {
  const [, bump] = useState(0);
  useEffect(() => lessonEvents.onLessonCompleted(() => bump((n) => n + 1)), []);
  const [view, setView] = useState<View>({ kind: "path" });

  const [voice, setVoice] = useState(() => readJson(store, VOICE_KEY, false));
  const [canSpeak, setCanSpeak] = useState(speechAvailable);
  useEffect(() => onVoicesReady(() => setCanSpeak(speechAvailable())), []);
  useEffect(() => () => stopSpeaking(), []);

  const show = (v: View) => {
    stopSpeaking();
    setView(v);
  };
  const exit = () => {
    stopSpeaking();
    onExit();
  };
  const openHit = (h: PathHit) => show(h.kind === "sub" ? { kind: "sub", id: h.id } : { kind: "earlier", id: h.id });

  const sub = view.kind === "sub" ? BUILT[view.id] : undefined;
  const earlierIndex = view.kind === "earlier" ? LESSONS.findIndex((l) => l.id === view.id) : -1;
  const earlier = earlierIndex >= 0 ? LESSONS[earlierIndex] : undefined;
  const progress = overallProgress(LESSONS, lessonEvents.isCompleted);
  const module = sub ? MODULES.find((m) => m.id === sub.moduleId) : undefined;

  return (
    <div className="flex h-full flex-col bg-[#0b0d13] text-slate-300" data-testid="learn-view">
      <header className="flex items-center gap-4 border-b border-white/10 bg-[#0e1118] px-6 py-3">
        <button onClick={() => show({ kind: "path" })} className="flex items-center gap-2.5" title="Learning path" data-testid="learn-home">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-300/15 text-emerald-300">
            <BookIcon size={19} />
          </span>
          <span className="text-sm font-semibold tracking-wide text-slate-100">Learn</span>
        </button>
        <PathSearch onOpen={openHit} />
        <div className="ml-auto flex items-center gap-3">
          {canSpeak && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-400" title="Read each step aloud as it opens">
              <SpeakerIcon size={16} />
              Voice guidance
              <input
                type="checkbox"
                checked={voice}
                onChange={(e) => {
                  setVoice(e.target.checked);
                  writeJson(store, VOICE_KEY, e.target.checked);
                }}
                className="h-4 w-4 accent-emerald-400"
                data-testid="learn-voice"
              />
            </label>
          )}
          <button onClick={exit} className="flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500" data-testid="learn-exit">
            Open Studio <ArrowRight size={16} />
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-4 pb-5">
        {view.kind === "path" && <LearningPath onOpenSub={(id) => show({ kind: "sub", id })} onOpenEarlier={(id) => show({ kind: "earlier", id })} />}

        {view.kind !== "path" && (
          <button onClick={() => show({ kind: "path" })} className="flex items-center gap-2 self-start text-sm text-slate-400 hover:text-slate-200" data-testid="learn-back-path">
            <ArrowLeft size={16} /> Back to Learning Path
          </button>
        )}

        {sub && (
          <>
            <div className="flex flex-wrap items-center gap-5">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-500 text-white shadow-lg shadow-violet-500/25">
                <ConceptIcon concept={sub.concept} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold tracking-widest text-violet-300 uppercase">
                  {module?.code} · {module?.title}
                </div>
                <h1 className="mt-0.5 text-3xl font-semibold text-white" data-testid="learn-title">
                  {sub.title}
                </h1>
                <p className="mt-1 text-[15px] text-slate-400">{sub.summary}</p>
              </div>
            </div>
            <SubLessonPage
              key={sub.id}
              sub={sub}
              project={project}
              onOpenClip={onOpenClip}
              onExit={exit}
              onBackToPath={() => show({ kind: "path" })}
              voice={voice}
              canSpeak={canSpeak}
            />
          </>
        )}

        {earlier && (
          <>
            <div className="flex flex-wrap items-center gap-5">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-500 text-white shadow-lg shadow-violet-500/25">
                <ConceptIcon concept={earlier.concept} />
              </span>
              <div className="min-w-0 flex-1">
                <h1 className="text-3xl font-semibold text-white" data-testid="learn-title">
                  {earlier.title}
                </h1>
                <p className="mt-1 text-[15px] text-slate-400">{earlier.summary}</p>
              </div>
              <div className="w-60">
                <div className="text-sm text-slate-400">
                  Earlier lesson {earlierIndex + 1} of {LESSONS.length}
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-emerald-300 transition-all" style={{ width: `${progress.percent}%` }} />
                  </div>
                  <span className="text-sm text-slate-200" data-testid="learn-progress">
                    {progress.percent}%
                  </span>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => show({ kind: "earlier", id: LESSONS[earlierIndex - 1]!.id })} disabled={earlierIndex === 0} className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-200 ring-1 ring-white/15 hover:bg-white/5 disabled:opacity-35" data-testid="learn-prev">
                  <ArrowLeft size={16} /> Previous
                </button>
                <button onClick={() => show({ kind: "earlier", id: LESSONS[earlierIndex + 1]!.id })} disabled={earlierIndex === LESSONS.length - 1} className="flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-35" data-testid="learn-next">
                  Next <ArrowRight size={16} />
                </button>
              </div>
            </div>
            <LessonPage
              key={earlier.id}
              lesson={earlier}
              project={project}
              onOpenClip={onOpenClip}
              onExit={exit}
              onNextLesson={earlierIndex < LESSONS.length - 1 ? () => show({ kind: "earlier", id: LESSONS[earlierIndex + 1]!.id }) : null}
              voice={voice}
              canSpeak={canSpeak}
            />
          </>
        )}

        <StudySection />
      </main>
    </div>
  );
}
