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
  onEngineStatus: (cb: (s: StatusPayload) => void) => {
    const h = (_: unknown, s: StatusPayload) => cb(s);
    ipcRenderer.on("engine:status", h);
    return () => ipcRenderer.removeListener("engine:status", h);
  },
};

export type DawApi = typeof api;
contextBridge.exposeInMainWorld("daw", api);
