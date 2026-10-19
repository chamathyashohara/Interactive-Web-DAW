import { useSyncExternalStore } from "react";
import type { Project } from "@daw/shared";
import type { EngineState, ExportStatus, StatusPayload } from "../../preload/index";

function createStore<T>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (next: T) => {
      state = next;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
  };
}
type Store<T> = ReturnType<typeof createStore<T>>;
export const useStore = <T,>(store: Store<T>): T => useSyncExternalStore(store.subscribe, store.get);

export interface ProjectView {
  project: Project | null;
  canUndo: boolean;
  canRedo: boolean;
}

/** Project data (synced + saved) comes from the main process; it is never mutated here. */
export const projectStore = createStore<ProjectView>({ project: null, canUndo: false, canRedo: false });
export const engineStateStore = createStore<EngineState>({ connected: false, info: null, lastError: null });
/** Engine status arrives ~30 Hz; kept in its own store so only the playhead/diagnostics re-render. */
export const statusStore = createStore<StatusPayload | null>(null);

export const exportStore = createStore<ExportStatus | null>(null);

export async function initStores() {
  const initial = await window.daw.getInitial();
  projectStore.set({ project: initial.project, canUndo: initial.canUndo, canRedo: initial.canRedo });
  engineStateStore.set(initial.engine);
  statusStore.set(initial.status);
  window.daw.onProject((p) => projectStore.set(p));
  window.daw.onEngineState((s) => engineStateStore.set(s));
  window.daw.onEngineStatus((s) => statusStore.set(s));
  window.daw.onExportStatus((s) => exportStore.set(s));
}
