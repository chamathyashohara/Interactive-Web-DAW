import { browserStore, readJson, writeJson, type KeyValueStore } from "./storage";
import type { Concept } from "./types";

/**
 * Published when a learner completes a lesson for the first time. This is the contract with Component 2
 * (unlocking DAW features). It deliberately carries no evaluation metrics or participant data.
 */
export interface LessonCompletedEvent {
  type: "lesson-completed";
  schema: 1;
  lessonId: string;
  lessonVersion: number;
  concept: Concept;
  /** ISO 8601 */
  completedAt: string;
  /** Where the learner's result lives in the project. */
  trackId: string;
  clipId: string;
}

const KEY = "lessons.progress.v1";

export function createLessonEvents(store: KeyValueStore) {
  const listeners = new Set<(e: LessonCompletedEvent) => void>();
  const load = () => readJson<Record<string, LessonCompletedEvent>>(store, KEY, {});

  return {
    /** Subscribe; returns an unsubscribe function. */
    onLessonCompleted(cb: (e: LessonCompletedEvent) => void): () => void {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    /** Every lesson completed so far (persisted), so unlocks survive a restart. */
    completedLessons(): LessonCompletedEvent[] {
      return Object.values(load());
    },
    isCompleted(lessonId: string): boolean {
      return lessonId in load();
    },
    /** Records the completion and notifies subscribers. Returns false (and stays silent) if it was already completed. */
    complete(event: LessonCompletedEvent): boolean {
      const done = load();
      if (done[event.lessonId]) return false;
      writeJson(store, KEY, { ...done, [event.lessonId]: event });
      for (const cb of listeners) {
        try {
          cb(event);
        } catch (e) {
          console.error("[lessons] lesson-completed subscriber failed", e);
        }
      }
      return true;
    },
  };
}

/** The app-wide instance. Other components import `onLessonCompleted` / `completedLessons` from here. */
export const lessonEvents = createLessonEvents(browserStore());
export const onLessonCompleted = lessonEvents.onLessonCompleted;
export const completedLessons = lessonEvents.completedLessons;
