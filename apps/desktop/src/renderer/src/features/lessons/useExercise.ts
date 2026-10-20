import { useEffect, useRef, useState } from "react";
import type { Project } from "@daw/shared";
import { playClip, type Preview } from "./audio";
import { runCheck } from "./checks";
import { lessonEvents } from "./events";
import { findExercise, resetExerciseOps, startExerciseOps } from "./setup";
import { studyLog } from "./studyLog";
import type { CheckResult, Lesson, Step } from "./types";

const uuid = () => crypto.randomUUID();

export type ExerciseStep = Extract<Step, { kind: "exercise" }>;

/**
 * Everything an exercise does, independent of how it is drawn: set up / continue (ops through window.daw), Check,
 * Hint, Reset, the Listen preview, the lesson-completed event and the study log. Mount it once per lesson (key the
 * component by lesson id) so its state starts fresh for each lesson.
 */
export function useExercise(lesson: Lesson, step: ExerciseStep, project: Project, onOpenClip: (trackId: string, clipId: string | null) => void) {
  const ex = step.exercise;
  const found = findExercise(project, lesson.id);
  const [started, setStarted] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [hintsShown, setHintsShown] = useState(0);
  const [checks, setChecks] = useState(0);
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const preview = useRef<Preview | null>(null);

  // Leaving the lesson ends the study record if it was not passed, and stops any preview.
  useEffect(
    () => () => {
      studyLog.leaveExercise();
      preview.current?.stop();
    },
    [],
  );

  /** Puts the exercise into the project (or reuses it) and shows it in the piano roll. */
  const start = async (): Promise<boolean> => {
    const r = startExerciseOps(project, lesson, ex, uuid);
    if (!r.ok) return setError(r.reason), false;
    if (r.ops.length) {
      const res = await window.daw.dispatchBatch(r.ops);
      if (!res.ok) return setError(`Could not set up the exercise: ${res.reason ?? "unknown error"}`), false;
    }
    setError("");
    setStarted(true);
    studyLog.beginExercise(lesson.id, lesson.version, step.id);
    onOpenClip(r.trackId, r.clipId);
    return true;
  };

  const check = () => {
    if (!found) return;
    const r = runCheck(found.clip, ex.check);
    setResult(r);
    setChecks((n) => n + 1);
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

  const hint = () => {
    if (hintsShown >= ex.hints.length) return;
    setHintsShown(hintsShown + 1);
    studyLog.recordHint();
  };

  const reset = async () => {
    if (!found) return;
    const res = await window.daw.dispatchBatch(resetExerciseOps(found, found.clip, ex, uuid));
    if (!res.ok) return setError(`Could not reset: ${res.reason ?? "unknown error"}`);
    setError("");
    setResult(null);
    studyLog.recordReset();
  };

  /** The lesson's own preview sound (works without the audio engine). Toggles play / stop. */
  const listen = () => {
    if (preview.current) return preview.current.stop();
    if (!found) return;
    const p = playClip(found.clip, found.track.instrument, project.tempo);
    preview.current = p;
    setListening(true);
    p.onEnded(() => {
      if (preview.current === p) preview.current = null;
      setListening(false);
    });
  };

  return {
    exercise: ex,
    found,
    started,
    /** The exercise track was there and has gone (for example undone with Ctrl+Z). */
    removed: started && !found,
    result,
    checks,
    hintsShown,
    error,
    listening,
    completed: lessonEvents.isCompleted(lesson.id),
    start,
    check,
    hint,
    reset,
    listen,
  };
}

export type ExerciseState = ReturnType<typeof useExercise>;
