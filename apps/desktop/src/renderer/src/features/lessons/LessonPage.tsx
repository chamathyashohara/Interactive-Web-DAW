import { useEffect, useState } from "react";
import type { Project } from "@daw/shared";
import { BookIcon, BulbIcon, CheckIcon, HelpIcon, NotesIcon, PracticeIcon, SpeakerIcon, SummaryIcon } from "./Icons";
import { exerciseIndex, stepSpeechText } from "./learnModel";
import { PianoPane } from "./PianoPane";
import { speak, stopSpeaking } from "./speech";
import { browserStore, readJson, writeJson } from "./storage";
import type { Lesson, Step } from "./types";
import { useExercise, type ExerciseState, type ExerciseStep } from "./useExercise";

type Tab = "lesson" | "notes" | "practice" | "summary";
const TABS: { id: Tab; label: string; Icon: typeof BookIcon }[] = [
  { id: "lesson", label: "Lesson", Icon: BookIcon },
  { id: "notes", label: "Notes", Icon: NotesIcon },
  { id: "practice", label: "Practice", Icon: PracticeIcon },
  { id: "summary", label: "Summary", Icon: SummaryIcon },
];

const store = browserStore();
const NOTES_KEY = "lessons.notes.v1";
const ghost = "rounded-xl px-4 py-2 text-sm font-medium text-slate-200 ring-1 ring-white/10 transition-colors hover:bg-white/5 disabled:opacity-40";
const solid = "rounded-xl bg-emerald-300 px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-emerald-200 disabled:opacity-40";
const small = "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40";

export interface LessonPageProps {
  lesson: Lesson;
  project: Project;
  onOpenClip: (trackId: string, clipId: string | null) => void;
  onExit: () => void;
  onNextLesson: (() => void) | null;
  voice: boolean;
  canSpeak: boolean;
}

function ExplainCard({ step, number, total }: { step: Extract<Step, { kind: "explain" }>; number: number; total: number }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-white/[0.03] p-5 ring-1 ring-white/5" data-testid="learn-step">
        <div className="text-xs text-slate-500">
          Step {number} of {total}
        </div>
        <h2 className="mt-1 text-2xl font-semibold text-white">{step.title}</h2>
        {step.body.map((p) => (
          <p key={p} className="mt-3 text-[15px] leading-relaxed text-slate-300">
            {p}
          </p>
        ))}
        {step.tryIt && (
          <div className="mt-5 flex items-start gap-3 rounded-xl border border-violet-400/50 bg-violet-500/10 p-4">
            <button onClick={() => speak(step.tryIt!)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/25 text-violet-100 hover:bg-violet-500/40" title="Read aloud" aria-label="Read aloud">
              <SpeakerIcon size={17} />
            </button>
            <div>
              <div className="text-sm font-semibold text-violet-300">Try it</div>
              <div className="mt-0.5 text-sm text-slate-300">{step.tryIt}</div>
            </div>
          </div>
        )}
        {step.tips && (
          <div className="mt-5">
            <div className="flex items-center gap-2 font-semibold text-slate-100">
              <BulbIcon className="text-emerald-300" /> Tips
            </div>
            <ul className="mt-2 list-disc space-y-1.5 pl-7 text-sm text-slate-400">
              {step.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function PracticeTab({ step, xs, onStart }: { step: ExerciseStep; xs: ExerciseState; onStart: () => void }) {
  const ex = xs.exercise;
  const passed = xs.result?.pass ?? false;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-emerald-300/30 bg-emerald-300/5 p-4">
        <div className="text-[11px] font-semibold tracking-widest text-emerald-300 uppercase">Your goal</div>
        <div className="mt-1 text-lg font-semibold text-white">{step.title}</div>
        <p className="mt-1 text-sm leading-relaxed text-slate-300">{step.goal}</p>
      </div>

      {!xs.found || !xs.started ? (
        <button className={`${solid} self-start`} onClick={onStart} data-testid="lesson-start">
          {xs.found ? "Continue practice" : xs.removed ? "Restart practice" : "Start practice"}
        </button>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button className={`${small} bg-emerald-300 font-semibold text-slate-900 hover:bg-emerald-200`} onClick={xs.check} data-testid="lesson-check">
            ✓ Check my work
          </button>
          <button className={`${small} bg-white/5 text-slate-200 hover:bg-white/10`} onClick={xs.hint} disabled={xs.hintsShown >= ex.hints.length} data-testid="lesson-hint">
            Hint ({xs.hintsShown}/{ex.hints.length})
          </button>
          <button className={`${small} bg-white/5 text-slate-200 hover:bg-white/10`} onClick={xs.listen} title="Play the exercise once with the lesson's own sound" data-testid="lesson-listen">
            {xs.listening ? "■ Stop" : "▶ Listen"}
          </button>
          <button className={`${small} bg-white/5 text-slate-200 hover:bg-white/10`} onClick={() => void xs.reset()} title="Put the exercise back to how it started (undoable)">
            Reset
          </button>
        </div>
      )}

      {xs.error && <p className="text-sm text-rose-300">{xs.error}</p>}

      {xs.result && (
        <div className={`rounded-xl p-4 ring-1 ${passed ? "bg-emerald-400/10 ring-emerald-400/30" : "bg-rose-400/10 ring-rose-400/30"}`} data-testid="lesson-result" data-pass={passed}>
          <div className={`font-semibold ${passed ? "text-emerald-200" : "text-rose-200"}`}>{passed ? "Well done!" : "Not yet, keep going"}</div>
          <div className="mt-1 text-sm text-slate-200">{xs.result.feedback}</div>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {xs.result.items.map((i) => (
              <li key={i.label} className={`flex items-center gap-2 ${i.ok ? "text-emerald-300" : "text-slate-400"}`}>
                <span className={`flex h-4 w-4 items-center justify-center rounded-full ${i.ok ? "bg-emerald-400/20" : "ring-1 ring-slate-500"}`}>{i.ok && <CheckIcon size={11} />}</span>
                {i.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {xs.hintsShown > 0 && (
        <div className="rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <BulbIcon className="text-amber-300" size={16} /> Hints
          </div>
          <ol className="mt-2 list-decimal space-y-1.5 pl-6 text-sm text-slate-300">
            {ex.hints.slice(0, xs.hintsShown).map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ol>
        </div>
      )}

    </div>
  );
}

export function NotesTab({ lessonId }: { lessonId: string }) {
  const [text, setText] = useState(() => readJson<Record<string, string>>(store, NOTES_KEY, {})[lessonId] ?? "");
  useEffect(() => {
    const t = setTimeout(() => writeJson(store, NOTES_KEY, { ...readJson<Record<string, string>>(store, NOTES_KEY, {}), [lessonId]: text }), 300);
    return () => clearTimeout(t);
  }, [lessonId, text]);
  return (
    <div className="flex h-full flex-col gap-2">
      <p className="text-sm text-slate-400">Your own notes for this lesson. They are saved on this computer only and are not part of any study data.</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. G major = G, B, D…"
        className="min-h-[220px] flex-1 resize-none rounded-xl bg-white/[0.03] p-4 text-sm leading-relaxed text-slate-200 outline-none ring-1 ring-white/10 select-text focus:ring-violet-400/50"
        aria-label="Lesson notes"
        data-testid="lesson-notes"
      />
    </div>
  );
}

function SummaryTab({ lesson, xs, onApply, onNextLesson }: { lesson: Lesson; xs: ExerciseState; onApply: () => void; onNextLesson: (() => void) | null }) {
  return (
    <div className="flex flex-col gap-4">
      {xs.completed ? (
        <div className="rounded-xl bg-emerald-400/10 p-4 ring-1 ring-emerald-400/30">
          <div className="font-semibold text-emerald-200">Lesson complete</div>
          <div className="mt-1 text-sm text-slate-300">
            {xs.checks > 0 ? `This visit: ${xs.checks} check${xs.checks === 1 ? "" : "s"}, ${xs.hintsShown} hint${xs.hintsShown === 1 ? "" : "s"} used.` : "You finished this lesson earlier."}
          </div>
        </div>
      ) : (
        <div className="rounded-xl bg-white/[0.03] p-4 text-sm text-slate-400 ring-1 ring-white/5">Finish the practice to complete this lesson.</div>
      )}
      <div className="rounded-xl bg-white/[0.03] p-5 ring-1 ring-white/5">
        <div className="text-lg font-semibold text-white">What you learned</div>
        <ul className="mt-3 flex flex-col gap-2.5">
          {lesson.recap.map((r) => (
            <li key={r} className="flex gap-3 text-sm text-slate-300">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
                <CheckIcon size={12} />
              </span>
              {r}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap gap-2">
        {xs.found && (
          <button className={ghost} onClick={onApply}>
            Apply it in the studio →
          </button>
        )}
        {onNextLesson && (
          <button className={solid} onClick={onNextLesson} data-testid="lesson-next-lesson">
            Next lesson →
          </button>
        )}
      </div>
    </div>
  );
}

/** One lesson: tabs and content on the left, the piano roll on the right, step tracker and help underneath. */
export function LessonPage({ lesson, project, onOpenClip, onExit, onNextLesson, voice, canSpeak }: LessonPageProps) {
  const exIdx = exerciseIndex(lesson);
  const exStep = lesson.steps[exIdx] as ExerciseStep;
  const xs = useExercise(lesson, exStep, project, onOpenClip);
  const [tab, setTab] = useState<Tab>("lesson");
  const [stepIndex, setStepIndex] = useState(0); // explain step shown on the Lesson tab
  const [reached, setReached] = useState(0); // furthest step opened, for the tracker

  const activeStep = tab === "practice" ? exIdx : tab === "lesson" ? stepIndex : -1;
  useEffect(() => {
    if (activeStep >= 0) setReached((r) => Math.max(r, activeStep));
  }, [activeStep]);

  const speechFor = (): string => (tab === "summary" ? `What you learned. ${lesson.recap.join(" ")}` : stepSpeechText(lesson.steps[activeStep >= 0 ? activeStep : 0]!));
  // Voice guidance reads each step as it opens.
  useEffect(() => {
    if (voice && canSpeak && (tab === "lesson" || tab === "practice")) speak(speechFor());
    else stopSpeaking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, canSpeak, tab, stepIndex]);

  const goStep = (i: number) => {
    if (i === exIdx) setTab("practice");
    else {
      setStepIndex(i);
      setTab("lesson");
    }
  };
  const startPractice = async () => {
    setTab("practice");
    await xs.start();
  };
  const apply = () => {
    if (xs.found) onOpenClip(xs.found.trackId, xs.found.clipId);
    stopSpeaking();
    onExit();
  };
  const explain = lesson.steps[stepIndex];
  const done = (i: number) => xs.completed || i < reached;

  return (
    <>
      <div className="flex min-h-[470px] flex-1 gap-4">
        <section className="flex w-[440px] shrink-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#11141c]">
          <div className="flex border-b border-white/10 px-2" role="tablist">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => (id === "practice" ? void startPractice() : setTab(id))}
                className={`flex flex-1 items-center justify-center gap-2 border-b-2 px-2 py-3 text-sm transition-colors ${tab === id ? "border-emerald-300 font-semibold text-emerald-300" : "border-transparent text-slate-400 hover:text-slate-200"}`}
                data-testid={`learn-tab-${id}`}
              >
                <Icon size={16} /> {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === "lesson" && explain?.kind === "explain" && <ExplainCard step={explain} number={stepIndex + 1} total={lesson.steps.length} />}
            {tab === "practice" && <PracticeTab step={exStep} xs={xs} onStart={() => void xs.start()} />}
            {tab === "notes" && <NotesTab lessonId={lesson.id} />}
            {tab === "summary" && <SummaryTab lesson={lesson} xs={xs} onApply={apply} onNextLesson={onNextLesson} />}
          </div>
          {tab === "practice" && xs.found && (xs.result?.pass || xs.completed) && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-white/10 p-3">
              <button className={ghost} onClick={apply} data-testid="lesson-apply">
                Apply it in the studio →
              </button>
              <button className={solid} onClick={() => setTab("summary")} data-testid="lesson-summary">
                See what you learned →
              </button>
            </div>
          )}
          {tab === "lesson" && explain?.kind === "explain" && (
            <div className="flex justify-between border-t border-white/10 p-3">
              <button className={ghost} disabled={stepIndex === 0} onClick={() => setStepIndex(stepIndex - 1)}>
                ← Back
              </button>
              {stepIndex + 1 < exIdx ? (
                <button className={solid} onClick={() => setStepIndex(stepIndex + 1)} data-testid="lesson-next">
                  Next →
                </button>
              ) : (
                <button className={solid} onClick={() => void startPractice()} data-testid="lesson-next">
                  Start practice →
                </button>
              )}
            </div>
          )}
        </section>
        <PianoPane
          project={project}
          shown={xs.found}
          emptyText={xs.removed ? "The exercise was removed (maybe by Undo). Start it again to continue." : undefined}
          startLabel={xs.removed ? "Restart practice" : "Start practice"}
          onStart={() => void startPractice()}
        />
      </div>

      <div className="flex gap-4">
        <section className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-[#11141c] px-5 py-4" data-testid="learn-tracker">
          <div className="text-sm font-semibold text-slate-200">Your progress</div>
          <ol className="mt-3 flex items-center">
            {lesson.steps.map((s, i) => {
              const active = i === activeStep;
              return (
                <li key={s.id} className="flex min-w-0 flex-1 items-center">
                  <button onClick={() => (i === exIdx ? void startPractice() : goStep(i))} className="flex min-w-0 items-center gap-2.5 text-left" title={s.title}>
                    <span
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ring-2 transition-colors ${
                        active ? "text-emerald-300 ring-emerald-300 shadow-[0_0_14px_rgba(110,231,183,.35)]" : done(i) ? "bg-emerald-300 text-slate-900 ring-emerald-300" : "text-slate-400 ring-white/15"
                      }`}
                    >
                      {done(i) && !active ? <CheckIcon size={16} /> : i + 1}
                    </span>
                    <span className={`truncate text-xs ${active ? "text-emerald-300" : "text-slate-400"}`}>{s.kind === "exercise" ? "Practice" : s.title}</span>
                  </button>
                  {i < lesson.steps.length - 1 && <span className={`mx-3 h-px min-w-4 flex-1 ${done(i) ? "bg-emerald-300/50" : "bg-white/10"}`} />}
                </li>
              );
            })}
          </ol>
        </section>
        <section className="flex w-[360px] shrink-0 items-center gap-4 rounded-2xl border border-white/10 bg-[#11141c] px-5 py-4">
          <HelpIcon size={26} className="shrink-0 text-slate-200" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-100">Need help?</div>
            <div className="text-xs text-slate-400">{canSpeak ? "Replay the voice guidance, or open a hint in Practice." : "Open a hint in Practice. (Voice guidance needs a Windows speech voice.)"}</div>
          </div>
          <button
            className="flex items-center gap-1.5 rounded-xl bg-white/5 px-3 py-2 text-sm text-slate-200 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
            disabled={!canSpeak}
            onClick={() => speak(speechFor())}
            data-testid="learn-replay"
          >
            <SpeakerIcon size={16} /> Replay
          </button>
        </section>
      </div>
    </>
  );
}
