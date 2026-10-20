import { useEffect, useMemo, useRef, useState } from "react";
import { TICKS_PER_BAR, createTrack, type Project } from "@daw/shared";
import type { PianoRollGuide } from "../../pianoRoll/PianoRoll";
import { notesToEvents, playEvents, type Preview } from "./audio";
import { ArrowLeft, BookIcon, BulbIcon, CheckIcon, HelpIcon, NotesIcon, SpeakerIcon } from "./Icons";
import { NotesTab } from "./LessonPage";
import { PianoPane } from "./PianoPane";
import { ResultCard } from "./ResultCard";
import { speak, stopSpeaking } from "./speech";
import { studyLog } from "./studyLog";
import { HINT_LABELS, STAGES, WORKSPACE, hintGuide, hintLabel, practiceStep, stageSpeech, toGuideNotes, tryStep, watchEvents, watchStepMs, wrongNoteColors, type StageId } from "./subLesson";
import type { SubLesson } from "./types";
import { useExercise } from "./useExercise";

const ghostBtn = "rounded-xl px-4 py-2 text-sm font-medium text-slate-200 ring-1 ring-white/10 transition-colors hover:bg-white/5 disabled:opacity-40";
const solidBtn = "rounded-xl bg-emerald-300 px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-emerald-200 disabled:opacity-40";
const checkBtn = "rounded-lg bg-emerald-300 px-3 py-1.5 text-sm font-semibold text-slate-900 transition-colors hover:bg-emerald-200 disabled:opacity-40";
const smallBtn = "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 bg-white/5 text-slate-200 hover:bg-white/10";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SubLessonPageProps {
  sub: SubLesson;
  project: Project;
  onOpenClip: (trackId: string, clipId: string | null) => void;
  onExit: () => void;
  onBackToPath: () => void;
  /** The next ready sub-lesson on the path, if any. */
  next: { title: string; open: () => void } | null;
  voice: boolean;
  canSpeak: boolean;
}

function Card({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "goal" | "try" }) {
  const cls = tone === "goal" ? "border border-emerald-300/30 bg-emerald-300/5" : tone === "try" ? "border border-violet-400/50 bg-violet-500/10" : "bg-white/[0.03] ring-1 ring-white/5";
  return <div className={`rounded-xl p-5 ${cls}`}>{children}</div>;
}

/** One sub-lesson as a guided flow: Hook, Watch, Try, Practice (feedback inside), Quick check, Done. */
export function SubLessonPage({ sub, project, onOpenClip, onExit, onBackToPath, next: nextSub, voice, canSpeak }: SubLessonPageProps) {
  const tryXs = useExercise(sub, tryStep(sub), project, onOpenClip, false, WORKSPACE);
  const practiceXs = useExercise(sub, practiceStep(sub), project, onOpenClip, true, WORKSPACE);
  const [stage, setStage] = useState<StageId>("hook");
  const [reached, setReached] = useState(0);
  const [tab, setTab] = useState<"lesson" | "notes">("lesson");
  const stageIndex = STAGES.findIndex((s) => s.id === stage);

  // ---- Watch: the roll draws the notes itself, step by step, with sound and captions ----
  const steps = sub.watch.steps;
  const [watchIndex, setWatchIndex] = useState(-1);
  const [watchRunning, setWatchRunning] = useState(false);
  const [watchSeen, setWatchSeen] = useState(false);
  const token = useRef(0);
  const audio = useRef<Preview | null>(null);
  const stopWatch = () => {
    token.current++;
    audio.current?.stop();
    audio.current = null;
    setWatchRunning(false);
  };
  const runWatch = async () => {
    stopWatch();
    const mine = ++token.current;
    setWatchRunning(true);
    for (const [i, step] of steps.entries()) {
      if (mine !== token.current) return;
      setWatchIndex(i);
      audio.current?.stop();
      audio.current = playEvents(watchEvents(step, project.tempo), "synth", 2.5);
      if (voice && canSpeak) speak(step.caption);
      await sleep(watchStepMs(step));
    }
    if (mine === token.current) {
      setWatchRunning(false);
      setWatchSeen(true);
    }
  };
  useEffect(
    () => () => {
      token.current++;
      audio.current?.stop();
      stopSpeaking();
    },
    [],
  );

  // ---- Quick check ----
  const [picked, setPicked] = useState<number | null>(null);
  const [quickResult, setQuickResult] = useState<"right" | "wrong" | null>(null);
  const [quickTries, setQuickTries] = useState(0);
  const answerQuick = () => {
    if (picked === null) return;
    const right = picked === sub.quickCheck.correct;
    setQuickResult(right ? "right" : "wrong");
    setQuickTries((n) => n + 1);
    studyLog.recordCheck(right ? 1 : 0, right);
  };

  // ---- Stage flow ----
  const entered = useRef({ try: false, practice: false }); // first entry resets the shared clip; later visits keep the learner's work
  const tryPassed = tryXs.result?.pass ?? false;
  const practicePassed = practiceXs.result?.pass ?? false;
  const canAdvance: Record<StageId, boolean> = { hook: true, watch: true, try: tryPassed, practice: practicePassed, quick: quickResult === "right", done: false };

  const go = async (next: StageId) => {
    stopWatch();
    stopSpeaking();
    if (next === "try") {
      if (!(await tryXs.start(!entered.current.try))) return;
      entered.current.try = true;
    } else if (next === "practice") {
      if (!(await practiceXs.start(!entered.current.practice))) return; // a fresh clip: no ghost notes, none of the Try notes
      entered.current.practice = true;
    } else if (next === "quick") {
      studyLog.beginExercise(sub.id, sub.version, "quick-check");
    } else if (next === "watch" && !watchSeen) {
      void runWatch();
    }
    setStage(next);
    setTab("lesson");
    setReached((r) => Math.max(r, STAGES.findIndex((s) => s.id === next)));
  };
  const advance = () => void go(STAGES[stageIndex + 1]!.id);
  const back = () => void go(STAGES[stageIndex - 1]!.id);

  // Voice guidance reads the stage as it opens (Watch reads its own captions).
  useEffect(() => {
    if (voice && canSpeak && stage !== "watch") speak(stageSpeech(sub, stage));
    else if (!voice) stopSpeaking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, canSpeak, stage]);

  // ---- What the piano roll shows ----
  const bars = sub.bars;
  const virtual = useMemo(() => {
    const t = createTrack("lesson-demo", "Demo", "synth", "#8b5cf6", "demo-clip");
    const clip = { ...t.clips["demo-clip"]!, name: "Demo", lengthTicks: bars * TICKS_PER_BAR };
    return { track: { ...t, clips: { "demo-clip": clip } }, clip };
  }, [bars]);
  const real = practiceXs.found ?? tryXs.found;
  const editing = stage === "try" || stage === "practice";
  const shown = editing || stage === "quick" || stage === "done" ? (real ?? virtual) : virtual;
  const guide: PianoRollGuide =
    stage === "hook"
      ? { readOnly: true, notes: toGuideNotes(sub.hook.notes, false) }
      : stage === "watch"
        ? { readOnly: true, notes: watchIndex >= 0 ? toGuideNotes(steps[watchIndex]!.notes, false) : [] }
        : stage === "try"
          ? { tools: sub.tryIt.tools, commands: sub.tryIt.commands ?? false, notes: toGuideNotes(sub.tryIt.ghost, true), noteColor: tryXs.found ? wrongNoteColors(tryXs.found.clip, sub.tryIt.allowedPitchClasses) : {} }
          : stage === "practice"
            ? { tools: sub.practice.tools, commands: sub.practice.commands ?? false, ...hintGuide(sub, practiceXs.hintsShown) }
            : { readOnly: true };
  const wrongCount = stage === "try" && tryXs.found ? Object.keys(wrongNoteColors(tryXs.found.clip, sub.tryIt.allowedPitchClasses)).length : 0;
  const apply = () => {
    const f = practiceXs.found ?? tryXs.found;
    if (f) onOpenClip(f.trackId, f.clipId);
    stopSpeaking();
    onExit();
  };
  const hearHook = () => playEvents(notesToEvents(sub.hook.notes, project.tempo), "synth", 2.5);
  const nextHint = practiceXs.hintsShown < HINT_LABELS.length ? HINT_LABELS[practiceXs.hintsShown] : null;
  const restart = tryXs.removed || practiceXs.removed;

  const body = (() => {
    switch (stage) {
      case "hook":
        return (
          <Card>
            <div className="text-xs text-slate-500">
              {sub.moduleId.toUpperCase()} · {sub.title}
            </div>
            <h2 className="mt-1 text-3xl font-semibold text-white">{sub.hook.headline}</h2>
            {sub.hook.text.map((t) => (
              <p key={t} className="mt-3 text-[15px] leading-relaxed text-slate-300">
                {t}
              </p>
            ))}
            <button onClick={hearHook} className="mt-5 flex items-center gap-2 rounded-xl bg-violet-500/25 px-4 py-2.5 text-sm font-semibold text-violet-100 hover:bg-violet-500/40" data-testid="hook-hear">
              <SpeakerIcon size={17} /> Hear it
            </button>
          </Card>
        );
      case "watch": {
        const current = watchIndex >= 0 ? steps[watchIndex] : null;
        return (
          <div className="flex flex-col gap-3">
            <Card>
              <div className="text-xs text-slate-500">
                Watch · {watchIndex >= 0 ? `step ${watchIndex + 1} of ${steps.length}` : "ready"}
              </div>
              <p className="mt-2 min-h-[96px] text-lg leading-relaxed text-white" data-testid="watch-caption" aria-live="polite">
                {current?.caption ?? "Press Play to watch the piano roll build it."}
              </p>
              <div className="mt-3 flex gap-1.5">
                {steps.map((_, i) => (
                  <span key={i} className={`h-1.5 flex-1 rounded-full ${i <= watchIndex ? "bg-violet-400" : "bg-white/10"}`} />
                ))}
              </div>
            </Card>
            <div className="flex gap-2">
              <button className={smallBtn} onClick={() => (watchRunning ? stopWatch() : void runWatch())} data-testid="watch-play">
                {watchRunning ? "■ Stop" : watchSeen ? "↻ Watch again" : "▶ Play"}
              </button>
            </div>
          </div>
        );
      }
      case "try":
        return (
          <div className="flex flex-col gap-3">
            <Card tone="goal">
              <div className="text-[11px] font-semibold tracking-widest text-emerald-300 uppercase">Try it</div>
              <p className="mt-1 text-sm leading-relaxed text-slate-200">{sub.tryIt.instruction}</p>
              <div className={`mt-3 text-xs ${wrongCount ? "text-rose-300" : "text-slate-400"}`} data-testid="try-wrong">
                {wrongCount ? `${wrongCount} red note${wrongCount === 1 ? "" : "s"}: not part of the chord. Delete or move ${wrongCount === 1 ? "it" : "them"}.` : "Notes you place turn red if they do not belong in the chord."}
              </div>
            </Card>
            <div className="flex flex-wrap gap-2">
              <button className={checkBtn} onClick={tryXs.check} disabled={!tryXs.found} data-testid="lesson-check">
                ✓ Check my work
              </button>
              <button className={smallBtn} onClick={tryXs.listen} disabled={!tryXs.found} data-testid="lesson-listen">
                {tryXs.listening ? "■ Stop" : "▶ Listen"}
              </button>
              <button className={smallBtn} onClick={() => void tryXs.reset()} disabled={!tryXs.found}>
                Start over
              </button>
            </div>
            {tryXs.error && <p className="text-sm text-rose-300">{tryXs.error}</p>}
            {tryXs.result && <ResultCard result={tryXs.result} />}
            <ul className="list-disc space-y-1 pl-6 text-sm text-slate-400">
              {sub.tryIt.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        );
      case "practice":
        return (
          <div className="flex flex-col gap-3">
            <Card tone="goal">
              <div className="text-[11px] font-semibold tracking-widest text-emerald-300 uppercase">Practice · no ghost notes</div>
              <p className="mt-1 text-sm leading-relaxed text-slate-200">{sub.practice.task}</p>
              <ol className="mt-3 grid grid-cols-2 gap-1.5">
                {sub.practice.items.map((it) => (
                  <li key={it} className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-slate-200">
                    {it}
                  </li>
                ))}
              </ol>
            </Card>
            <div className="flex flex-wrap gap-2">
              <button className={checkBtn} onClick={practiceXs.check} disabled={!practiceXs.found} data-testid="practice-check">
                ✓ Check my work
              </button>
              <button className={smallBtn} onClick={practiceXs.hint} disabled={!nextHint || !practiceXs.found} data-testid="lesson-hint">
                {nextHint ? `Hint ${practiceXs.hintsShown + 1}/3: ${hintLabel(sub, practiceXs.hintsShown)}` : "No more hints"}
              </button>
              <button className={smallBtn} onClick={practiceXs.listen} disabled={!practiceXs.found}>
                {practiceXs.listening ? "■ Stop" : "▶ Listen"}
              </button>
              <button className={smallBtn} onClick={() => void practiceXs.reset()} disabled={!practiceXs.found}>
                Reset
              </button>
            </div>
            {practiceXs.error && <p className="text-sm text-rose-300">{practiceXs.error}</p>}
            {practiceXs.result && <ResultCard result={practiceXs.result} />}
            {practiceXs.hintsShown > 0 && (
              <Card>
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <BulbIcon className="text-amber-300" size={16} /> Hints
                </div>
                <ol className="mt-2 list-decimal space-y-1.5 pl-6 text-sm text-slate-300" data-testid="hint-list">
                  {practiceStep(sub)
                    .exercise.hints.slice(0, practiceXs.hintsShown)
                    .map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                </ol>
              </Card>
            )}
          </div>
        );
      case "quick":
        return (
          <Card>
            <div className="text-[11px] font-semibold tracking-widest text-violet-300 uppercase">Quick check</div>
            <h2 className="mt-1 text-xl font-semibold text-white">{sub.quickCheck.question}</h2>
            <div className="mt-4 flex flex-col gap-2" role="radiogroup" aria-label="Answers">
              {sub.quickCheck.options.map((o, i) => (
                <label key={o} className={`flex cursor-pointer items-center gap-3 rounded-xl px-4 py-2.5 text-sm ring-1 transition-colors ${picked === i ? "bg-violet-500/15 text-white ring-violet-400/60" : "text-slate-300 ring-white/10 hover:bg-white/5"}`}>
                  <input type="radio" name="quick" checked={picked === i} onChange={() => (setPicked(i), setQuickResult(null))} className="accent-violet-400" data-testid={`quick-option-${i}`} />
                  {o}
                </label>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button className={solidBtn} disabled={picked === null || quickResult === "right"} onClick={answerQuick} data-testid="quick-answer">
                Check answer
              </button>
              {quickResult === "wrong" && (
                <span className="text-sm text-rose-300" data-testid="quick-feedback">
                  Not quite. Think about how a chord gets its name, then try again.
                </span>
              )}
            </div>
            {quickResult === "right" && (
              <p className="mt-3 rounded-xl bg-emerald-400/10 p-3 text-sm text-emerald-100 ring-1 ring-emerald-400/30" data-testid="quick-feedback">
                Correct! {sub.quickCheck.explanation}
              </p>
            )}
          </Card>
        );
      case "done":
        return (
          <div className="flex flex-col gap-3">
            <div className="rounded-xl bg-emerald-400/10 p-4 ring-1 ring-emerald-400/30">
              <div className="font-semibold text-emerald-200">Sub-lesson complete</div>
              <div className="mt-1 text-sm text-slate-300">
                {practiceXs.checks} practice check{practiceXs.checks === 1 ? "" : "s"}, {practiceXs.hintsShown} hint{practiceXs.hintsShown === 1 ? "" : "s"}, {quickTries} quick-check answer{quickTries === 1 ? "" : "s"} this visit.
              </div>
            </div>
            <Card>
              <div className="text-lg font-semibold text-white">What you learned</div>
              <ul className="mt-3 flex flex-col gap-2.5">
                {sub.recap.map((r) => (
                  <li key={r} className="flex gap-3 text-sm text-slate-300">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
                      <CheckIcon size={12} />
                    </span>
                    {r}
                  </li>
                ))}
              </ul>
            </Card>
            <div className="flex flex-wrap gap-2">
              <button className={ghostBtn} onClick={apply} data-testid="lesson-apply">
                Apply it in the studio →
              </button>
              {nextSub && (
                <button className={solidBtn} onClick={nextSub.open} data-testid="next-sub-lesson">
                  Next: {nextSub.title} →
                </button>
              )}
              <button className={nextSub ? ghostBtn : solidBtn} onClick={onBackToPath} data-testid="back-to-path-done">
                Back to the learning path
              </button>
            </div>
          </div>
        );
    }
  })();

  const footer =
    stage === "done" ? null : (
      <div className="flex items-center justify-between border-t border-white/10 p-3">
        <button className={ghostBtn} disabled={stageIndex === 0} onClick={back}>
          ← Back
        </button>
        <span className="text-xs text-slate-500">
          {stage === "try" && !tryPassed ? "Pass the check to continue" : stage === "practice" && !practicePassed ? "Pass the check to continue" : stage === "quick" && quickResult !== "right" ? "Answer correctly to continue" : ""}
        </span>
        <button className={solidBtn} disabled={!canAdvance[stage]} onClick={advance} data-testid="stage-next">
          {STAGES[stageIndex + 1] ? `Next: ${STAGES[stageIndex + 1]!.label} →` : "Next →"}
        </button>
      </div>
    );

  return (
    <>
      <div className="flex min-h-[470px] flex-1 gap-4">
        <section className="flex w-[440px] shrink-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#11141c]">
          <div className="flex border-b border-white/10 px-2" role="tablist">
            {([["lesson", "Lesson", BookIcon], ["notes", "Notes", NotesIcon]] as const).map(([id, label, Icon]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`flex flex-1 items-center justify-center gap-2 border-b-2 px-2 py-3 text-sm transition-colors ${tab === id ? "border-emerald-300 font-semibold text-emerald-300" : "border-transparent text-slate-400 hover:text-slate-200"}`}
                data-testid={`learn-tab-${id}`}
              >
                <Icon size={16} /> {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{tab === "lesson" ? body : <NotesTab lessonId={sub.id} />}</div>
          {tab === "lesson" && footer}
        </section>
        <PianoPane
          project={project}
          shown={shown}
          guide={guide}
          emptyText={restart ? "The exercise was removed (maybe by Undo). Start it again to continue." : undefined}
          startLabel={restart ? "Restart" : undefined}
          onStart={restart ? () => void go(stage === "try" ? "try" : "practice") : undefined}
        />
      </div>

      <div className="flex gap-4">
        <section className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-[#11141c] px-5 py-4" data-testid="learn-tracker">
          <div className="text-sm font-semibold text-slate-200">Your progress</div>
          <ol className="mt-3 flex items-center">
            {STAGES.map((s, i) => {
              const active = s.id === stage;
              const done = i < reached || (i <= reached && !active && i < stageIndex);
              const locked = i > reached;
              return (
                <li key={s.id} className="flex min-w-0 flex-1 items-center">
                  <button disabled={locked} onClick={() => void go(s.id)} className="flex min-w-0 items-center gap-2.5 text-left disabled:cursor-not-allowed" title={locked ? "Finish the earlier stages first" : s.label} data-testid={`stage-${s.id}`}>
                    <span
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ring-2 transition-colors ${
                        active ? "text-emerald-300 shadow-[0_0_14px_rgba(110,231,183,.35)] ring-emerald-300" : done ? "bg-emerald-300 text-slate-900 ring-emerald-300" : "text-slate-400 ring-white/15"
                      }`}
                    >
                      {done && !active ? <CheckIcon size={16} /> : i + 1}
                    </span>
                    <span className={`truncate text-xs ${active ? "text-emerald-300" : "text-slate-400"}`}>{s.label}</span>
                  </button>
                  {i < STAGES.length - 1 && <span className={`mx-3 h-px min-w-3 flex-1 ${i < reached ? "bg-emerald-300/50" : "bg-white/10"}`} />}
                </li>
              );
            })}
          </ol>
        </section>
        <section className="flex w-[360px] shrink-0 items-center gap-4 rounded-2xl border border-white/10 bg-[#11141c] px-5 py-4">
          <HelpIcon size={26} className="shrink-0 text-slate-200" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-100">Need help?</div>
            <div className="text-xs text-slate-400">{canSpeak ? "Replay the voice guidance. In Practice there are three hint levels." : "In Practice there are three hint levels."}</div>
          </div>
          <button
            className="flex items-center gap-1.5 rounded-xl bg-white/5 px-3 py-2 text-sm text-slate-200 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
            disabled={!canSpeak}
            onClick={() => speak(stageSpeech(sub, stage, Math.max(0, watchIndex)))}
            data-testid="learn-replay"
          >
            <SpeakerIcon size={16} /> Replay
          </button>
        </section>
      </div>
      <button className="flex items-center gap-2 self-start text-sm text-slate-500 hover:text-slate-300" onClick={onBackToPath}>
        <ArrowLeft size={15} /> Back to the learning path
      </button>
    </>
  );
}
