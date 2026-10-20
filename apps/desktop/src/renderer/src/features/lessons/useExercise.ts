import { useEffect, useRef, useState } from "react";
import { TICKS_PER_BAR, songTicks, type OpBody, type Project } from "@daw/shared";
import { playClip, type Preview } from "./audio";
import { runCheck } from "./checks";
import { lessonEvents } from "./events";
import { findExercise, resetExerciseOps, startExerciseOps } from "./setup";
import { studyLog } from "./studyLog";
import type { CheckResult, Lesson, StarterNote, Step } from "./types";

const uuid = () => crypto.randomUUID();

export type ExerciseStep = Extract<Step, { kind: "exercise" }>;

/**
 * Everything an exercise does, independent of how it is drawn: set up / continue (ops through window.daw), Check,
 * Hint, Reset, the Listen preview, the lesson-completed event and the study log. Mount it once per lesson (key the
 * component by lesson id) so its state starts fresh for each lesson.
 */
export function useExercise(
  lesson: Pick<Lesson, "id" | "version" | "title" | "concept">,
  step: ExerciseStep,
  project: Project,
  onOpenClip: (trackId: string, clipId: string | null) => void,
  /** false for practice-only stages that must not complete the lesson (for example a guided Try). */
  completes = true,
  /** Where the exercise lives in the project, when it is not the lesson's own track (sub-lessons share one practice track). */
  workspace?: Pick<Lesson, "id" | "title">,
  /** Hint level to resume at (the learner left and came back). */
  initialHints = 0,
) {
  const ex = step.exercise;
  const where = workspace ?? lesson;
  const found = findExercise(project, where.id);
  const [started, setStarted] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [hintsShown, setHintsShown] = useState(initialHints);
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

  /**
   * Puts the exercise into the project (or reuses it) and shows it in the piano roll. With `fresh`, an existing clip is
   * reset to this exercise's length and starting notes first (a shared practice track is reused by every stage).
   * `restore` replaces the starting notes with the learner's own saved notes, so coming back continues their work.
   */
  const start = async (fresh = false, restore?: StarterNote[]): Promise<boolean> => {
    const exUse = restore ? { ...ex, starterNotes: restore } : ex;
    const r = startExerciseOps(project, where, exUse, uuid);
    if (!r.ok) return setError(r.reason), false;
    let ops: OpBody[] = r.ops;
    if (!ops.length && fresh && found) {
      const lengthen: OpBody[] = songTicks(project) < ex.bars * TICKS_PER_BAR ? [{ type: "setSongLength", bars: ex.bars }] : [];
      ops = [...lengthen, ...resetExerciseOps(found, found.clip, exUse, uuid)];
    }
    // The lesson's own track must be audible: a mute set in the studio would make every key and note silent here.
    if (found?.track.mute) ops = [...ops, { type: "updateTrack", trackId: found.trackId, changes: { mute: false } }];
    if (ops.length) {
      const res = await window.daw.dispatchBatch(ops);
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
    const r = runCheck(found.clip, ex.check, { tempo: project.tempo });
    setResult(r);
    setChecks((n) => n + 1);
    studyLog.recordCheck(r.score, r.pass);
    if (r.pass && completes) {
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

  /** Removes every note (no study-log entry): used when moving from a guided stage to a blank one. */
  const clear = async () => {
    if (!found) return;
    const noteIds = Object.keys(found.clip.notes);
    if (!noteIds.length) return;
    await window.daw.dispatchBatch(noteIds.map((noteId) => ({ type: "deleteNote" as const, trackId: found.trackId, clipId: found.clipId, noteId })));
    setResult(null);
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
    clear,
    listen,
  };
}

export type ExerciseState = ReturnType<typeof useExercise>;
