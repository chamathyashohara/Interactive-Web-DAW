import { useEffect, useState } from "react";
import type { Project } from "@daw/shared";
import { LESSONS } from "./content";
import { BUILT, MODULES, nextBuilt, searchPath, type PathHit } from "./curriculum";
import { lessonEvents } from "./events";
import { CollectionPage } from "./CollectionPage";
import { ArrowLeft, ArrowRight, BellIcon, BookIcon, ConceptIcon, DrumIcon, FolderIcon, GearIcon, HomeIcon, LogoutIcon, MusicIcon, PadsIcon, SearchIcon, SpeakerIcon, UsersIcon, WaveLogoIcon } from "./Icons";
import { overallProgress } from "./learnModel";
import { LearningPath } from "./LearningPath";
import { LessonPage } from "./LessonPage";
import { LessonsHome } from "./LessonsHome";
import { mainLesson, type MainLessonId, type RelatedLesson } from "./mainLessons";
import { onVoicesReady, speechAvailable, stopSpeaking } from "./speech";
import { browserStore, readJson, writeJson } from "./storage";
import { lessonState, type LearnViewState } from "./lessonState";
import { StudySection } from "./StudySection";
import { studyLog } from "./studyLog";
import { CoursePath } from "./studio/CoursePath";
import { applyCopiesOps, parkLessonWork } from "./studio/park";
import { COURSES, STUDIO_LESSONS, courseOf, nextStudioLesson, studioModuleOf } from "./studio/courses";
import { StudioLessonPage } from "./studio/StudioLessonPage";
import { studioState } from "./studio/studioState";
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

type View = LearnViewState;

/** The view saved last time, if it still exists (a sub-lesson or lesson could have been renamed or removed). */
function restoredView(): View {
  const v = lessonState.view();
  if (v.kind === "sub" && BUILT[v.id]) return v;
  if (v.kind === "earlier" && LESSONS.some((l) => l.id === v.id)) return v;
  if (v.kind === "collection" && mainLesson(v.id)) return v;
  if (v.kind === "path" || v.kind === "kick" || v.kind === "sequencer") return v;
  if (v.kind === "studio" && STUDIO_LESSONS[v.id]) return v;
  return { kind: "lessons" };
}

interface NavItem {
  label: string;
  Icon: (p: { size?: number }) => React.JSX.Element;
  /** Missing when the feature does not exist in this app yet: shown, but clearly not available. */
  onClick?: () => void;
  active?: boolean;
  testId?: string;
}

function NavButton({ item }: { item: NavItem }) {
  const available = Boolean(item.onClick);
  return (
    <button
      type="button"
      onClick={item.onClick}
      disabled={!available}
      aria-current={item.active ? "page" : undefined}
      title={available ? item.label : `${item.label}: not available yet`}
      aria-label={item.label}
      className={`relative flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 ${
        item.active ? "bg-emerald-400/10 font-semibold text-white ring-1 ring-emerald-300/25" : available ? "text-slate-300 hover:bg-white/5 hover:text-white" : "cursor-not-allowed text-slate-600"
      }`}
      data-testid={item.testId}
    >
      <span className={item.active ? "text-emerald-300" : ""}>
        <item.Icon size={18} />
      </span>
      <span className="hidden md:inline">{item.label}</span>
      {!available && <span className="hidden text-[10px] text-slate-600 lg:inline">Soon</span>}
      {item.active && <span className="absolute inset-x-3 -bottom-1.5 h-0.5 rounded-full bg-emerald-300" aria-hidden="true" />}
    </button>
  );
}

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

// The app opens in the Studio: lesson tracks left in the song by a previous session go back to their lesson.
if (typeof window !== "undefined" && window.daw) void parkLessonWork();

/** Full-page learning space: the learning path and its lessons with the real piano roll, opened from the studio's Lessons button. */
export function LearnView({ project, onOpenClip, onExit }: LearnViewProps) {
  const [, bump] = useState(0);
  useEffect(() => lessonEvents.onLessonCompleted(() => bump((n) => n + 1)), []);
  const [view, setView] = useState<View>(restoredView);

  const [voice, setVoice] = useState(() => readJson(store, VOICE_KEY, false));
  const [canSpeak, setCanSpeak] = useState(speechAvailable);
  useEffect(() => onVoicesReady(() => setCanSpeak(speechAvailable())), []);
  useEffect(() => () => stopSpeaking(), []);

  const show = (v: View) => {
    stopSpeaking();
    setView(v);
    lessonState.setView(v);
  };
  /** To the Studio. A Kick / Drum sequencer lesson's tracks stay with the lesson (saved), never in the song by themselves. */
  const exit = () => {
    stopSpeaking();
    void parkLessonWork().then(() => onExit());
  };
  /** "Apply it in the studio" (Kick / Drum sequencer): copies of the lesson's tracks become the learner's own tracks. */
  const applyStudio = async () => {
    stopSpeaking();
    const { ops, open } = applyCopiesOps((await window.daw.getInitial()).project, () => crypto.randomUUID());
    if (!(await parkLessonWork(ops))) return;
    if (open) onOpenClip(open.trackId, open.clipId);
    onExit();
  };
  /** Opens a sub-lesson; one the learner finished starts again from Hook (see `lessonState.replaySub`). */
  const openSub = (id: string) => {
    lessonState.replaySub(id);
    show({ kind: "sub", id });
  };
  const openHit = (h: PathHit) => (h.kind === "sub" ? openSub(h.id) : show({ kind: "earlier", id: h.id }));
  /** Piano opens the L1-L6 learning path, Kick Drums and Drum sequencer their own courses; the others a collection page. */
  const openMain = (id: MainLessonId) => show(id === "piano" ? { kind: "path" } : id === "kick" || id === "sequencer" ? { kind: id } : { kind: "collection", id });
  /** Opens a studio lesson (Kick Drums, Drum sequencer); a finished one starts again from Hook. */
  const openStudio = (id: string) => {
    studioState.replay(id);
    show({ kind: "studio", id });
  };
  const openRelated = (r: RelatedLesson) => (r.kind === "sub" ? openSub(r.id) : show({ kind: "earlier", id: r.id }));
  const participant = studyLog.session()?.participant ?? null;

  const sub = view.kind === "sub" ? BUILT[view.id] : undefined;
  const studio = view.kind === "studio" ? STUDIO_LESSONS[view.id] : undefined;
  const studioModule = studio ? studioModuleOf(studio.id) : undefined;
  const studioCourse = studio ? courseOf(studio.id) : undefined;
  const earlierIndex = view.kind === "earlier" ? LESSONS.findIndex((l) => l.id === view.id) : -1;
  const earlier = earlierIndex >= 0 ? LESSONS[earlierIndex] : undefined;
  const progress = overallProgress(LESSONS, lessonEvents.isCompleted);
  const module = sub ? MODULES.find((m) => m.id === sub.moduleId) : undefined;

  return (
    <div className="flex h-full flex-col bg-[#0b0d13] text-slate-300" data-testid="learn-view">
      <header className="flex items-center gap-4 border-b border-white/10 bg-[#0e1118] px-4 py-3 lg:px-6">
        <button onClick={() => show({ kind: "lessons" })} className="flex shrink-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60" title="Lessons" aria-label="Waveform Studio: all lessons" data-testid="learn-home">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl text-emerald-300 ring-1 ring-emerald-300/50">
            <WaveLogoIcon size={20} />
          </span>
          <span className="hidden text-[15px] font-semibold tracking-wide text-white sm:inline">
            WAVEFORM <span className="font-normal text-slate-400">/ STUDIO</span>
          </span>
        </button>
        {(view.kind === "path" || view.kind === "sub" || view.kind === "earlier") && <PathSearch onOpen={openHit} />}
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
          <span className="h-8 w-px bg-white/10" />
          <button type="button" disabled title="No notifications" aria-label="Notifications (none)" className="text-slate-500">
            <BellIcon size={20} />
          </button>
          <div className="flex items-center gap-2.5" data-testid="learn-profile">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-500 text-sm font-semibold text-white">{(participant ?? "G").charAt(0).toUpperCase()}</span>
            <span className="hidden leading-tight md:block">
              <span className="block text-sm font-semibold text-white">{participant ?? "Guest"}</span>
              <span className="block text-[11px] text-slate-400">{participant ? "Study participant" : "Learner"}</span>
            </span>
          </div>
        </div>
      </header>

      <nav aria-label="Main" className="flex items-center gap-1 overflow-x-auto border-b border-white/10 bg-[#0d1016] px-3 py-1.5 lg:px-5">
          {[
            { label: "Home", Icon: HomeIcon },
            { label: "Studio", Icon: MusicIcon, onClick: exit, testId: "learn-exit" },
            { label: "Collaborate", Icon: UsersIcon },
            { label: "Learn", Icon: BookIcon, onClick: () => show({ kind: "lessons" }), active: true, testId: "nav-learn" },
            { label: "Projects", Icon: FolderIcon },
          ].map((item) => (
            <NavButton key={item.label} item={item} />
          ))}
          <div className="ml-auto flex items-center gap-1 border-l border-white/10 pl-2">
            <NavButton item={{ label: "Settings", Icon: GearIcon }} />
            <NavButton item={{ label: "Log out", Icon: LogoutIcon }} />
          </div>
        </nav>

      <div className="flex min-h-0 flex-1">
      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-4 pb-5 lg:px-6">
        {view.kind === "lessons" && <LessonsHome onOpen={openMain} />}

        {view.kind === "collection" && mainLesson(view.id) && <CollectionPage lesson={mainLesson(view.id)!} onBack={() => show({ kind: "lessons" })} onOpenRelated={openRelated} />}

        {view.kind === "path" && (
          <>
            <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-slate-400">
              <button onClick={() => show({ kind: "lessons" })} className="flex items-center gap-2 hover:text-slate-200" data-testid="back-to-lessons">
                <ArrowLeft size={16} /> All lessons
              </button>
              <span className="text-slate-600">/</span>
              <span className="text-slate-200">Piano</span>
            </nav>
            <LearningPath onOpenSub={openSub} onOpenEarlier={(id) => show({ kind: "earlier", id })} />
          </>
        )}

        {(view.kind === "kick" || view.kind === "sequencer") && (
          <>
            <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-slate-400">
              <button onClick={() => show({ kind: "lessons" })} className="flex items-center gap-2 hover:text-slate-200" data-testid="back-to-lessons">
                <ArrowLeft size={16} /> All lessons
              </button>
              <span className="text-slate-600">/</span>
              <span className="text-slate-200">{COURSES[view.kind].title}</span>
            </nav>
            <CoursePath course={view.kind} onOpen={openStudio} />
          </>
        )}

        {studio && (
          <>
            <button onClick={() => show({ kind: studioCourse!.id })} className="flex items-center gap-2 self-start text-sm text-slate-400 hover:text-slate-200" data-testid="learn-back-kick">
              <ArrowLeft size={16} /> Back to {studioCourse!.title}
            </button>
            <div className="flex flex-wrap items-center gap-5">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-500 text-white shadow-lg shadow-violet-500/25">
                {studioCourse?.id === "sequencer" ? <PadsIcon size={30} /> : <DrumIcon size={30} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold tracking-widest text-violet-300 uppercase">
                  {studioModule?.code} · {studioModule?.title} · {studio.id}
                </div>
                <h1 className="mt-0.5 text-3xl font-semibold text-white" data-testid="learn-title">
                  {studio.title}
                </h1>
                <p className="mt-1 text-[15px] text-slate-400">{studio.summary}</p>
              </div>
            </div>
            <StudioLessonPage
              key={studio.id}
              lesson={studio}
              project={project}
              moduleCode={studioModule?.code ?? ""}
              courseTitle={studioCourse!.title}
              onApply={() => void applyStudio()}
              onBackToPath={() => show({ kind: studioCourse!.id })}
              next={(() => {
                const n = nextStudioLesson(studio.id);
                return n ? { title: n.title, open: () => openStudio(n.id) } : null;
              })()}
              voice={voice}
              canSpeak={canSpeak}
            />
          </>
        )}

        {(view.kind === "sub" || view.kind === "earlier") && (
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
              moduleCode={module?.code ?? ""}
              next={(() => {
                const n = nextBuilt(sub.id);
                return n ? { title: n.title, open: () => openSub(n.id) } : null;
              })()}
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
    </div>
  );
}
