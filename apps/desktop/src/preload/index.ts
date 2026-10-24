import { contextBridge, ipcRenderer } from "electron";
import type { EngineReady, EngineStatus } from "@daw/engine-protocol";
import type { OpBody, Progress, ProgressMode, Project } from "@daw/shared";
import type { ProjectMeta } from "../main/project/workspace";
import type { IndexEntry } from "@daw/sounds";
import type { TelemetryState } from "../main/telemetry/telemetryStore";
import type { LiveState, NetIface, SessionTake, BackingStatus } from "../main/recording/liveRecording";
export type { TelemetryState, LiveState, NetIface, SessionTake, BackingStatus };

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
export interface ProjectListPayload {
  projects: ProjectMeta[];
  activeId: string;
}
export type { ProjectMeta };
export interface CollabUser {
  id: string;
  name: string;
  color: string;
}
export type NetSnapshot = ReturnType<InstanceType<typeof import("@daw/collab").NetStats>["snapshot"]>;
export interface RecordingTake {
  file: string;
  name: string;
  bytes: number;
  seenAt: number;
}
export interface RecordingState {
  watchDir: string;
  takes: RecordingTake[];
}
export type CollabState =
  | { active: false }
  | { active: true; hosting: boolean; status: string; code: string; address: string; online?: boolean; lan?: boolean; lanIp?: string; users: CollabUser[]; me: string };
export interface InitialPayload extends ProjectPayload {
  projects: ProjectListPayload;
  collab: CollabState;
  engine: EngineState;
  status: StatusPayload | null;
}

const api = {
  getInitial: (): Promise<InitialPayload> => ipcRenderer.invoke("project:get"),
  // ---- real-time collaboration (host / join a live session) ----
  collab: {
    getState: (): Promise<CollabState> => ipcRenderer.invoke("collab:state"),
    /** No `online` = host on this computer (same network). With `online` = create the session on a server elsewhere (different network). */
    host: (name?: string, online?: { server: string; token?: string }): Promise<{ ok: boolean; code?: string; address?: string; reason?: string }> => ipcRenderer.invoke("collab:host", name, online),
    join: (address: string, code: string, name?: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("collab:join", address, code, name),
    leave: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("collab:leave"),
    onState: (cb: (s: CollabState) => void) => {
      const l = (_e: unknown, s: CollabState) => cb(s);
      ipcRenderer.on("collab:state", l);
      return () => ipcRenderer.removeListener("collab:state", l);
    },
    /** Puts a small note in the room for everyone (null takes it down); people who join later still get it. */
    share: (topic: string, data: unknown | null): Promise<{ ok: boolean }> => ipcRenderer.invoke("collab:share", topic, data),
    onShare: (cb: (n: { id: string; topic: string; data: unknown | null }) => void) => {
      const l = (_e: unknown, n: { id: string; topic: string; data: unknown | null }) => cb(n);
      ipcRenderer.on("collab:share", l);
      return () => ipcRenderer.removeListener("collab:share", l);
    },
    /** The latest ping / sync delay / traffic numbers for the Network panel (null = not in a session). */
    net: (): Promise<NetSnapshot | null> => ipcRenderer.invoke("collab:net"),
    /** Saves the measurements as a CSV file (asks where). */
    exportNet: (explicitPath?: string): Promise<{ ok: boolean; file?: string; canceled?: boolean; reason?: string }> => ipcRenderer.invoke("collab:netExport", explicitPath),
    /** Tells the others where this window's pointer is (fractions of the window); null = it left the window. */
    sendPointer: (pointer: { x: number; y: number } | null): void => ipcRenderer.send("collab:pointer", pointer),
    onPointer: (cb: (p: { id: string; pointer: { x: number; y: number } | null }) => void) => {
      const l = (_e: unknown, p: { id: string; pointer: { x: number; y: number } | null }) => cb(p);
      ipcRenderer.on("collab:pointer", l);
      return () => ipcRenderer.removeListener("collab:pointer", l);
    },
    onNote: (cb: (n: { kind: string; count?: number; name?: string }) => void) => {
      const l = (_e: unknown, n: { kind: string; count?: number; name?: string }) => cb(n);
      ipcRenderer.on("collab:note", l);
      return () => ipcRenderer.removeListener("collab:note", l);
    },
  },
  // ---- remote recording (Component 4, inside the DAW) ----
  recording: {
    getState: (): Promise<RecordingState> => ipcRenderer.invoke("recording:state"),
    chooseFolder: (explicitPath?: string): Promise<{ ok: boolean; canceled?: boolean }> => ipcRenderer.invoke("recording:chooseFolder", explicitPath),
    openFolder: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("recording:openFolder"),
    /** Copies a recording into the sound library (asks which file when none is given) and returns the new library entry. */
    addTake: (file?: string): Promise<{ ok: boolean; canceled?: boolean; reason?: string; entry?: IndexEntry }> => ipcRenderer.invoke("recording:addTake", file),
    pollNow: (): Promise<boolean> => ipcRenderer.invoke("recording:pollNow"),
    onState: (cb: (s: RecordingState) => void) => {
      const l = (_e: unknown, s: RecordingState) => cb(s);
      ipcRenderer.on("recording:state", l);
      return () => ipcRenderer.removeListener("recording:state", l);
    },
  },
  /** The live session: who is connected, readiness, takes, transfers. The window only captures and plays audio; the main process decides everything else. */
  live: {
    getState: (): Promise<LiveState> => ipcRenderer.invoke("live:state"),
    onState: (cb: (s: LiveState) => void) => {
      const l = (_e: unknown, s: LiveState) => cb(s);
      ipcRenderer.on("live:state", l);
      return () => ipcRenderer.removeListener("live:state", l);
    },
    interfaces: (): Promise<NetIface[]> => ipcRenderer.invoke("live:interfaces"),
    createSession: (o: { bind: string; port: number; name?: string; mode?: "both" | "vocal" }): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("live:create", o),
    join: (o: { host: string; port: number; code: string; name?: string }): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("live:join", o),
    leave: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("live:leave"),
    setConsent: (on: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke("live:consent", on),
    setDeliveryConsent: (on: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke("live:deliveryConsent", on),
    record: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("live:record"),
    stop: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("live:stop"),
    newCode: (): Promise<{ ok: boolean; code: string }> => ipcRenderer.invoke("live:newCode"),
    setLead: (ms: number, auto: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke("live:lead", ms, auto),
    setAutoTransfer: (on: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke("live:autoTransfer", on),
    requestTransfer: (take: number): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("live:transfer", take),
    cancelTransfer: (take: number): Promise<{ ok: boolean }> => ipcRenderer.invoke("live:cancelTransfer", take),
    setSyncPlay: (on: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke("live:syncPlay", on),
    // -- backing track (vocal over the producer's song): the window decodes and plays what the main process downloaded --
    onBackingFile: (cb: (f: { id: string; path: string }) => void) => {
      const l = (_e: unknown, f: { id: string; path: string }) => cb(f);
      ipcRenderer.on("live:backingFile", l);
      return () => ipcRenderer.removeListener("live:backingFile", l);
    },
    readBacking: (file: string): Promise<Uint8Array | null> => ipcRenderer.invoke("live:readBacking", file),
    backingReady: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("live:backingReady", id),
    backingFailed: (id: string, why: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("live:backingFailed", id, why),
    onPlayBacking: (cb: (p: { startFrame: number; offsetSec: number; takeId: number; id: string }) => void) => {
      const l = (_e: unknown, p: { startFrame: number; offsetSec: number; takeId: number; id: string }) => cb(p);
      ipcRenderer.on("live:playBacking", l);
      return () => ipcRenderer.removeListener("live:playBacking", l);
    },
    onStopBacking: (cb: () => void) => {
      const l = () => cb();
      ipcRenderer.on("live:stopBacking", l);
      return () => ipcRenderer.removeListener("live:stopBacking", l);
    },
    /** The speaker-to-microphone round trip of this PC (microseconds), measured or estimated, used to line the vocal up with the music. */
    setLatency: (us: number): void => ipcRenderer.send("live:latency", us),
    setTalkback: (send: boolean, hear: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke("live:talkback", send, hear),
    // -- audio plumbing: microphone blocks and Opus packets go to the main process, which owns the files and sockets --
    captureState: (s: { open: boolean; deviceName?: string; sampleRate?: number; channels?: number; failed?: string }): void => ipcRenderer.send("live:captureState", s),
    capture: (frame: number, samples: Float32Array): void => ipcRenderer.send("live:capture", frame, samples),
    sendAudio: (opus: Uint8Array, mediaIndex: number, muted: boolean): void => ipcRenderer.send("live:send", opus, mediaIndex, muted),
    incomingStats: (r: Record<string, number>): void => ipcRenderer.send("live:incomingStats", r),
    onAudio: (cb: (p: { seq: number; mediaIndex: number; payload: Uint8Array; muted: boolean; arrivalMs: number }) => void) => {
      const l = (_e: unknown, p: { seq: number; mediaIndex: number; payload: Uint8Array; muted: boolean; arrivalMs: number }) => cb(p);
      ipcRenderer.on("live:audio", l);
      return () => ipcRenderer.removeListener("live:audio", l);
    },
    onEnd: (cb: () => void) => {
      const l = () => cb();
      ipcRenderer.on("live:end", l);
      return () => ipcRenderer.removeListener("live:end", l);
    },
  },
  // ---- projects (new / open / save as / rename / delete) ----
  projects: {
    list: (): Promise<ProjectListPayload> => ipcRenderer.invoke("project:list"),
    new: (name?: string): Promise<{ ok: boolean; id?: string }> => ipcRenderer.invoke("project:new", name),
    open: (id: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("project:open", id),
    saveAs: (name?: string): Promise<{ ok: boolean; id?: string; reason?: string }> => ipcRenderer.invoke("project:saveAs", name),
    rename: (id: string, name: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("project:rename", id, name),
    delete: (id: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("project:delete", id),
    /** Save the current project to its linked file (prompting the first time). */
    save: (explicitPath?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; reason?: string }> => ipcRenderer.invoke("project:saveFile", explicitPath),
    saveAsFile: (explicitPath?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; reason?: string }> => ipcRenderer.invoke("project:saveFileAs", explicitPath),
    openFile: (explicitPath?: string): Promise<{ ok: boolean; id?: string; canceled?: boolean; reason?: string }> => ipcRenderer.invoke("project:openFile", explicitPath),
    importMidi: (explicitPath?: string): Promise<{ ok: boolean; id?: string; tracks?: number; canceled?: boolean; reason?: string }> => ipcRenderer.invoke("project:importMidi", explicitPath),
    onList: (cb: (p: ProjectListPayload) => void) => {
      const l = (_e: unknown, p: ProjectListPayload) => cb(p);
      ipcRenderer.on("project:list", l);
      return () => ipcRenderer.removeListener("project:list", l);
    },
  },
  dispatch: (body: OpBody, group?: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("op:dispatch", body, group),
  dispatchBatch: (bodies: OpBody[], group?: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("op:batch", bodies, group),
  undo: (): Promise<boolean> => ipcRenderer.invoke("history:undo"),
  redo: (): Promise<boolean> => ipcRenderer.invoke("history:redo"),
  play: () => ipcRenderer.send("transport:play"),
  stop: () => ipcRenderer.send("transport:stop"),
  seek: (tick: number) => ipcRenderer.send("transport:seek", tick),
  setMetronome: (on: boolean) => ipcRenderer.send("transport:metronome", on),
  preview: (trackId: string, pitch: number, velocity: number, on: boolean) => ipcRenderer.send("engine:preview", { trackId, pitch, velocity, on }),
  exportWav: (explicitPath?: string, options?: { tailSeconds?: number }): Promise<{ ok: boolean; canceled?: boolean; reason?: string; id?: string }> => ipcRenderer.invoke("export:wav", explicitPath, options),
  showInFolder: (filePath: string) => ipcRenderer.send("shell:show", filePath),
  // ---- evaluation data: nothing is recorded until the participant agrees ----
  telemetry: {
    getState: (): Promise<TelemetryState> => ipcRenderer.invoke("telemetry:state"),
    onState: (cb: (s: TelemetryState) => void) => {
      const l = (_e: unknown, s: TelemetryState) => cb(s);
      ipcRenderer.on("telemetry:update", l);
      return () => ipcRenderer.removeListener("telemetry:update", l);
    },
    consent: (code: string): Promise<{ ok: boolean; state?: TelemetryState; reason?: string }> => ipcRenderer.invoke("telemetry:consent", code),
    withdraw: (deleteData: boolean): Promise<TelemetryState> => ipcRenderer.invoke("telemetry:withdraw", deleteData),
    /** Interface events only (names start with "ui."). */
    event: (name: string, data: Record<string, string | number | boolean | null> = {}) => ipcRenderer.send("telemetry:event", name, data),
    export: (kind: "json" | "csv", explicitPath?: string): Promise<{ ok: boolean; canceled?: boolean; reason?: string; files?: string[] }> => ipcRenderer.invoke("telemetry:export", kind, explicitPath),
  },
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
