import { useEffect, useState } from "react";
import type { Project } from "@daw/shared";
import { runCheck } from "./checks";
import { LESSONS } from "./content";
import { lessonEvents } from "./events";
import { findExercise, resetExerciseOps, startExerciseOps } from "./setup";
import { studyLog } from "./studyLog";
import type { CheckResult, Lesson, Step } from "./types";

if (import.meta.env.DEV) lessonEvents.onLessonCompleted((e) => console.info("[lessons] lesson-completed", e));

const uuid = () => crypto.randomUUID();
const btn = "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40";
const idle = "bg-white/5 text-slate-300 hover:bg-white/10";
const primary = "bg-cyan-400/20 text-cyan-100 ring-1 ring-cyan-400/40 hover:bg-cyan-400/30";

interface Props {
  project: Project;
  /** Shows a track/clip in the arrangement and piano roll (App's own selection). */
  onOpenClip: (trackId: string, clipId: string | null) => void;
  onClose: () => void;
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function StudySection() {
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const [, rerender] = useState(0);
  const refresh = () => rerender((n) => n + 1);
  const session = studyLog.session();
  const count = studyLog.records().length;
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

  return (
    <details className="mt-auto border-t border-white/10 px-3 py-2 text-xs text-slate-400" data-testid="study-section">
      <summary className="cursor-pointer select-none">Researcher: study session {session ? <span className="text-emerald-300">· {session.participant} recording</span> : "· off"}</summary>
      <div className="mt-2 flex flex-col gap-2">
        {session ? (
          <button className={`${btn} ${idle}`} onClick={() => (studyLog.endSession(), setMsg(""), refresh())}>
            End session {session.participant}
          </button>
        ) : (
          <div className="flex gap-1">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Participant code, e.g. P07" className="min-w-0 flex-1 rounded bg-white/5 px-2 py-1 text-slate-200 outline-none" aria-label="Participant code" />
            <button
              className={`${btn} ${idle}`}
              onClick={() => {
                const r = studyLog.startSession(code);
                setMsg(r.ok ? "" : r.reason);
                if (r.ok) setCode("");
                refresh();
              }}
            >
              Start
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <span>{count} records stored on this computer.</span>
          <button className={`${btn} ${idle}`} disabled={!count} onClick={() => download(`lessons-study-${stamp()}.json`, studyLog.exportJson(), "application/json")}>
            Export JSON
          </button>
          <button className={`${btn} ${idle}`} disabled={!count} onClick={() => download(`lessons-study-${stamp()}.csv`, studyLog.exportCsv(), "text/csv")}>
            Export CSV
          </button>
          <button
            className={`${btn} ${idle}`}
            disabled={!count}
            onClick={() => {
              const who = window.prompt("Delete all records for which participant code?")?.trim();
              if (!who) return;
              if (!window.confirm(`Permanently delete every record for ${who}?`)) return;
              setMsg(`Deleted ${studyLog.deleteParticipant(who)} records for ${who}.`);
              refresh();
            }}
          >
            Delete a participant…
          </button>
        </div>
        {msg && <div className="text-amber-300">{msg}</div>}
        <p className="text-[10px] text-slate-500">Only exercise times, Check/Hint/Reset counts and scores are recorded, and only while a session is on. Nothing leaves this computer unless you export it.</p>
      </div>
    </details>
  );
}

function ExerciseStep({ lesson, step, project, onOpenClip, onClose }: { lesson: Lesson; step: Extract<Step, { kind: "exercise" }> } & Props) {
  const ex = step.exercise;
  const found = findExercise(project, lesson.id);
  const [started, setStarted] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [hints, setHints] = useState(0);
  const [error, setError] = useState("");
  const done = lessonEvents.isCompleted(lesson.id);

  // Leaving the step (or the panel) ends the study record if it was not passed.
  useEffect(() => () => studyLog.leaveExercise(), []);

  const start = async () => {
    const r = startExerciseOps(project, lesson, ex, uuid);
    if (!r.ok) return setError(r.reason);
    if (r.ops.length) {
      const res = await window.daw.dispatchBatch(r.ops);
      if (!res.ok) return setError(`Could not set up the exercise: ${res.reason ?? "unknown error"}`);
    }
    setError("");
    setStarted(true);
    studyLog.beginExercise(lesson.id, lesson.version, step.id);
    onOpenClip(r.trackId, r.clipId);
  };

  const check = () => {
    if (!found) return;
    const r = runCheck(found.clip, ex.check);
    setResult(r);
    studyLog.recordCheck(r.score, r.pass);
    if (r.pass) {
      lessonEvents.complete({
        type: "lesson-completed",
        schema: 1,
        lessonId: lesson.id,
        lessonVersion: lesson.version,
        concept: lesson.concept,
        completedAt: new Date().toISOString(),
        trackId: found.trackId,
        clipId: found.clipId,
      });
    }
  };

  const reset = async () => {
    if (!found) return;
    const res = await window.daw.dispatchBatch(resetExerciseOps(found, found.clip, ex, uuid));
    if (!res.ok) return setError(`Could not reset: ${res.reason ?? "unknown error"}`);
    setError("");
    setResult(null);
    studyLog.recordReset();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md bg-amber-300/10 px-3 py-2 text-sm text-amber-100 ring-1 ring-amber-300/20">
        <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-amber-300 uppercase">Goal</div>
        {step.goal}
      </div>

      {!found ? (
        <>
          {started && <p className="text-xs text-rose-300">The exercise track was removed (maybe by Undo). Start it again to continue.</p>}
          <button className={`${btn} ${primary} self-start`} onClick={() => void start()} data-testid="lesson-start">
            {started ? "Restart exercise" : "Start exercise"}
          </button>
        </>
      ) : (
        <>
          {!started && (
            <button className={`${btn} ${primary} self-start`} onClick={() => void start()} data-testid="lesson-continue">
              Continue in the piano roll
            </button>
          )}
          {started && <p className="text-xs text-slate-400">Edit the “{found.track.name}” clip in the piano roll below, press Play to listen, then Check.</p>}
          <div className="flex flex-wrap gap-1">
            <button className={`${btn} ${primary}`} disabled={!started} onClick={check} data-testid="lesson-check">
              ✓ Check
            </button>
            <button
              className={`${btn} ${idle}`}
              disabled={!started || hints >= ex.hints.length}
              onClick={() => {
                setHints(hints + 1);
                studyLog.recordHint();
              }}
              data-testid="lesson-hint"
            >
              Hint ({hints}/{ex.hints.length})
            </button>
            <button className={`${btn} ${idle}`} disabled={!started} onClick={() => void reset()} title="Put the exercise back to how it started (undoable)">
              Reset
            </button>
          </div>
        </>
      )}

      {error && <p className="text-xs text-rose-300">{error}</p>}

      {hints > 0 && (
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs text-slate-300">
          {ex.hints.slice(0, hints).map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ol>
      )}

      {result && (
        <div className={`rounded-md px-3 py-2 text-sm ring-1 ${result.pass ? "bg-emerald-400/10 text-emerald-100 ring-emerald-400/30" : "bg-rose-400/10 text-rose-100 ring-rose-400/30"}`} data-testid="lesson-result" data-pass={result.pass}>
          <div className="font-medium">{result.pass ? "Well done!" : "Not yet"}</div>
          <div className="mt-0.5">{result.feedback}</div>
          <ul className="mt-2 flex flex-col gap-0.5 text-xs">
            {result.items.map((i) => (
              <li key={i.label} className={i.ok ? "text-emerald-300" : "text-slate-400"}>
                {i.ok ? "✓" : "○"} {i.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(result?.pass || (done && found)) && found && (
        <button
          className={`${btn} ${primary} self-start`}
          onClick={() => {
            onOpenClip(found.trackId, found.clipId);
            onClose();
          }}
          data-testid="lesson-apply"
        >
          Apply it in the DAW →
        </button>
      )}
    </div>
  );
}

export function LessonPanel(props: Props) {
  const [lessonId, setLessonId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const lesson = LESSONS.find((l) => l.id === lessonId);
  const step = lesson?.steps[stepIndex];

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-white/10 bg-[#10131a]" data-testid="lesson-panel">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        {lesson && (
          <button className="text-xs text-slate-400 hover:text-slate-200" onClick={() => setLessonId(null)} aria-label="Back to lessons">
            ← Lessons
          </button>
        )}
        <span className="text-sm font-semibold text-slate-200">{lesson ? lesson.title : "Lessons"}</span>
        <button className="ml-auto text-slate-500 hover:text-slate-300" onClick={props.onClose} aria-label="Close lessons">
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!lesson || !step ? (
          <ul className="flex flex-col gap-2">
            {LESSONS.map((l, i) => (
              <li key={l.id}>
                <button
                  className="w-full rounded-md bg-white/5 px-3 py-2 text-left hover:bg-white/10"
                  onClick={() => {
                    setLessonId(l.id);
                    setStepIndex(0);
                  }}
                  data-testid={`lesson-${l.id}`}
                >
                  <div className="flex items-center text-sm text-slate-200">
                    {i + 1}. {l.title}
                    {lessonEvents.isCompleted(l.id) && <span className="ml-auto text-xs text-emerald-300">✓ done</span>}
                  </div>
                  <div className="text-xs text-slate-400">{l.summary}</div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="text-[10px] tracking-wide text-slate-500 uppercase">
              Step {stepIndex + 1} of {lesson.steps.length}
            </div>
            <h2 className="text-base font-semibold text-slate-100">{step.title}</h2>
            {step.kind === "explain" ? (
              step.body.map((p) => (
                <p key={p} className="text-sm leading-relaxed text-slate-300">
                  {p}
                </p>
              ))
            ) : (
              <ExerciseStep key={`${lesson.id}/${step.id}`} lesson={lesson} step={step} {...props} />
            )}
            <div className="mt-2 flex gap-1">
              <button className={`${btn} ${idle}`} disabled={stepIndex === 0} onClick={() => setStepIndex(stepIndex - 1)}>
                ← Back
              </button>
              {stepIndex < lesson.steps.length - 1 && (
                <button className={`${btn} ${idle}`} onClick={() => setStepIndex(stepIndex + 1)} data-testid="lesson-next">
                  Next →
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <StudySection />
    </aside>
  );
}
