import { useEffect, useState } from "react";
import type { Project } from "@daw/shared";
import { LESSONS } from "./content";
import { lessonEvents } from "./events";
import { ArrowLeft, ArrowRight, BookIcon, ConceptIcon, SearchIcon, SpeakerIcon } from "./Icons";
import { overallProgress, searchLessons } from "./learnModel";
import { LessonPage } from "./LessonPage";
import { onVoicesReady, speechAvailable, stopSpeaking } from "./speech";
import { browserStore, readJson, writeJson } from "./storage";
import { StudySection } from "./StudySection";

if (import.meta.env.DEV) lessonEvents.onLessonCompleted((e) => console.info("[lessons] lesson-completed", e));

const store = browserStore();
const LAST_KEY = "lessons.last.v1";
const VOICE_KEY = "lessons.voice.v1";

export interface LearnViewProps {
  project: Project;
  /** Shows a track/clip in the studio's arrangement and piano roll (App's own selection). */
  onOpenClip: (trackId: string, clipId: string | null) => void;
  /** Back to the studio. */
  onExit: () => void;
}

function LessonSearch({ onOpen }: { onOpen: (lessonId: string) => void }) {
  const [query, setQuery] = useState("");
  const results = searchLessons(LESSONS, query);
  const open = (id: string) => {
    onOpen(id);
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
            if (e.key === "Enter" && results[0]) open(results[0].id);
            if (e.key === "Escape") setQuery("");
          }}
          placeholder="Search lessons, topics…"
          className="min-w-0 flex-1 bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-500"
          aria-label="Search lessons"
          data-testid="learn-search"
        />
      </div>
      {query.trim() && (
        <div className="absolute top-full right-0 left-0 z-30 mt-2 overflow-hidden rounded-xl border border-white/10 bg-[#161a23] shadow-2xl">
          {results.length ? (
            results.map((l) => (
              <button key={l.id} onClick={() => open(l.id)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-white/5" data-testid={`learn-result-${l.id}`}>
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/20 text-violet-200">
                  <ConceptIcon concept={l.concept} size={17} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm text-slate-100">{l.title}</span>
                  <span className="block truncate text-xs text-slate-400">{l.summary}</span>
                </span>
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

/** Full-page learning space: the lesson series with the real piano roll, opened from the studio's Lessons button. */
export function LearnView({ project, onOpenClip, onExit }: LearnViewProps) {
  const [, bump] = useState(0);
  useEffect(() => lessonEvents.onLessonCompleted(() => bump((n) => n + 1)), []);

  const [lessonId, setLessonId] = useState(() => {
    const last = readJson<string | null>(store, LAST_KEY, null);
    if (LESSONS.some((l) => l.id === last)) return last!;
    return LESSONS.find((l) => !lessonEvents.isCompleted(l.id))?.id ?? LESSONS[0]!.id;
  });
  useEffect(() => writeJson(store, LAST_KEY, lessonId), [lessonId]);

  const [voice, setVoice] = useState(() => readJson(store, VOICE_KEY, false));
  const [canSpeak, setCanSpeak] = useState(speechAvailable);
  useEffect(() => onVoicesReady(() => setCanSpeak(speechAvailable())), []);
  useEffect(() => () => stopSpeaking(), []);

  const index = LESSONS.findIndex((l) => l.id === lessonId);
  const lesson = LESSONS[index]!;
  const progress = overallProgress(LESSONS, lessonEvents.isCompleted);
  const go = (i: number) => {
    stopSpeaking();
    setLessonId(LESSONS[i]!.id);
  };
  const exit = () => {
    stopSpeaking();
    onExit();
  };

  return (
    <div className="flex h-full flex-col bg-[#0b0d13] text-slate-300" data-testid="learn-view">
      <header className="flex items-center gap-4 border-b border-white/10 bg-[#0e1118] px-6 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-300/15 text-emerald-300">
            <BookIcon size={19} />
          </span>
          <span className="text-sm font-semibold tracking-wide text-slate-100">Learn</span>
        </div>
        <LessonSearch onOpen={setLessonId} />
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
        <button onClick={exit} className="flex items-center gap-2 self-start text-sm text-slate-400 hover:text-slate-200">
          <ArrowLeft size={16} /> Back to Studio
        </button>

        <div className="flex flex-wrap items-center gap-5">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-500 text-white shadow-lg shadow-violet-500/25">
            <ConceptIcon concept={lesson.concept} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-semibold text-white" data-testid="learn-title">
              {lesson.title}
            </h1>
            <p className="mt-1 text-[15px] text-slate-400">{lesson.summary}</p>
          </div>
          <div className="w-60">
            <div className="text-sm text-slate-400">
              Lesson {index + 1} of {LESSONS.length}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-emerald-300 transition-all" style={{ width: `${progress.percent}%` }} />
              </div>
              <span className="text-sm text-slate-200" data-testid="learn-progress">
                {progress.percent}%
              </span>
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              {progress.done} of {progress.total} lessons complete
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => go(index - 1)} disabled={index === 0} className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-200 ring-1 ring-white/15 hover:bg-white/5 disabled:opacity-35" data-testid="learn-prev">
              <ArrowLeft size={16} /> Previous
            </button>
            <button onClick={() => go(index + 1)} disabled={index === LESSONS.length - 1} className="flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-35" data-testid="learn-next">
              Next <ArrowRight size={16} />
            </button>
          </div>
        </div>

        <LessonPage
          key={lesson.id}
          lesson={lesson}
          project={project}
          onOpenClip={onOpenClip}
          onExit={exit}
          onNextLesson={index < LESSONS.length - 1 ? () => go(index + 1) : null}
          voice={voice}
          canSpeak={canSpeak}
        />

        <StudySection />
      </main>
    </div>
  );
}
