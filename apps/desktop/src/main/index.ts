import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EngineReady, EngineStatus } from "@daw/engine-protocol";
import type { OpBody, Project } from "@daw/shared";
import { EngineBridge } from "./engine/engineBridge";
import { SlotAllocator, toEngineSnapshot } from "./engine/snapshot";
import { LibraryService } from "./library/libraryService";
import { SampleAnalyzer } from "./library/sampleAnalyzer";
import { LocalStore } from "./project/localStore";
import { ProgressStore } from "./progress/progressStore";
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

// End-to-end tests keep everything the app stores (settings, local storage, caches) out of the real user profile.
if (process.env.DAW_E2E === "1" && process.env.DAW_USER_DATA) app.setPath("userData", process.env.DAW_USER_DATA);

app.whenReady().then(() => {
  const dataDir = process.env.DAW_DATA_DIR ?? path.join(app.getPath("userData"), "projects", "default");
  fs.mkdirSync(dataDir, { recursive: true });
  const service = new ProjectService(new LocalStore(dataDir));

  // Learner progress (which lessons are done, whether features are gated). Per user, never part of a project.
  const progress = new ProgressStore(process.env.DAW_PROGRESS_DIR ?? app.getPath("userData"), process.env.DAW_PROGRESS_MODE === "beginner" ? "beginner" : "all");
  const publishProgress = () => sendToRenderer("progress:update", progress.get());

  const engine = new EngineBridge(resolveEnginePath(), process.env.DAW_ENGINE_BUFFER ? ["--buffer", process.env.DAW_ENGINE_BUFFER] : []);

  // Sample library: the Starter packs plus the user's imported packs live in the user-data folder (never in a project or the repo).
  const analyzer = new SampleAnalyzer((cmd) => engine.send(cmd), () => engine.running);
  const library = new LibraryService(process.env.DAW_LIBRARY_DIR ?? path.join(app.getPath("userData"), "sample-library"), analyzer.analyze, process.env.DAW_STARTER_DIR);
  let libraryStatus: { state: "preparing"; fraction: number } | { state: "ready" } | { state: "error"; message: string } = { state: "preparing", fraction: 0 };
  const setLibraryStatus = (s: typeof libraryStatus) => {
    libraryStatus = s;
    sendToRenderer("library:status", s);
  };
  library
    .init((done, total) => setLibraryStatus({ state: "preparing", fraction: done / total }))
    .then(() => {
      pushProjectToEngine(service.current); // sample tracks could not find their sounds before the library was ready
      setLibraryStatus({ state: "ready" });
      sendToRenderer("library:update", library.list());
    })
    .catch((err: unknown) => setLibraryStatus({ state: "error", message: err instanceof Error ? err.message : String(err) }));

  const slots = new SlotAllocator();
  const pushProjectToEngine = (project: Project) => engine.send({ t: "loadProject", project: toEngineSnapshot(project, slots, (id) => library.pathOf(id)) });

  engine.on("ready", (info) => {
    engineState.connected = true;
    engineState.info = info;
    engineState.lastError = null;
    pushProjectToEngine(service.current); // engine (re)starts from the main process' state
    sendToRenderer("engine:state", engineState);
  });
  engine.on("down", () => {
    analyzer.failAll("the audio engine stopped");
    engineState.connected = false;
    sendToRenderer("engine:state", engineState);
  });
  engine.on("error", (message) => {
    engineState.lastError = message;
    sendToRenderer("engine:state", engineState);
  });
  engine.on("exportEvent", (e) => {
    if (e.t === "exportProgress") sendToRenderer("export:status", { state: "running", id: e.id, fraction: e.fraction });
    else if (e.t === "exportDone") sendToRenderer("export:status", { state: "done", id: e.id, path: e.path, seconds: e.seconds, frames: e.frames, peak: e.peak });
    else sendToRenderer("export:status", { state: "error", id: e.id, message: e.message });
  });
  engine.on("sampleInfo", (info) => analyzer.onInfo(info));
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
  ipcMain.handle("export:wav", async (_e, explicitPath?: string) => {
    if (!engineState.connected) return { ok: false, reason: "The audio engine is not running." };
    let target: string | undefined;
    if (explicitPath && process.env.DAW_E2E === "1") target = explicitPath; // test hook: skip the dialog (never enabled in normal use)
    else {
      const picked = await dialog.showSaveDialog(win!, {
        title: "Export WAV",
        defaultPath: path.join(app.getPath("music"), `${service.current.name}.wav`),
        filters: [{ name: "WAV audio", extensions: ["wav"] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      target = picked.filePath;
    }
    const id = randomUUID();
    pushProjectToEngine(service.current); // make sure the engine renders exactly the saved state
    engine.send({ t: "exportWav", id, path: target, tailSeconds: 2 });
    sendToRenderer("export:status", { state: "running", id, fraction: 0, path: target });
    return { ok: true, id };
  });
  ipcMain.handle("library:get", () => ({ status: libraryStatus, ...library.list() }));
  ipcMain.on("library:preview", (_e, id: unknown) => {
    const file = typeof id === "string" ? library.pathOf(id) : null;
    if (file) engine.send({ t: "previewSample", path: file, gain: 0.8 });
  });
  ipcMain.on("library:stopPreview", () => engine.send({ t: "stopPreview" }));
  ipcMain.handle("library:import", async (_e, mode: "zip" | "folder", explicitPath?: string) => {
    if (libraryStatus.state !== "ready") return { ok: false, added: 0, duplicates: 0, failed: [], brandRemoved: null, reason: "The library is still being prepared." };
    if (!engineState.connected) return { ok: false, added: 0, duplicates: 0, failed: [], brandRemoved: null, reason: "The audio engine is not running." };
    let source: string | undefined;
    const hook = process.env.DAW_E2E === "1" ? (explicitPath ?? process.env.DAW_E2E_IMPORT) : undefined;
    if (hook) source = hook; // test hook: skip the dialog (never enabled in normal use)
    else {
      const picked = await dialog.showOpenDialog(win!, {
        title: mode === "zip" ? "Import a sample pack (.zip)" : "Import a folder of samples",
        properties: mode === "zip" ? ["openFile"] : ["openDirectory"],
        filters: mode === "zip" ? [{ name: "Zip archive", extensions: ["zip"] }] : undefined,
      });
      if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true, added: 0, duplicates: 0, failed: [], brandRemoved: null };
      source = picked.filePaths[0]!;
    }
    const result = await library.importPath(source, (p) => sendToRenderer("library:importProgress", p));
    sendToRenderer("library:importProgress", { phase: "done", done: 0, total: 0 }); // whoever started the import, the window stops showing progress
    if (result.ok) sendToRenderer("library:update", library.list());
    return result;
  });
  ipcMain.handle("library:removePack", (_e, name: unknown) => {
    const removed = typeof name === "string" && library.removePack(name);
    if (removed) sendToRenderer("library:update", library.list());
    return removed;
  });
  ipcMain.handle("progress:get", () => progress.get());
  ipcMain.handle("progress:complete", (_e, lessonId: unknown) => {
    const result = progress.completeLesson(lessonId);
    if (result.ok && result.newlyCompleted) publishProgress();
    return result;
  });
  ipcMain.handle("progress:setMode", (_e, mode: unknown) => {
    const result = progress.setMode(mode);
    publishProgress();
    return result;
  });
  ipcMain.handle("progress:reset", () => {
    const result = progress.reset();
    publishProgress();
    return result;
  });
  ipcMain.handle("app:isDev", () => !app.isPackaged || process.env.DAW_E2E === "1");
  ipcMain.on("shell:show", (_e, filePath: string) => shell.showItemInFolder(filePath));
  ipcMain.on("debug:killEngine", () => engine.killForTest());

  engine.start();
  createWindow();

  app.on("before-quit", () => {
    engine.stop();
    service.close();
  });
  app.on("window-all-closed", () => app.quit());
});
