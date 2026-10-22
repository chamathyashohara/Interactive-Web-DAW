import { contextBridge, ipcRenderer } from "electron";
import type { EngineReady, EngineStatus } from "@daw/engine-protocol";
import type { OpBody, Progress, ProgressMode, Project } from "@daw/shared";
import type { IndexEntry } from "@daw/sounds";

export interface EngineState {
  connected: boolean;
  info: EngineReady | null;
  lastError: string | null;
}
export interface ProjectPayload {
  project: Project;
  canUndo: boolean;
  canRedo: boolean;
}
export type ExportStatus =
  | { state: "running"; id: string; fraction: number; path?: string }
  | { state: "done"; id: string; path: string; seconds: number; frames: number; peak: number }
  | { state: "error"; id: string; message: string };
export type LibraryStatus = { state: "preparing"; fraction: number } | { state: "ready" } | { state: "error"; message: string };
export interface PackInfo {
  name: string;
  origin: "starter" | "imported";
  count: number;
}
export interface LibraryPayload {
  entries: IndexEntry[];
  packs: PackInfo[];
}
export interface LibraryInitial extends LibraryPayload {
  status: LibraryStatus;
}
export interface ImportProgress {
  phase: "extracting" | "importing" | "done";
  done: number;
  total: number;
  current?: string;
}
export interface ImportResult {
  ok: boolean;
  canceled?: boolean;
  reason?: string;
  pack?: string;
  added: number;
  duplicates: number;
  failed: { file: string; reason: string }[];
  brandRemoved: string | null;
}
export type StatusPayload = EngineStatus & { levels: Record<string, number> };
export interface InitialPayload extends ProjectPayload {
  engine: EngineState;
  status: StatusPayload | null;
}

const api = {
  getInitial: (): Promise<InitialPayload> => ipcRenderer.invoke("project:get"),
  dispatch: (body: OpBody, group?: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("op:dispatch", body, group),
  dispatchBatch: (bodies: OpBody[], group?: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("op:batch", bodies, group),
  undo: (): Promise<boolean> => ipcRenderer.invoke("history:undo"),
  redo: (): Promise<boolean> => ipcRenderer.invoke("history:redo"),
  play: () => ipcRenderer.send("transport:play"),
  stop: () => ipcRenderer.send("transport:stop"),
  seek: (tick: number) => ipcRenderer.send("transport:seek", tick),
  setMetronome: (on: boolean) => ipcRenderer.send("transport:metronome", on),
  preview: (trackId: string, pitch: number, velocity: number, on: boolean) => ipcRenderer.send("engine:preview", { trackId, pitch, velocity, on }),
  exportWav: (explicitPath?: string): Promise<{ ok: boolean; canceled?: boolean; reason?: string; id?: string }> => ipcRenderer.invoke("export:wav", explicitPath),
  showInFolder: (filePath: string) => ipcRenderer.send("shell:show", filePath),
  // ---- learner progress (used by the lessons and the feature unlock system) ----
  getProgress: (): Promise<Progress> => ipcRenderer.invoke("progress:get"),
  /** Lessons call this when a lesson is passed: `completeLesson("M2.6")`. Idempotent. Unlocks that lesson's DAW features. */
  completeLesson: (lessonId: string): Promise<{ ok: boolean; progress?: Progress; newlyCompleted?: boolean; reason?: string }> => ipcRenderer.invoke("progress:complete", lessonId),
  setProgressMode: (mode: ProgressMode): Promise<Progress> => ipcRenderer.invoke("progress:setMode", mode),
  resetProgress: (): Promise<Progress> => ipcRenderer.invoke("progress:reset"),
  isDev: (): Promise<boolean> => ipcRenderer.invoke("app:isDev"),
  onProgress: (cb: (p: Progress) => void) => {
    const h = (_: unknown, p: Progress) => cb(p);
    ipcRenderer.on("progress:update", h);
    return () => ipcRenderer.removeListener("progress:update", h);
  },
  // ---- sample library ----
  getLibrary: (): Promise<LibraryInitial> => ipcRenderer.invoke("library:get"),
  previewSample: (id: string) => ipcRenderer.send("library:preview", id),
  stopPreviewSample: () => ipcRenderer.send("library:stopPreview"),
  importSamples: (mode: "zip" | "folder", explicitPath?: string): Promise<ImportResult> => ipcRenderer.invoke("library:import", mode, explicitPath),
  removePack: (name: string): Promise<boolean> => ipcRenderer.invoke("library:removePack", name),
  onLibrary: (cb: (l: LibraryPayload) => void) => {
    const h = (_: unknown, l: LibraryPayload) => cb(l);
    ipcRenderer.on("library:update", h);
    return () => ipcRenderer.removeListener("library:update", h);
  },
  onLibraryStatus: (cb: (s: LibraryStatus) => void) => {
    const h = (_: unknown, s: LibraryStatus) => cb(s);
    ipcRenderer.on("library:status", h);
    return () => ipcRenderer.removeListener("library:status", h);
  },
  onImportProgress: (cb: (p: ImportProgress) => void) => {
    const h = (_: unknown, p: ImportProgress) => cb(p);
    ipcRenderer.on("library:importProgress", h);
    return () => ipcRenderer.removeListener("library:importProgress", h);
  },
  killEngine: () => ipcRenderer.send("debug:killEngine"),
  onProject: (cb: (p: ProjectPayload) => void) => {
    const h = (_: unknown, p: ProjectPayload) => cb(p);
    ipcRenderer.on("project:update", h);
    return () => ipcRenderer.removeListener("project:update", h);
  },
  onEngineState: (cb: (s: EngineState) => void) => {
    const h = (_: unknown, s: EngineState) => cb(s);
    ipcRenderer.on("engine:state", h);
    return () => ipcRenderer.removeListener("engine:state", h);
  },
  onExportStatus: (cb: (s: ExportStatus) => void) => {
    const h = (_: unknown, s: ExportStatus) => cb(s);
    ipcRenderer.on("export:status", h);
    return () => ipcRenderer.removeListener("export:status", h);
  },
  onEngineStatus: (cb: (s: StatusPayload) => void) => {
    const h = (_: unknown, s: StatusPayload) => cb(s);
    ipcRenderer.on("engine:status", h);
    return () => ipcRenderer.removeListener("engine:status", h);
  },
};

export type DawApi = typeof api;
contextBridge.exposeInMainWorld("daw", api);
