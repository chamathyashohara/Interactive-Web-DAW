import { useSyncExternalStore } from "react";
import type { Track } from "@daw/shared";
import { libraryStore, previewIdStore } from "../../../store";
import { lessonEvents } from "../events";
import { browserStore, readJson, writeJson, type KeyValueStore } from "../storage";
import type { StageId } from "../subLesson";
import type { StudioCtx } from "./types";

/**
 * State of the Kick Drums lessons, kept across the studio, other lessons and restarts (local storage): each lesson's
 * stage and results, which lesson stage the workspace was last prepared for, and the sounds heard in the browser.
 */

export interface StudioProgress {
  stage: StageId;
  reached: number;
  hints: number;
  tryPassed: boolean;
  practicePassed: boolean;
  quickPicked: number | null;
  quickRight: boolean;
}
export const FRESH: StudioProgress = { stage: "hook", reached: 0, hints: 0, tryPassed: false, practicePassed: false, quickPicked: null, quickRight: false };

/** A lesson's own workspace while another lesson is open. */
export interface Space {
  tracks: Track[];
  owner: string | null;
  heard: string[];
}

interface Saved {
  lessons: Record<string, StudioProgress>;
  /** The lesson whose workspace is in the project now. */
  active: string | null;
  /** Every other lesson's saved workspace. */
  spaces: Record<string, Space>;
  /** The lesson stage the workspace (lesson tracks) was last set up for: "M13.2:practice". */
  owner: string | null;
  /** Library ids heard since the current stage was set up (most recent last, bounded). */
  heard: string[];
}
const KEY = "lessons.studio.v2";
const MAX_HEARD = 200;

export function createStudioState(store: KeyValueStore) {
  let state: Saved = { lessons: {}, active: null, spaces: {}, owner: null, heard: [], ...readJson<Partial<Saved>>(store, KEY, {}) };
  const subs = new Set<() => void>();
  const set = (next: Saved) => {
    state = next;
    writeJson(store, KEY, state);
    subs.forEach((f) => f());
  };
  return {
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    snapshot: () => state,
    progress: (id: string): StudioProgress => state.lessons[id] ?? FRESH,
    saveProgress(id: string, p: StudioProgress) {
      set({ ...state, lessons: { ...state.lessons, [id]: p } });
    },
    /** A finished lesson opened again starts a new run-through from Hook (stages stay open). */
    replay(id: string) {
      const p = state.lessons[id];
      if (p?.stage !== "done") return;
      const space = state.spaces[id];
      set({
        ...state,
        owner: state.owner?.startsWith(`${id}:`) ? null : state.owner,
        spaces: space ? { ...state.spaces, [id]: { ...space, owner: null } } : state.spaces,
        lessons: { ...state.lessons, [id]: { ...p, stage: "hook", hints: 0, quickPicked: null, quickRight: false } },
      });
    },
    active: () => state.active,
    /** A lesson's saved workspace (undefined when it is open, or was never opened). */
    savedSpace: (lessonId: string): Space | undefined => state.spaces[lessonId],
    /**
     * Records that `lessonId`'s workspace is now in the project (call after the tracks were swapped): the previous
     * lesson's tracks (`currentTracks`), stage setup and listening are saved under its id.
     */
    switchSpace(lessonId: string, currentTracks: Track[]): Space | undefined {
      if (state.active === lessonId) return undefined;
      const spaces = { ...state.spaces };
      if (state.active) spaces[state.active] = { tracks: currentTracks, owner: state.owner, heard: state.heard };
      const target = spaces[lessonId];
      delete spaces[lessonId];
      set({ ...state, spaces, active: lessonId, owner: target?.owner ?? null, heard: target?.heard ?? [] });
      return target;
    },
    /**
     * Leaving the lessons: the open lesson's tracks (taken out of the song by the caller) are saved with its stage setup
     * and listening, and no lesson workspace is open any more. The next lesson opened brings its own back.
     */
    park(currentTracks: Track[]) {
      if (!state.active) return;
      set({ ...state, spaces: { ...state.spaces, [state.active]: { tracks: currentTracks, owner: state.owner, heard: state.heard } }, active: null, owner: null, heard: [] });
    },
    owner: () => state.owner,
    /** The workspace now belongs to this lesson stage; listening starts again from nothing. */
    setOwner(owner: string) {
      set({ ...state, owner, heard: [] });
    },
    heard: () => state.heard,
    hear(id: string) {
      if (state.heard[state.heard.length - 1] !== id) set({ ...state, heard: [...state.heard.filter((h) => h !== id), id].slice(-MAX_HEARD) });
    },
  };
}

export const studioState = createStudioState(browserStore());
export const useStudioState = () => useSyncExternalStore(studioState.subscribe, studioState.snapshot);

// Every sound the learner plays in a sound browser (the lesson's or the Studio's) is remembered for the listening tasks.
previewIdStore.subscribe(() => {
  const id = previewIdStore.get();
  if (id) studioState.hear(id);
});

/** What the checks need from outside the project: the library's categories and the sounds heard. */
export function studioCtx(): StudioCtx {
  const byId = new Map(libraryStore.get().entries.map((e) => [e.id, { category: e.category, sub: e.sub }]));
  return { soundOf: (id) => byId.get(id), auditioned: studioState.heard() };
}

/**
 * Records a passed lesson: the lessons' own completed event (Done ticks, the teammate's listeners) and the DAW's
 * progress, which unlocks that lesson's features (`window.daw.completeLesson`, idempotent).
 */
export function completeStudioLesson(id: string) {
  lessonEvents.complete({ type: "lesson-completed", schema: 1, lessonId: id, lessonVersion: 1, concept: "rhythm", completedAt: new Date().toISOString(), trackId: "", clipId: "" });
  void window.daw.completeLesson?.(id).catch(() => undefined);
}
