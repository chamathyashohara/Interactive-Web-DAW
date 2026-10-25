import { useSyncExternalStore } from "react";
import { defaultProgress, type MixSnapshot, type OpBody, type Progress, type Project } from "@daw/shared";
import type { IndexEntry } from "@daw/sounds";
import type { TelemetryState } from "../../main/telemetry/telemetryStore";
import type { CollabState, LiveState, RecordingState } from "../../preload/index";
import type { PluginInfo, PluginTrackState } from "../../preload/index";
import type { EngineState, ExportStatus, ProjectListPayload, ImportProgress, ImportResult, LibraryStatus, PackInfo, StatusPayload } from "../../preload/index";

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
/** The list of projects and which one is open (for the Project menu). */
export const projectsStore = createStore<ProjectListPayload>({ projects: [], activeId: "" });
/** Live collaboration session state (who is here, the join code). */
export const collabStore = createStore<CollabState>({ active: false });
/** Where each other person's pointer is (fractions of their window), by user id. */
export const collabPointers = createStore<Record<string, { x: number; y: number }>>({});
/** Notes people put in the room, by topic (the Producer's live-recording address and code). Cleared when the session ends. */
export const collabShares = createStore<Record<string, { id: string; data: unknown }>>({});
/** The Live recording lab: which recorder programs were found and the takes noticed in the watched folder. */
export const recordingStore = createStore<RecordingState | null>(null);
/** The remote-recording session as the main process sees it (null until the first state arrives). */
export const liveStore = createStore<LiveState | null>(null);
/** Whether the Network panel is showing. */
export const collabNetOpen = createStore<boolean>(false);
/** A short message about the session (it ended, a copy was saved...). null = none showing. */
export const collabNoteStore = createStore<string | null>(null);
/** Learner progress: which lessons are done and whether features are gated. */
export const progressStore = createStore<Progress>(defaultProgress());
/** Whether the participant has agreed to the study recording (and under which code). */
export const telemetryStore = createStore<TelemetryState>({ consented: false, participantCode: null, events: 0, session: "" });
/** True in development builds: shows the developer tools (mark a lesson complete) in the Features panel. */
export const devStore = createStore<boolean>(false);

/** Installed third-party plugins (null until the first scan answers) and, per plugin track, what its host process is doing. */
export const pluginListStore = createStore<PluginInfo | null>(null);
export const pluginStateStore = createStore<Record<string, PluginTrackState>>({});

/** The latest mixer measurement (null until the first one arrives) and the fixes the user applied, so each can be taken back. */
export const mixStore = createStore<MixSnapshot | null>(null);
export interface AppliedFix { key: string; label: string; applied: OpBody[]; restore: OpBody[]; atPass: number }
export const mixAppliedStore = createStore<AppliedFix[]>([]);
/** A whole-song analysis in progress (fraction 0..1) or the message of the last one that did not finish. */
export const mixJobStore = createStore<{ running: boolean; fraction: number; message: string | null }>({ running: false, fraction: 0, message: null });
/** The fix being auditioned (a changed copy of the mix plays; the project itself is unchanged), or null. */
export const mixPreviewStore = createStore<{ label: string; ops: OpBody[]; project: Project } | null>(null);
/** The finding whose explanation is open in the mixer (null = the list). */
export const mixFocusStore = createStore<string | null>(null);

export interface LibraryView {
  status: LibraryStatus;
  entries: IndexEntry[];
  packs: PackInfo[];
}
/** The sample library (Starter packs + imported packs). Audio stays in the main process; the UI only sees names, tags and waveforms. */
export const libraryStore = createStore<LibraryView>({ status: { state: "preparing", fraction: 0 }, entries: [], packs: [] });
/** Import progress while one is running, and the result of the last one until it is dismissed. */
export const importStore = createStore<{ progress: ImportProgress | null; result: ImportResult | null }>({ progress: null, result: null });
/** The sample being auditioned in the browser (null = none). Updated by the browser itself. */
export const previewIdStore = createStore<string | null>(null);

export async function initStores() {
  const initial = await window.daw.getInitial();
  projectStore.set({ project: initial.project, canUndo: initial.canUndo, canRedo: initial.canRedo });
  projectsStore.set(initial.projects);
  window.daw.projects.onList((p) => projectsStore.set(p));
  collabStore.set(initial.collab);
  window.daw.collab.onState((s) => {
    collabStore.set(s);
    if (!s.active && Object.keys(collabShares.get()).length) collabShares.set({});
  });
  window.daw.collab.onShare((n) => {
    const next = { ...collabShares.get() };
    if (n.data === null) delete next[n.topic];
    else next[n.topic] = { id: n.id, data: n.data };
    collabShares.set(next);
  });
  void window.daw.recording.getState().then((s) => recordingStore.set(s));
  window.daw.recording.onState((s) => recordingStore.set(s));
  void window.daw.live.getState().then((s) => liveStore.set(s));
  window.daw.live.onState((s) => liveStore.set(s));
  window.daw.collab.onPointer(({ id, pointer }) => {
    const next = { ...collabPointers.get() };
    if (pointer) next[id] = pointer;
    else delete next[id];
    collabPointers.set(next);
  });
  window.daw.collab.onNote((n) => {
    const text =
      n.kind === "saved-copy" ? `The session was saved as a new project, "${n.name ?? "session"}". Your own project is unchanged.`
      : n.kind === "host-ended" ? "The host ended the session."
      : n.kind === "cannot-join" ? "Could not join: check the address and the 6-digit code."
      : null;
    if (text) collabNoteStore.set(text);
  });
  engineStateStore.set(initial.engine);
  statusStore.set(initial.status);
  window.daw.onProject((p) => projectStore.set(p));
  window.daw.onEngineState((s) => engineStateStore.set(s));
  window.daw.onEngineStatus((s) => statusStore.set(s));
  window.daw.onExportStatus((s) => exportStore.set(s));
  // The library can finish preparing while the window is still starting, so events only say "it changed" and the
  // state is always re-read from the main process; a late answer to an older request is dropped.
  let libToken = 0;
  const refreshLibrary = async () => {
    const token = ++libToken;
    const lib = await window.daw.getLibrary();
    if (token === libToken) libraryStore.set({ status: lib.status, entries: lib.entries, packs: lib.packs });
  };
  window.daw.onLibraryStatus((status) => {
    if (status.state === "preparing") libraryStore.set({ ...libraryStore.get(), status });
    else void refreshLibrary();
  });
  window.daw.onLibrary(() => void refreshLibrary());
  await refreshLibrary();
  window.daw.onImportProgress((p) => importStore.set({ ...importStore.get(), progress: p.phase === "done" ? null : p }));
  progressStore.set(await window.daw.getProgress());
  devStore.set(await window.daw.isDev());
  window.daw.onProgress((p) => progressStore.set(p));
  void window.daw.mix.get().then((s) => mixStore.set(s));
  window.daw.mix.onAnalysis((s) => mixStore.set(s));
  window.daw.mix.onPreview((e) => {
    if (e.active) mixPreviewStore.set({ label: e.label, ops: e.ops, project: e.project });
    else {
      mixPreviewStore.set(null);
      mixJobStore.set({ ...mixJobStore.get(), message: e.reason });
    }
  });
  window.daw.mix.onProgress((p) => mixJobStore.set({ running: true, fraction: p.fraction, message: null }));
  window.daw.mix.onDone((r) => mixJobStore.set({ running: false, fraction: r.ok ? 1 : 0, message: r.ok ? null : (r.message ?? "The analysis did not finish.") }));
  void window.daw.plugins.list().then((i) => pluginListStore.set(i));
  void window.daw.plugins.states().then((s) => pluginStateStore.set(s));
  window.daw.plugins.onState(({ trackId, ...s }) => pluginStateStore.set({ ...pluginStateStore.get(), [trackId]: s }));
  telemetryStore.set(await window.daw.telemetry.getState());
  window.daw.telemetry.onState((s) => telemetryStore.set(s));
}
