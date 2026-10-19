import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { EngineReady, EngineStatus } from "@daw/engine-protocol";
import type { OpBody, Project } from "@daw/shared";
import { EngineBridge } from "./engine/engineBridge";
import { SlotAllocator, toEngineSnapshot } from "./engine/snapshot";
import { LocalStore } from "./project/localStore";
import { ProjectService } from "./project/projectService";

interface EngineState {
  connected: boolean;
  info: EngineReady | null;
  lastError: string | null;
}

let win: BrowserWindow | null = null;
const engineState: EngineState = { connected: false, info: null, lastError: null };
let lastStatus: (EngineStatus & { levels: Record<string, number> }) | null = null;

function resolveEnginePath(): string {
  if (process.env.DAW_ENGINE_PATH) return process.env.DAW_ENGINE_PATH;
  return path.resolve(app.getAppPath(), "../../engine/build/daw_engine_artefacts/Release/daw_engine.exe");
}

function sendToRenderer(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0e1118",
    title: "Collab DAW",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  const dataDir = process.env.DAW_DATA_DIR ?? path.join(app.getPath("userData"), "projects", "default");
  fs.mkdirSync(dataDir, { recursive: true });
  const service = new ProjectService(new LocalStore(dataDir));

  const engine = new EngineBridge(resolveEnginePath(), process.env.DAW_ENGINE_BUFFER ? ["--buffer", process.env.DAW_ENGINE_BUFFER] : []);

  const slots = new SlotAllocator();
  const pushProjectToEngine = (project: Project) => engine.send({ t: "loadProject", project: toEngineSnapshot(project, slots) });

  engine.on("ready", (info) => {
    engineState.connected = true;
    engineState.info = info;
    engineState.lastError = null;
    pushProjectToEngine(service.current); // engine (re)starts from the main process' state
    sendToRenderer("engine:state", engineState);
  });
  engine.on("down", () => {
    engineState.connected = false;
    sendToRenderer("engine:state", engineState);
  });
  engine.on("error", (message) => {
    engineState.lastError = message;
    sendToRenderer("engine:state", engineState);
  });
  engine.on("status", (status) => {
    // Translate engine slot meters into per-track levels for the UI.
    const levels: Record<string, number> = {};
    status.slots.forEach((peak, slot) => {
      const id = slots.trackFor(slot);
      if (id) levels[id] = peak;
    });
    lastStatus = { ...status, levels };
    sendToRenderer("engine:status", lastStatus);
  });

  service.subscribe((project, meta) => {
    pushProjectToEngine(project);
    sendToRenderer("project:update", { project, ...meta });
  });

  ipcMain.handle("project:get", () => ({
    project: service.current,
    canUndo: service.canUndo,
    canRedo: service.canRedo,
    engine: engineState,
    status: lastStatus,
  }));
  ipcMain.handle("op:dispatch", (_e, body: OpBody, group?: string) => service.dispatch(body, group));
  ipcMain.handle("op:batch", (_e, bodies: OpBody[], group?: string) => service.dispatchBatch(bodies, group));
  ipcMain.handle("history:undo", () => service.undo());
  ipcMain.handle("history:redo", () => service.redo());
  ipcMain.on("transport:play", () => engine.send({ t: "play" }));
  ipcMain.on("transport:stop", () => engine.send({ t: "stop" }));
  ipcMain.on("transport:seek", (_e, tick: number) => engine.send({ t: "seek", tick }));
  ipcMain.on("engine:preview", (_e, p: { trackId: string; pitch: number; velocity: number; on: boolean }) => {
    const slot = slots.slotFor(p.trackId);
    if (slot !== undefined) engine.send({ t: "preview", slot, pitch: p.pitch, velocity: p.velocity, on: p.on });
  });
  ipcMain.on("debug:killEngine", () => engine.killForTest());

  engine.start();
  createWindow();

  app.on("before-quit", () => {
    engine.stop();
    service.close();
  });
  app.on("window-all-closed", () => app.quit());
});
