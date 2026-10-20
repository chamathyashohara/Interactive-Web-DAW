import { browserStore, readJson, writeJson, type KeyValueStore } from "./storage";
import type { StageId } from "./subLesson";
import type { StarterNote } from "./types";

/**
 * Where the learner is, so leaving the lessons (to the studio, another sub-lesson or a restart) never loses their place
 * or their notes. The notes themselves live in the project (the shared practice clip, saved by the DAW's own
 * persistence); this only remembers which sub-lesson and stage that clip currently belongs to, a copy of each stage's
 * notes to bring back when the clip has been used by something else since, and the learner's position.
 */

export type LearnViewState = { kind: "path" } | { kind: "sub"; id: string } | { kind: "earlier"; id: string };
export type WorkStage = "try" | "practice";

export interface SubProgress {
  stage: StageId;
  reached: number;
  hints: number;
  tryPassed: boolean;
  practicePassed: boolean;
  quickPicked: number | null;
  quickRight: boolean;
}

export interface PaneSettings {
  tool: string;
  snap: boolean;
  gridTicks: number;
  pxPerBeat: number;
  rowH: number;
}

interface Saved {
  view: LearnViewState;
  subs: Record<string, SubProgress>;
  /** Which sub-lesson stage the shared practice clip currently holds. */
  owner: { subId: string; stage: WorkStage } | null;
  /** The learner's notes per sub-lesson stage, keyed "subId:stage". */
  work: Record<string, StarterNote[]>;
  earlier: Record<string, { tab: string; step: number }>;
  pane: PaneSettings | null;
}

const KEY = "lessons.state.v1";
const EMPTY: Saved = { view: { kind: "path" }, subs: {}, owner: null, work: {}, earlier: {}, pane: null };

/** Does entering this stage need the shared clip to be replaced (it holds another stage's or sub-lesson's notes)? */
export const needsFreshClip = (owner: Saved["owner"], subId: string, stage: WorkStage) => !owner || owner.subId !== subId || owner.stage !== stage;

export function createLessonState(store: KeyValueStore) {
  let state: Saved = { ...EMPTY, ...readJson<Partial<Saved>>(store, KEY, {}) };
  const save = () => writeJson(store, KEY, state);
  const workKey = (subId: string, stage: WorkStage) => `${subId}:${stage}`;

  return {
    view: (): LearnViewState => state.view,
    setView(view: LearnViewState) {
      state = { ...state, view };
      save();
    },
    sub: (id: string): SubProgress | undefined => state.subs[id],
    saveSub(id: string, progress: SubProgress) {
      state = { ...state, subs: { ...state.subs, [id]: progress } };
      save();
    },
    owner: () => state.owner,
    setOwner(owner: Saved["owner"]) {
      state = { ...state, owner };
      save();
    },
    work: (subId: string, stage: WorkStage): StarterNote[] | undefined => state.work[workKey(subId, stage)],
    saveWork(subId: string, stage: WorkStage, notes: StarterNote[]) {
      state = { ...state, work: { ...state.work, [workKey(subId, stage)]: notes } };
      save();
    },
    earlier: (id: string) => state.earlier[id],
    saveEarlier(id: string, pos: { tab: string; step: number }) {
      state = { ...state, earlier: { ...state.earlier, [id]: pos } };
      save();
    },
    pane: () => state.pane,
    savePane(pane: PaneSettings) {
      state = { ...state, pane };
      save();
    },
  };
}

export type LessonState = ReturnType<typeof createLessonState>;

/** The app-wide instance (in memory while the app runs, and in local storage across restarts). */
export const lessonState = createLessonState(browserStore());
