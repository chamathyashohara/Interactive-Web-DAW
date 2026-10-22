import { useEffect, useRef, useState } from "react";
import type { Project } from "@daw/shared";
import { libraryStore } from "../../../store";
import { playEvents, type Preview } from "../audio";
import { lessonEvents } from "../events";
import { ArrowLeft, BookIcon, BulbIcon, CheckIcon, HelpIcon, NotesIcon, SpeakerIcon } from "../Icons";
import { NotesTab } from "../LessonPage";
import { ResultCard } from "../ResultCard";
import { speak, stopSpeaking } from "../speech";
import { STAGES, type StageId } from "../subLesson";
import type { CheckResult } from "../types";
import { lessonView, runStudioCheck } from "./checks";
import { barTick, hasSong, stageSetupOps } from "./exampleSong";
import { SequencerPane } from "./SequencerPane";
import { StudioPane, type StudioGuide } from "./StudioPane";
import { lessonTracksOf, spaceSwitchOps } from "./space";
import { completeStudioLesson, studioCtx, studioState, useStudioState, type StudioProgress } from "./studioState";
import type { Exercise, Labels, PadDemo, Setup, SoundWant, StudioLesson } from "./types";

const ghostBtn = "rounded-xl px-4 py-2 text-sm font-medium text-slate-200 ring-1 ring-white/10 transition-colors hover:bg-white/5 disabled:opacity-40";
const solidBtn = "rounded-xl bg-emerald-300 px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-emerald-200 disabled:opacity-40";
const checkBtn = "rounded-lg bg-emerald-300 px-3 py-1.5 text-sm font-semibold text-slate-900 transition-colors hover:bg-emerald-200 disabled:opacity-40";
const smallBtn = "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 bg-white/5 text-slate-200 hover:bg-white/10";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();

function Card({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "goal" }) {
  const cls = tone === "goal" ? "border border-emerald-300/30 bg-emerald-300/5" : "bg-white/[0.03] ring-1 ring-white/5";
  return <div className={`rounded-xl p-5 ${cls}`}>{children}</div>;
}

/** The first library sound of a kind (for demonstrations). */
const soundFor = (want: SoundWant) => libraryStore.get().entries.find((e) => e.category === want.category && (!want.sub || e.sub === want.sub));
/** A demonstration sound: played and lit, but not counted as the learner's own listening. */
function demoSound(want: SoundWant) {
  const e = soundFor(want);
  if (e) window.daw.previewSample(e.id);
  return e;
}

/** "Label the sections" (M13.1): done on the lesson page. */
function LabelTask({ labels, passed, onPass }: { labels: Labels; passed: boolean; onPass: () => void }) {
  const [picked, setPicked] = useState<string[]>(() => labels.sections.map((s) => (passed ? s.answer : "")));
  const [result, setResult] = useState<CheckResult | null>(null);
  const check = () => {
    const items = labels.sections.map((s, i) => ({ label: `${s.bars}: ${picked[i] || "?"}`, ok: picked[i] === s.answer }));
    const wrong = labels.sections.findIndex((s, i) => picked[i] !== s.answer);
    const r: CheckResult = {
      pass: wrong < 0,
      score: items.filter((i) => i.ok).length / items.length,
      feedback: wrong < 0 ? "Right: energy rises through the build-up, peaks in the drop and falls in the breakdown." : picked[wrong] ? `${labels.sections[wrong]!.bars} is not the ${picked[wrong]}. Look at how high its energy is.` : `Choose a label for ${labels.sections[wrong]!.bars}.`,
      items,
    };
    setResult(r);
    if (r.pass) onPass();
  };
  return (
    <div className="flex flex-col gap-3" data-testid="studio-labels">
      <div className={`grid gap-3 ${labels.sections.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
        {labels.sections.map((s, i) => (
          <div key={s.bars} className="flex flex-col gap-2 rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/10">
            <div className="flex h-16 items-end gap-1" aria-hidden="true">
              {Array.from({ length: 5 }, (_, k) => (
                <span key={k} className={`flex-1 rounded-t ${k < s.energy ? "bg-violet-400/70" : "bg-white/5"}`} style={{ height: `${(k + 1) * 20}%` }} />
              ))}
            </div>
            <div className="text-xs text-slate-400">{s.bars} · energy {s.energy}/5</div>
            <select value={picked[i]} onChange={(e) => setPicked(picked.map((p, j) => (j === i ? e.target.value : p)))} className="rounded-lg bg-[#0b0d13] px-2 py-1.5 text-sm text-slate-100 ring-1 ring-white/15" aria-label={`Section for ${s.bars}`} data-testid={`label-${i}`}>
              <option value="">Choose…</option>
              {labels.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div>
        <button className={checkBtn} onClick={check} data-testid="lesson-check">
          ✓ Check my labels
        </button>
      </div>
      {result && <ResultCard result={result} />}
    </div>
  );
}

interface Props {
  lesson: StudioLesson;
  project: Project;
  moduleCode: string;
  /** The course the lesson belongs to ("Kick Drums"), for the way back. */
  courseTitle: string;
  onBackToPath: () => void;
  next: { title: string; open: () => void } | null;
  voice: boolean;
  canSpeak: boolean;
}

/** One studio lesson (Kick Drums, Drum sequencer) in the Piano sub-lesson format: Hook, Watch, Try, Practice, Quick check, Done, with its workspace. */
export function StudioLessonPage({ lesson, project, moduleCode, courseTitle, onBackToPath, next, voice, canSpeak }: Props) {
  useStudioState();
  const p = studioState.progress(lesson.id);
  const save = (patch: Partial<StudioProgress>) => studioState.saveProgress(lesson.id, { ...studioState.progress(lesson.id), ...patch });
  const finished = lessonEvents.isCompleted(lesson.id);
  const [stage, setStage] = useState<StageId>(p.stage);
  const stageIndex = STAGES.findIndex((s) => s.id === stage);
  const [tab, setTab] = useState<"lesson" | "notes">("lesson");
  const [tryResult, setTryResult] = useState<CheckResult | null>(null);
  const [practiceResult, setPracticeResult] = useState<CheckResult | null>(null);
  const [setupError, setSetupError] = useState("");
  const [picked, setPicked] = useState<number | null>(p.quickPicked);
  const [quickResult, setQuickResult] = useState<"right" | "wrong" | null>(p.quickRight ? "right" : null);
  const [quickTries, setQuickTries] = useState(0);

  /** The project as the DAW has it right now (the prop can lag a moment behind a change just made). */
  const live = async () => (await window.daw.getInitial()).project;
  /**
   * This lesson's own workspace: the previous lesson's tracks are saved and taken out of the project, and the tracks
   * this lesson had last time come back. Every Kick lesson works in its own space.
   */
  const enterSpace = async (): Promise<boolean> => {
    if (studioState.active() === lesson.id) return true;
    const now = await live();
    const ops = spaceSwitchOps(now, studioState.savedSpace(lesson.id)?.tracks);
    if (ops.length) {
      const res = await window.daw.dispatchBatch(ops);
      if (!res.ok) return setSetupError(`Could not open this lesson's workspace: ${res.reason ?? "unknown error"}`), false;
    }
    studioState.switchSpace(lesson.id, lessonTracksOf(now));
    return true;
  };

  // ---- the workspace for a stage: set up the first time the stage opens (not again when the learner comes back) ----
  const prepare = async (key: string, setup: Setup | undefined, force = false): Promise<boolean> => {
    const owner = `${lesson.id}:${key}`;
    if (!force && studioState.owner() === owner) return true;
    if (setup) {
      const project = await live();
      const lib = libraryStore.get().entries;
      const loop = lib.find((e) => e.sub === "Drum Loop" && e.meta.bpm === 90) ?? lib.find((e) => e.sub === "Drum Loop" && e.meta.bpm && e.meta.bpm !== 120);
      const r = stageSetupOps(project, setup, uuid, loop ? { id: loop.id, name: loop.name, category: loop.category, durationSec: loop.durationSec, meta: loop.meta } : undefined);
      if (!r.ok) return setSetupError(r.reason), false;
      if (r.ops.length) {
        const res = await window.daw.dispatchBatch(r.ops);
        if (!res.ok) return setSetupError(`Could not prepare the workspace: ${res.reason ?? "unknown error"}`), false;
      }
    }
    setSetupError("");
    studioState.setOwner(owner);
    return true;
  };
  const [spaceReady, setSpaceReady] = useState(studioState.active() === lesson.id);
  useEffect(() => {
    void (async () => {
      if (!(await enterSpace())) return;
      setSpaceReady(true);
      if (stage === "try") await prepare("try", lesson.tryIt.setup);
      else if (stage === "practice") await prepare("practice", lesson.practice.setup);
      else if (stage === "watch" && lesson.watch.setup) await prepare("watch", lesson.watch.setup);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Step sequencer demonstrations: a pattern shown on demo pads, played twice, the playing pad lit ----
  const seqLesson = lesson.space === "sequencer";
  const [demoPads, setDemoPads] = useState<PadDemo[] | null>(null);
  const [demoStep, setDemoStep] = useState(-1);
  const demoAudio = useRef<{ preview: Preview; timers: number[] } | null>(null);
  const stopPattern = () => {
    demoAudio.current?.preview.stop();
    demoAudio.current?.timers.forEach((t) => window.clearTimeout(t));
    demoAudio.current = null;
    setDemoStep(-1);
  };
  const playPattern = (pattern: PadDemo[], times = 2) => {
    stopPattern();
    setDemoPads(pattern);
    const step = 60 / project.tempo / 4;
    const events = Array.from({ length: times }, (_, r) => pattern.flatMap((d) => d.pads.map((pad) => ({ time: (r * 16 + pad - 1) * step, duration: 0.12, pitch: d.pitch, gain: (d.velocity ?? 100) / 127 })))).flat();
    const preview = playEvents(events, "drums", times * 16 * step + 0.5);
    const timers = Array.from({ length: times * 16 + 1 }, (_, i) => window.setTimeout(() => setDemoStep(i < times * 16 ? i % 16 : -1), 60 + i * step * 1000));
    demoAudio.current = { preview, timers };
  };
  useEffect(() => () => stopPattern(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Watch: captions step by step, lighting the sound list and the arrangement, with sound ----
  const steps = lesson.watch.steps;
  const [watchIndex, setWatchIndex] = useState(-1);
  const [watchRunning, setWatchRunning] = useState(false);
  const [lit, setLit] = useState<Pick<StudioGuide, "litCategory" | "litSoundId">>({});
  const token = useRef(0);
  /** Watch started the song playing (so stopping Watch stops it too). */
  const songPlaying = useRef(false);
  const stopWatch = () => {
    token.current++;
    stopPattern();
    if (songPlaying.current) window.daw.stop();
    songPlaying.current = false;
    setWatchRunning(false);
    setLit({});
    window.daw.stopPreviewSample();
  };
  const runWatch = async () => {
    stopWatch();
    const mine = ++token.current;
    setWatchRunning(true);
    for (const [i, step] of steps.entries()) {
      if (mine !== token.current) return;
      setWatchIndex(i);
      if (step.pads) playPattern(step.pads, 1);
      const e = step.sound ? demoSound(step.sound) : undefined;
      setLit(step.sound ? { litCategory: step.sound.category, litSoundId: e?.id } : {});
      if (step.bars && hasSong(project)) {
        window.daw.seek(barTick(step.bars[0]));
        window.daw.play();
        songPlaying.current = true;
      }
      if (voice && canSpeak) speak(step.caption);
      await sleep(step.bars ? Math.min(6000, ((step.bars[1] - step.bars[0] + 1) * 4 * 60000) / project.tempo) + 600 : 3400);
      if (mine !== token.current) return;
      if (songPlaying.current) window.daw.stop();
      songPlaying.current = false;
    }
    if (mine === token.current) {
      setWatchRunning(false);
      setLit({});
    }
  };
  useEffect(
    () => () => {
      token.current++;
      if (songPlaying.current) window.daw.stop();
      stopSpeaking();
    },
    [],
  );

  // ---- Try / Practice checks ----
  /** Steps the project cannot show (Click, TAP): ticked by the learner, per stage. */
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const check = (ex: Exercise, which: "try" | "practice") => {
    if (!ex.check) return;
    const project_ = runStudioCheck(lessonView(project), ex.check, studioCtx());
    const unticked = (ex.confirm ?? []).filter((c) => !confirmed[`${which}:${c}`]);
    const r: CheckResult = ex.confirm
      ? {
          ...project_,
          pass: project_.pass && unticked.length === 0,
          feedback: !project_.pass ? project_.feedback : unticked.length ? `Tick "${unticked[0]}" when you have done it.` : project_.feedback,
          items: [...project_.items, ...ex.confirm.map((c) => ({ label: c, ok: !unticked.includes(c) }))],
          score: (project_.score * project_.items.length + ex.confirm.length - unticked.length) / (project_.items.length + ex.confirm.length),
        }
      : project_;
    if (which === "try") {
      setTryResult(r);
      if (r.pass) save({ tryPassed: true });
    } else {
      setPracticeResult(r);
      if (r.pass) passPractice();
    }
  };
  const passPractice = () => {
    save({ practicePassed: true });
    completeStudioLesson(lesson.id);
  };
  const startOver = async (which: "try" | "practice") => {
    const ex = which === "try" ? lesson.tryIt : lesson.practice;
    if (await prepare(which, ex.setup, true)) which === "try" ? setTryResult(null) : setPracticeResult(null);
  };

  // ---- stages ----
  const tryPassed = studioState.progress(lesson.id).tryPassed;
  const practicePassed = studioState.progress(lesson.id).practicePassed;
  const canAdvance: Record<StageId, boolean> = { hook: true, watch: true, try: finished || tryPassed, practice: finished || practicePassed, quick: finished || quickResult === "right", done: false };
  const go = async (s: StageId) => {
    stopWatch();
    stopPattern();
    stopSpeaking();
    if (s === "try" && !(await prepare("try", lesson.tryIt.setup))) return;
    if (s === "practice" && !(await prepare("practice", lesson.practice.setup))) return;
    if (s === "watch" && lesson.watch.setup && !(await prepare("watch", lesson.watch.setup))) return;
    setStage(s);
    setTab("lesson");
    const i = STAGES.findIndex((x) => x.id === s);
    save({ stage: s, reached: Math.max(studioState.progress(lesson.id).reached, i) });
  };
  const speech = (s: StageId) =>
    s === "hook" ? `${lesson.hook.headline}. ${lesson.hook.text}` : s === "watch" ? (steps[Math.max(0, watchIndex)]?.caption ?? "") : s === "try" ? lesson.tryIt.instruction : s === "practice" ? lesson.practice.instruction : s === "quick" ? lesson.quick.question : `Well done. ${lesson.recap.join(" ")}`;
  useEffect(() => {
    if (voice && canSpeak && stage !== "watch") speak(speech(stage));
    else if (!voice) stopSpeaking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, canSpeak, stage]);

  const playHookExample = async () => {
    if (lesson.hook.pattern) return playPattern(lesson.hook.pattern);
    for (const s of lesson.hook.sounds ?? []) {
      const e = demoSound(s);
      setLit({ litCategory: s.category, litSoundId: e?.id });
      await sleep(s.category === "Loop" || s.category === "FX" ? 2600 : 700);
    }
    setLit({});
  };
  const answerQuick = () => {
    if (picked === null) return;
    const right = picked === lesson.quick.correct;
    setQuickResult(right ? "right" : "wrong");
    setQuickTries((n) => n + 1);
    save({ quickPicked: picked, quickRight: right });
  };

  // ---- what the workspace shows ----
  const hints = studioState.progress(lesson.id).hints;
  const guide: StudioGuide =
    stage === "try"
      ? { targets: lesson.tryIt.targets, editNotes: lesson.tryIt.editNotes }
      : stage === "practice"
        ? { targets: hints >= 3 ? lesson.practice.targets : undefined, editNotes: lesson.practice.editNotes }
        : stage === "watch"
          ? { readOnly: true, ...lit, targets: watchIndex >= 0 ? steps[watchIndex]!.targets : undefined, litBars: watchIndex >= 0 ? steps[watchIndex]!.bars : undefined }
          : { readOnly: true, ...lit };
  const labelsTask = (stage === "try" && lesson.tryIt.labels) || (stage === "practice" && lesson.practice.labels);

  const body = (() => {
    switch (stage) {
      case "hook":
        return (
          <Card>
            <div className="text-xs text-slate-500">
              {moduleCode} · {lesson.title}
            </div>
            <h2 className="mt-1 text-3xl font-semibold text-white">{lesson.hook.headline}</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-slate-300">{lesson.hook.text}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button onClick={() => speak(speech("hook"))} disabled={!canSpeak} title={canSpeak ? "Read this aloud" : "No speech voice is installed on this computer"} className="flex items-center gap-2 rounded-xl bg-violet-500/25 px-4 py-2.5 text-sm font-semibold text-violet-100 hover:bg-violet-500/40 disabled:opacity-40" data-testid="hook-hear">
                <SpeakerIcon size={17} /> Hear it
              </button>
              {((lesson.hook.sounds?.length ?? 0) > 0 || lesson.hook.pattern) && (
                <button onClick={() => void playHookExample()} className="flex items-center gap-2 rounded-xl bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-100 ring-1 ring-white/10 hover:bg-white/10" data-testid="hook-play">
                  ▶ Play example
                </button>
              )}
            </div>
          </Card>
        );
      case "watch": {
        const current = watchIndex >= 0 ? steps[watchIndex] : null;
        return (
          <div className="flex flex-col gap-3">
            <Card>
              <div className="text-xs text-slate-500">Watch · {watchIndex >= 0 ? `step ${watchIndex + 1} of ${steps.length}` : "ready"}</div>
              <p className="mt-2 min-h-[96px] text-lg leading-relaxed text-white" data-testid="watch-caption" aria-live="polite">
                {current?.caption ?? "Press Play to watch how it is done."}
              </p>
              <div className="mt-3 flex gap-1.5">
                {steps.map((_, i) => (
                  <span key={i} className={`h-1.5 flex-1 rounded-full ${i <= watchIndex ? "bg-violet-400" : "bg-white/10"}`} />
                ))}
              </div>
            </Card>
            <div className="flex gap-2">
              <button className={smallBtn} onClick={() => (watchRunning ? stopWatch() : void runWatch())} data-testid="watch-play">
                {watchRunning ? "■ Stop" : watchIndex >= 0 ? "↻ Watch again" : "▶ Play"}
              </button>
            </div>
          </div>
        );
      }
      case "try":
      case "practice": {
        const ex = stage === "try" ? lesson.tryIt : lesson.practice;
        const result = stage === "try" ? tryResult : practiceResult;
        return (
          <div className="flex flex-col gap-3">
            <Card tone="goal">
              <div className="text-[11px] font-semibold tracking-widest text-emerald-300 uppercase">{stage === "try" ? "Try it" : "Practice · no targets"}</div>
              <p className="mt-1 text-sm leading-relaxed text-slate-200" data-testid="exercise-instruction">
                {ex.instruction}
              </p>
              {!labelsTask && <div className="mt-3 text-xs text-slate-400">{seqLesson ? "Work on the step sequencer on the right, then check your work." : stage === "try" ? "Work in the panel on the right: the dashed box shows where." : "Work in the panel on the right, then check your work."}</div>}
            </Card>
            {setupError && <p className="text-sm text-rose-300">{setupError}</p>}
            {labelsTask ? (
              <LabelTask key={stage} labels={ex.labels!} passed={stage === "try" ? tryPassed : practicePassed} onPass={() => (stage === "try" ? save({ tryPassed: true }) : passPractice())} />
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <button className={checkBtn} onClick={() => check(ex, stage)} data-testid="lesson-check">
                    ✓ Check my work
                  </button>
                  {stage === "practice" && (
                    <button className={smallBtn} onClick={() => save({ hints: Math.min(3, hints + 1) })} disabled={hints >= 3} data-testid="lesson-hint">
                      {hints >= 3 ? "No more hints" : `Hint ${hints + 1}/3${hints === 2 ? ": show where" : ""}`}
                    </button>
                  )}
                  {ex.setup && (
                    <button className={smallBtn} onClick={() => void startOver(stage)} data-testid="lesson-reset">
                      Start over
                    </button>
                  )}
                </div>
                {ex.confirm && (
                  <Card>
                    <div className="text-sm font-semibold text-slate-100">Tell me when you did it</div>
                    <div className="mt-2 flex flex-col gap-2">
                      {ex.confirm.map((c, i) => (
                        <label key={c} className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-200">
                          <input type="checkbox" checked={!!confirmed[`${stage}:${c}`]} onChange={(e) => setConfirmed({ ...confirmed, [`${stage}:${c}`]: e.target.checked })} className="h-4 w-4 accent-emerald-400" data-testid={`confirm-${i}`} />
                          {c}
                        </label>
                      ))}
                    </div>
                  </Card>
                )}
                {result && <ResultCard result={result} />}
              </>
            )}
            {stage === "practice" && hints > 0 && (
              <Card>
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <BulbIcon className="text-amber-300" size={16} /> Hints
                </div>
                <ol className="mt-2 list-decimal space-y-1.5 pl-6 text-sm text-slate-300" data-testid="hint-list">
                  {lesson.practice.hints.slice(0, hints).map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ol>
              </Card>
            )}
          </div>
        );
      }
      case "quick":
        return (
          <Card>
            <div className="text-[11px] font-semibold tracking-widest text-violet-300 uppercase">Quick check</div>
            <h2 className="mt-1 text-xl font-semibold text-white">{lesson.quick.question}</h2>
            <div className="mt-4 flex flex-col gap-2" role="radiogroup" aria-label="Answers">
              {lesson.quick.options.map((o, i) => (
                <label key={o} className={`flex cursor-pointer items-center gap-3 rounded-xl px-4 py-2.5 text-sm ring-1 transition-colors ${picked === i ? "bg-violet-500/15 text-white ring-violet-400/60" : "text-slate-300 ring-white/10 hover:bg-white/5"}`}>
                  <input type="radio" name="kick-quick" checked={picked === i} onChange={() => (setPicked(i), setQuickResult(null))} className="accent-violet-400" data-testid={`quick-option-${i}`} />
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
                  Not quite. Read the question again and try another answer.
                </span>
              )}
            </div>
            {quickResult === "right" && (
              <p className="mt-3 rounded-xl bg-emerald-400/10 p-3 text-sm text-emerald-100 ring-1 ring-emerald-400/30" data-testid="quick-feedback">
                Correct! {lesson.quick.explanation}
              </p>
            )}
          </Card>
        );
      case "done":
        return (
          <div className="flex flex-col gap-3">
            <div className="rounded-xl bg-emerald-400/10 p-4 ring-1 ring-emerald-400/30">
              <div className="font-semibold text-emerald-200">Lesson complete</div>
              <div className="mt-1 text-sm text-slate-300">
                {hints} hint{hints === 1 ? "" : "s"}, {quickTries} quick-check answer{quickTries === 1 ? "" : "s"} this visit. Your work stays in the project, on the lesson tracks.
              </div>
            </div>
            <Card>
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
            </Card>
            <div className="flex flex-wrap gap-2">
              {next && (
                <button className={solidBtn} onClick={next.open} data-testid="next-sub-lesson">
                  Next: {next.title} →
                </button>
              )}
              <button className={next ? ghostBtn : solidBtn} onClick={onBackToPath} data-testid="back-to-path-done">
                Back to {courseTitle}
              </button>
            </div>
          </div>
        );
    }
  })();

  const footer =
    stage === "done" ? null : (
      <div className="flex items-center justify-between border-t border-white/10 p-3">
        <button className={ghostBtn} disabled={stageIndex === 0} onClick={() => void go(STAGES[stageIndex - 1]!.id)}>
          ← Back
        </button>
        <span className="text-xs text-slate-500">{canAdvance[stage] ? "" : stage === "quick" ? "Answer correctly to continue" : "Pass the check to continue"}</span>
        <button className={solidBtn} disabled={!canAdvance[stage]} onClick={() => void go(STAGES[stageIndex + 1]!.id)} data-testid="stage-next">
          {STAGES[stageIndex + 1] ? `Next: ${STAGES[stageIndex + 1]!.label} →` : "Next →"}
        </button>
      </div>
    );

  const reached = studioState.progress(lesson.id).reached;
  return (
    <>
      <div className="flex min-h-[470px] flex-1 gap-4">
        <section className="flex w-[440px] shrink-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#11141c]">
          <div className="flex border-b border-white/10 px-2" role="tablist">
            {([["lesson", "Lesson", BookIcon], ["notes", "Notes", NotesIcon]] as const).map(([id, label, Icon]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`flex flex-1 items-center justify-center gap-2 border-b-2 px-2 py-3 text-sm transition-colors ${tab === id ? "border-emerald-300 font-semibold text-emerald-300" : "border-transparent text-slate-400 hover:text-slate-200"}`} data-testid={`learn-tab-${id}`}>
                <Icon size={16} /> {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{tab === "lesson" ? body : <NotesTab lessonId={lesson.id} />}</div>
          {tab === "lesson" && footer}
        </section>
        {seqLesson ? (
          <SequencerPane project={project} ready={spaceReady} guide={stage === "hook" || stage === "watch" ? { demo: demoPads ?? lesson.hook.pattern ?? [], demoStep } : {}} />
        ) : (
          <StudioPane project={project} guide={guide} ready={spaceReady} />
        )}
      </div>

      <div className="flex gap-4">
        <section className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-[#11141c] px-5 py-4" data-testid="learn-tracker">
          <div className="text-sm font-semibold text-slate-200">Your progress</div>
          <ol className="mt-3 flex items-center">
            {STAGES.map((s, i) => {
              const active = s.id === stage;
              const done = i < reached && !active;
              const locked = !finished && i > reached;
              return (
                <li key={s.id} className="flex min-w-0 flex-1 items-center">
                  <button disabled={locked} onClick={() => void go(s.id)} className="flex min-w-0 items-center gap-2.5 text-left disabled:cursor-not-allowed" title={locked ? "Finish the earlier stages first" : s.label} data-testid={`stage-${s.id}`}>
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ring-2 transition-colors ${active ? "text-emerald-300 shadow-[0_0_14px_rgba(110,231,183,.35)] ring-emerald-300" : done ? "bg-emerald-300 text-slate-900 ring-emerald-300" : "text-slate-400 ring-white/15"}`}>
                      {done ? <CheckIcon size={16} /> : i + 1}
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
          <button className="flex items-center gap-1.5 rounded-xl bg-white/5 px-3 py-2 text-sm text-slate-200 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40" disabled={!canSpeak} onClick={() => speak(speech(stage))} data-testid="learn-replay">
            <SpeakerIcon size={16} /> Replay
          </button>
        </section>
      </div>
      <button className="flex items-center gap-2 self-start text-sm text-slate-500 hover:text-slate-300" onClick={onBackToPath}>
        <ArrowLeft size={15} /> Back to {courseTitle}
      </button>
    </>
  );
}
