import { useEffect, useState } from "react";
import type { Project } from "@daw/shared";
import { libraryStore } from "../../../store";
import { BulbIcon, CheckIcon } from "../Icons";
import { ResultCard } from "../ResultCard";
import type { CheckResult } from "../types";
import { lessonView, runStudioCheck, songView } from "./checks";
import { stageSetupOps } from "./exampleSong";
import { parkLessonWork } from "./park";
import { SequencerPane } from "./SequencerPane";
import { trackElement } from "./songChecks";
import { lessonTracksOf, spaceSwitchOps } from "./space";
import { StudioPane } from "./StudioPane";
import { completeStudioLesson, studioCtx, studioState, useStudioState } from "./studioState";
import type { SpecialTask, StudioCheck } from "./types";

const solidBtn = "rounded-xl bg-emerald-300 px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-emerald-200 disabled:opacity-40";
const ghostBtn = "rounded-xl px-4 py-2 text-sm font-medium text-slate-200 ring-1 ring-white/10 transition-colors hover:bg-white/5 disabled:opacity-40";
const checkBtn = "rounded-lg bg-emerald-300 px-3 py-1.5 text-sm font-semibold text-slate-900 transition-colors hover:bg-emerald-200 disabled:opacity-40";
const smallBtn = "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 bg-white/5 text-slate-200 hover:bg-white/10";
const uuid = () => crypto.randomUUID();

/** Several checks as one, against the Special tasks' song (Moonwing's Theme): all must pass; the feedback is the first one that does not. */
export function runAll(p: Project, checks: StudioCheck | StudioCheck[]): CheckResult {
  const ctx = { ...studioCtx(), theme: "moonwing" as const };
  const results = (Array.isArray(checks) ? checks : [checks]).map((c) => runStudioCheck(p, c, ctx));
  const failed = results.find((r) => !r.pass);
  const items = results.flatMap((r) => r.items);
  return { pass: !failed, score: items.length ? items.filter((i) => i.ok).length / items.length : 1, feedback: failed ? failed.feedback : results[results.length - 1]!.feedback, items };
}

interface Props {
  task: SpecialTask;
  project: Project;
  /** Copies the part into the Studio and opens it (parts tasks). */
  onApply: () => void;
  onBack: () => void;
  backLabel: string;
}

/** A Special task: one part of the course song built step by step, then applied to the Studio. */
export function SpecialTaskPage({ task, project, onApply, onBack, backLabel }: Props) {
  useStudioState();
  const p = studioState.progress(task.id);
  const save = (patch: Partial<typeof p>) => studioState.saveProgress(task.id, { ...studioState.progress(task.id), ...patch });
  const done = p.stage === "done";
  const stepIndex = Math.min(p.reached, task.steps.length - 1);
  const [viewing, setViewing] = useState(stepIndex);
  const step = task.steps[viewing]!;
  const [result, setResult] = useState<CheckResult | null>(null);
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [ready, setReady] = useState(task.scope === "song" || studioState.active() === task.id);
  const song = task.scope === "song";

  const live = async () => (await window.daw.getInitial()).project;
  /** The task's own workspace (like a lesson's), set up the first time; the whole-song task works on the song itself. */
  const prepare = async (force = false) => {
    if (song) return void (await parkLessonWork());
    if (studioState.active() !== task.id) {
      const now = await live();
      const ops = spaceSwitchOps(now, studioState.savedSpace(task.id)?.tracks);
      if (ops.length && !(await window.daw.dispatchBatch(ops)).ok) return setMessage("Could not open this task's workspace.");
      studioState.switchSpace(task.id, lessonTracksOf(now));
    }
    const owner = `${task.id}:special`;
    if ((force || studioState.owner() !== owner) && task.setup) {
      const lib = libraryStore.get().entries;
      const loop = lib.find((e) => e.sub === "Drum Loop" && e.meta.bpm === 90);
      const r = stageSetupOps(await live(), task.setup, uuid, loop ? { id: loop.id, name: loop.name, category: loop.category, durationSec: loop.durationSec, meta: loop.meta } : undefined);
      if (!r.ok) return setMessage(r.reason);
      if (r.ops.length && !(await window.daw.dispatchBatch(r.ops)).ok) return setMessage("Could not prepare the workspace.");
      studioState.setOwner(owner);
    }
    setReady(true);
  };
  useEffect(() => {
    void prepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = () => {
    const view = song ? songView(project) : lessonView(project);
    const r = runAll(view, step.check);
    const unticked = (step.confirm ?? []).filter((c) => !confirmed[`${viewing}:${c}`]);
    const full: CheckResult = step.confirm ? { ...r, pass: r.pass && !unticked.length, feedback: !r.pass ? r.feedback : unticked.length ? `Tick "${unticked[0]}" when you have done it.` : r.feedback, items: [...r.items, ...step.confirm.map((c) => ({ label: c, ok: !unticked.includes(c) }))] } : r;
    setResult(full);
    if (full.pass && viewing === p.reached) {
      const reached = p.reached + 1;
      if (reached >= task.steps.length) {
        save({ reached, stage: "done", hints: 0 });
        completeStudioLesson(task.id);
      } else save({ reached, hints: 0 });
    }
  };
  const goStep = (i: number) => {
    setViewing(i);
    setResult(null);
  };
  const again = async () => {
    save({ reached: 0, stage: "practice", hints: 0 });
    setViewing(0);
    setResult(null);
    await prepare(true);
  };
  const saveMix = () => {
    const mix: Record<string, { volume: number; pan: number }> = {};
    const view = lessonView(project);
    for (const id of view.trackOrder) {
      const t = view.tracks[id]!;
      mix[trackElement(t, studioCtx())] = { volume: t.volume, pan: t.pan };
    }
    studioState.saveMix(mix);
    setMessage("Your mix is saved. The last card, Build the whole song, puts it on your song (Use my mix).");
  };

  const passedStep = viewing < p.reached;
  const guide = { targets: step.targets, ghosts: step.ghosts, tools: step.tools, editNotes: step.editNotes };

  return (
    <div className="flex min-h-[520px] flex-1 gap-4" data-testid="special-task">
      <section className="flex w-[440px] shrink-0 flex-col gap-3 overflow-y-auto rounded-2xl border border-amber-300/30 bg-[#14120c] p-4">
        <div className="rounded-xl bg-amber-300/10 p-4 ring-1 ring-amber-300/25">
          <div className="text-[11px] font-semibold tracking-widest text-amber-200 uppercase">★ Special task</div>
          {task.brief.map((b) => (
            <p key={b} className="mt-2 text-sm leading-relaxed text-slate-200">
              {b}
            </p>
          ))}
        </div>
        <ol className="flex flex-col gap-1" aria-label="Steps" data-testid="special-steps">
          {task.steps.map((s, i) => {
            const ok = i < p.reached;
            const open = i <= p.reached;
            return (
              <li key={s.title}>
                <button disabled={!open} onClick={() => goStep(i)} className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm ${i === viewing ? "bg-white/10 text-white" : open ? "text-slate-200 hover:bg-white/5" : "text-slate-500"}`} data-testid={`special-step-${i}`} data-done={ok ? "true" : undefined}>
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${ok ? "bg-emerald-300 text-slate-900" : i === viewing ? "bg-amber-300 text-slate-900" : "ring-1 ring-white/15"}`}>{ok ? <CheckIcon size={11} /> : i + 1}</span>
                  {s.title}
                </button>
              </li>
            );
          })}
        </ol>
        {done && viewing >= task.steps.length - 1 && result?.pass !== false ? (
          <div className="flex flex-col gap-3" data-testid="special-done">
            <div className="rounded-xl bg-emerald-400/10 p-4 ring-1 ring-emerald-400/30">
              <div className="font-semibold text-emerald-200">{task.apply ? "Part complete" : "Your song is complete"}</div>
              <div className="mt-1 text-sm text-slate-300">{task.apply?.kind === "parts" ? "Apply it to put this part in your song in the Studio. Applying again replaces it." : task.apply?.kind === "mix" ? "Save your levels and pans for the whole song." : "From the first chord to an exported song. There are no rules in making music: keep adding ideas."}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {task.apply?.kind === "parts" && (
                <button className={solidBtn} onClick={onApply} data-testid="special-apply">
                  {task.apply.label} →
                </button>
              )}
              {task.apply?.kind === "mix" && (
                <button className={solidBtn} onClick={saveMix} data-testid="special-save-mix">
                  {task.apply.label}
                </button>
              )}
              {!song && (
                <button className={ghostBtn} onClick={() => void again()} data-testid="special-again">
                  Do it again
                </button>
              )}
              <button className={ghostBtn} onClick={onBack}>
                {backLabel}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/5">
            <div className="text-xs text-slate-500">
              Step {viewing + 1} of {task.steps.length} · {step.title}
            </div>
            <p className="text-sm leading-relaxed text-slate-100" data-testid="special-instruction">
              {step.instruction}
            </p>
            {step.confirm?.map((c, i) => (
              <label key={c} className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-200">
                <input type="checkbox" checked={!!confirmed[`${viewing}:${c}`]} onChange={(e) => setConfirmed({ ...confirmed, [`${viewing}:${c}`]: e.target.checked })} className="h-4 w-4 accent-emerald-400" data-testid={`confirm-${i}`} />
                {c}
              </label>
            ))}
            <div className="flex flex-wrap gap-2">
              <button className={checkBtn} onClick={check} disabled={!ready} data-testid="lesson-check">
                ✓ Check this step
              </button>
              <button className={smallBtn} onClick={() => save({ hints: Math.min(step.hints.length, p.hints + 1) })} disabled={p.hints >= step.hints.length || viewing !== p.reached} data-testid="lesson-hint">
                {p.hints >= step.hints.length ? "No more hints" : "Hint"}
              </button>
              {passedStep && viewing + 1 < task.steps.length && (
                <button className={solidBtn} onClick={() => goStep(viewing + 1)} data-testid="special-next">
                  Next step →
                </button>
              )}
              {task.setup && (
                <button className={smallBtn} onClick={() => void again()} title="Start the task again from an empty workspace">
                  Start over
                </button>
              )}
            </div>
            {result && <ResultCard result={result} />}
            {viewing === p.reached && p.hints > 0 && (
              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-300" data-testid="hint-list">
                {step.hints.slice(0, p.hints).map((h) => (
                  <li key={h} className="flex gap-2">
                    <BulbIcon size={14} className="mt-0.5 shrink-0 text-amber-300" />
                    {h}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {message && (
          <p className="text-sm text-amber-100" role="status" data-testid="special-message">
            {message}
          </p>
        )}
      </section>
      {task.space === "sequencer" ? <SequencerPane project={project} ready={ready} guide={{}} /> : <StudioPane project={project} guide={guide} ready={ready} scope={task.scope} />}
    </div>
  );
}
