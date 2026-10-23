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
import { Workspace } from "./project/workspace";
import { TelemetryStore } from "./telemetry/telemetryStore";
import { eventsToCsv, metricsToCsv } from "@daw/shared";

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
  // Projects live under <userData>/projects, each in its own folder, managed by the Workspace.
  const workspace = new Workspace(process.env.DAW_PROJECTS_DIR ?? path.join(app.getPath("userData"), "projects"));
  let activeProjectId: string;
  let service: ProjectService;
  if (process.env.DAW_DATA_DIR) {
    // A fixed single-project directory (end-to-end tests, or an explicit override): unchanged behaviour.
    fs.mkdirSync(process.env.DAW_DATA_DIR, { recursive: true });
    service = new ProjectService(new LocalStore(process.env.DAW_DATA_DIR));
    activeProjectId = path.basename(process.env.DAW_DATA_DIR);
  } else {
    const first = workspace.ensureAtLeastOne();
    service = new ProjectService(workspace.storeFor(first.id));
    activeProjectId = first.id;
    workspace.touch(first.id);
  }
  // The project list for the UI; the active project is always present even when it is a fixed dir outside the workspace (tests).
  const projectList = () => {
    const projects = workspace.list();
    if (!projects.some((p) => p.id === activeProjectId)) projects.unshift({ id: activeProjectId, name: service.current.name, createdAt: 0, modifiedAt: 0 });
    return { projects, activeId: activeProjectId };
  };
  const publishProjects = () => sendToRenderer("project:list", projectList());

  // Learner progress (which lessons are done, whether features are gated). Per user, never part of a project.
  const progressDir = process.env.DAW_PROGRESS_DIR ?? app.getPath("userData");
  const progress = new ProgressStore(progressDir, process.env.DAW_PROGRESS_MODE === "beginner" ? "beginner" : "all");
  const publishProgress = () => sendToRenderer("progress:update", progress.get());
  // Evaluation data: records nothing until the participant has agreed (see telemetry/telemetryStore.ts). Beside the progress files, never in a project.
  const telemetry = new TelemetryStore(process.env.DAW_TELEMETRY_DIR ?? progressDir, () => progress.get().mode);
  const publishTelemetry = () => sendToRenderer("telemetry:update", telemetry.state());

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

  let metronomeOn = false; // a UI setting, not part of the project: kept here so a restarted engine gets it back
  engine.on("ready", (info) => {
    engineState.connected = true;
    engineState.info = info;
    engineState.lastError = null;
    pushProjectToEngine(service.current); // engine (re)starts from the main process' state
    engine.send({ t: "setMetronome", on: metronomeOn });
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
    projects: projectList(),
    canUndo: service.canUndo,
    canRedo: service.canRedo,
    engine: engineState,
    status: lastStatus,
  }));
  ipcMain.handle("op:dispatch", (_e, body: OpBody, group?: string) => {
    const before = service.current;
    const result = service.dispatch(body, group);
    if (result.ok) telemetry.recordOps(before, [body]);
    return result;
  });
  ipcMain.handle("op:batch", (_e, bodies: OpBody[], group?: string) => {
    const before = service.current;
    const result = service.dispatchBatch(bodies, group);
    if (result.ok) telemetry.recordOps(before, bodies);
    return result;
  });
  ipcMain.handle("history:undo", () => {
    const ok = service.undo();
    if (ok) telemetry.record("history", { kind: "undo" });
    return ok;
  });
  ipcMain.handle("history:redo", () => {
    const ok = service.redo();
    if (ok) telemetry.record("history", { kind: "redo" });
    return ok;
  });
  ipcMain.on("transport:play", () => engine.send({ t: "play" }));
  ipcMain.on("transport:stop", () => engine.send({ t: "stop" }));
  ipcMain.on("transport:metronome", (_e, on: boolean) => {
    metronomeOn = !!on;
    engine.send({ t: "setMetronome", on: metronomeOn });
  });
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
  // ---- evaluation data (research) ----
  ipcMain.handle("telemetry:state", () => telemetry.state());
  ipcMain.handle("telemetry:consent", (_e, code: unknown) => {
    const result = telemetry.consent(code);
    publishTelemetry();
    return result;
  });
  ipcMain.handle("telemetry:withdraw", (_e, deleteData: unknown) => {
    const state = telemetry.withdraw(deleteData === true);
    publishTelemetry();
    return state;
  });
  // Only interface events from the window ("ui.*"); edits and history are recorded here, from what was actually applied.
  ipcMain.on("telemetry:event", (_e, name: unknown, data: unknown) => {
    if (name === "ui.fix") telemetry.expectFix();
    if (typeof name === "string" && name.startsWith("ui.") && data && typeof data === "object") telemetry.record(name, data as Record<string, string | number | boolean | null>);
  });
  ipcMain.handle("telemetry:export", async (_e, kind: unknown, explicitPath?: string) => {
    telemetry.recordSummary(service.current);
    const bundle = telemetry.buildExport(path.join(progressDir, "progress-events.ndjson"));
    if (!bundle) return { ok: false, reason: "Recording has not been started." };
    const csv = kind === "csv";
    let target: string | undefined;
    if (explicitPath && process.env.DAW_E2E === "1") target = explicitPath; // test hook: skip the dialog (never enabled in normal use)
    else {
      const picked = await dialog.showSaveDialog(win!, {
        title: csv ? "Export study data (CSV)" : "Export study data (JSON)",
        defaultPath: `daw-study-${bundle.participant}-${new Date().toISOString().slice(0, 10)}.${csv ? "csv" : "json"}`,
        filters: csv ? [{ name: "CSV", extensions: ["csv"] }] : [{ name: "JSON", extensions: ["json"] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      target = picked.filePath;
    }
    try {
      if (csv) {
        const base = target.replace(/\.csv$/i, "");
        fs.writeFileSync(`${base}-events.csv`, eventsToCsv(bundle.events));
        fs.writeFileSync(`${base}-metrics.csv`, metricsToCsv(bundle.metrics));
        return { ok: true, files: [`${base}-events.csv`, `${base}-metrics.csv`] };
      }
      fs.writeFileSync(target, JSON.stringify(bundle, null, 2));
      return { ok: true, files: [target] };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  });
  // ---- projects (new / open / save as / rename / delete) ----
  ipcMain.handle("project:list", () => projectList());
  ipcMain.handle("project:new", (_e, name?: unknown) => {
    const meta = workspace.create(typeof name === "string" ? name : undefined);
    service.load(workspace.storeFor(meta.id));
    activeProjectId = meta.id;
    workspace.touch(meta.id);
    engine.send({ t: "stop" });
    telemetry.record("ui.project", { action: "new" });
    publishProjects();
    return { ok: true, id: meta.id };
  });
  ipcMain.handle("project:open", (_e, id: unknown) => {
    if (typeof id !== "string" || !workspace.exists(id)) return { ok: false, reason: "unknown project" };
    service.load(workspace.storeFor(id));
    activeProjectId = id;
    workspace.touch(id);
    engine.send({ t: "stop" });
    telemetry.record("ui.project", { action: "open" });
    publishProjects();
    return { ok: true };
  });
  ipcMain.handle("project:saveAs", (_e, name?: unknown) => {
    if (!workspace.exists(activeProjectId)) return { ok: false, reason: "the current project cannot be copied here" };
    service.flush(); // make sure the copy includes the latest edits
    const meta = workspace.duplicate(activeProjectId, typeof name === "string" ? name : undefined);
    service.load(workspace.storeFor(meta.id));
    activeProjectId = meta.id;
    workspace.touch(meta.id);
    telemetry.record("ui.project", { action: "saveAs" });
    publishProjects();
    return { ok: true, id: meta.id };
  });
  ipcMain.handle("project:rename", (_e, id: unknown, name: unknown) => {
    if (typeof id !== "string" || typeof name !== "string") return { ok: false, reason: "bad arguments" };
    if (!workspace.exists(id)) {
      if (id === activeProjectId) service.setName(name.slice(0, 80).trim() || service.current.name);
    } else if (id === activeProjectId) {
      service.setName(name.slice(0, 80).trim() || service.current.name);
      workspace.renameIndexOnly(id, name);
    } else {
      workspace.rename(id, name);
    }
    publishProjects();
    return { ok: true };
  });
  ipcMain.handle("project:delete", (_e, id: unknown) => {
    if (typeof id !== "string") return { ok: false, reason: "bad arguments" };
    workspace.delete(id);
    if (id === activeProjectId) {
      const next = workspace.ensureAtLeastOne();
      service.load(workspace.storeFor(next.id));
      activeProjectId = next.id;
      workspace.touch(next.id);
      engine.send({ t: "stop" });
    }
    publishProjects();
    return { ok: true };
  });
  ipcMain.handle("app:isDev", () => !app.isPackaged || process.env.DAW_E2E === "1");
  ipcMain.on("shell:show", (_e, filePath: string) => shell.showItemInFolder(filePath));
  ipcMain.on("debug:killEngine", () => engine.killForTest());

  engine.start();
  createWindow();

  app.on("before-quit", () => {
    telemetry.recordSummary(service.current);
    engine.stop();
    service.close();
  });
  app.on("window-all-closed", () => app.quit());
});
