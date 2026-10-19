import { contextBridge, ipcRenderer } from "electron";
import type { EngineReady, EngineStatus } from "@daw/engine-protocol";
import type { OpBody, Project } from "@daw/shared";

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
  preview: (trackId: string, pitch: number, velocity: number, on: boolean) => ipcRenderer.send("engine:preview", { trackId, pitch, velocity, on }),
  exportWav: (explicitPath?: string): Promise<{ ok: boolean; canceled?: boolean; reason?: string; id?: string }> => ipcRenderer.invoke("export:wav", explicitPath),
  showInFolder: (filePath: string) => ipcRenderer.send("shell:show", filePath),
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
