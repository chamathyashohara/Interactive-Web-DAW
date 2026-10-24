import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { randomUUID } from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { EngineReady, EngineStatus } from "@daw/engine-protocol";
import type { OpBody, Project } from "@daw/shared";
import { EngineBridge } from "./engine/engineBridge";
import { SlotAllocator, toEngineSnapshot } from "./engine/snapshot";
import { LibraryService } from "./library/libraryService";
import { RecordingService } from "./recording/recordingService";
import { LiveRecordingService, listInterfaces } from "./recording/liveRecording";
import { SampleAnalyzer } from "./library/sampleAnalyzer";
import { LocalStore } from "./project/localStore";
import { ProgressStore } from "./progress/progressStore";
import { ProjectService } from "./project/projectService";
import { Workspace } from "./project/workspace";
import { parseMidi } from "./midi/parseMidi";
import { midiToProject } from "./midi/midiToProject";
import { TelemetryStore } from "./telemetry/telemetryStore";
import { CollabClient, NetStats, isLanHost, parseServerAddress, startSessionServer, type SessionServer, type UserInfo } from "@daw/collab";
import { WebSocket as NodeWebSocket } from "ws";
import { eventsToCsv, metricsToCsv, migrateProject, isVocalTrackName } from "@daw/shared";
import { createHash } from "node:crypto";

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
  // The installed / portable app carries the engine beside it (see `build.extraResources` in apps/desktop/package.json).
  if (app.isPackaged) return path.join(process.resourcesPath, "engine", "daw_engine.exe");
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

// The window records the microphone (remote recording). End-to-end tests use Chromium's built-in fake microphone, so no sound card is needed.
if (process.env.DAW_E2E === "1" && process.env.DAW_FAKE_MIC === "1") {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

app.whenReady().then(() => {
  // Only the microphone (and nothing else) may be asked for, and only by this app's own window.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");
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
  const exportWaiters = new Map<string, (e: { t: string; message?: string; seconds?: number }) => void>();
  engine.on("exportEvent", (e) => {
    if (e.t !== "exportProgress") exportWaiters.get(e.id)?.(e);
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
    if (status.playing) intendedTick = null; // while playing, the engine's own position is the truth
    lastStatus = { ...status, levels };
    sendToRenderer("engine:status", lastStatus);
  });

  // ---- real-time collaboration session (Component 3) ----
  interface CollabState { client: CollabClient; server: SessionServer | null; /** Set when the session lives on a separate (online) server that this app created it on. */ remote: { http: string; hostKey: string } | null; /** Ping, sync delay and traffic measuring for the Network panel. */ net: NetStats | null; /** true when everyone is on one network (the in-app server, or an address like 192.168.x.x), which live recording needs */ lan: boolean; /** Notes this person put in the room, sent again if the connection drops and comes back. */ shares: Map<string, unknown>; hosting: boolean; users: UserInfo[]; project: Project | null; code: string; address: string; }
  let collab: CollabState | null = null;
  const lanIp = () => {
    for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
    return "127.0.0.1";
  };
  const cleanName = (name: unknown) => (typeof name === "string" && name.trim() ? name.trim().slice(0, 24) : os.userInfo().username || "Producer");
  const collabStateMsg = () => (collab ? { active: true, hosting: collab.hosting, status: collab.client.status, code: collab.code, address: collab.address, online: collab.remote !== null, lan: collab.lan, lanIp: lanIp(), users: collab.users, me: collab.client.clientId } : { active: false });
  const publishCollab = () => sendToRenderer("collab:state", collabStateMsg());
  const pushToUi = (project: Project, canUndo: boolean, canRedo: boolean) => {
    pushProjectToEngine(project);
    sendToRenderer("project:update", { project, canUndo, canRedo });
  };
  const wireClient = (client: CollabClient, baseWs: string) => {
    if (collab) collab.net = new NetStats(baseWs, client, NodeWebSocket as unknown as typeof globalThis.WebSocket);
    client.on("change", (project) => {
      if (!collab) return;
      collab.project = project;
      try {
        pushToUi(project, false, false); // option A: no local undo during a session (the session has a shared restore)
      } catch (err) {
        console.error("collab change push failed:", err); // never let a sync update crash the app
      }
    });
    client.on("presence", ({ id, state }) => {
      const p = (state as { pointer?: { x?: unknown; y?: unknown } | null } | null)?.pointer;
      const ok = p && typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y);
      sendToRenderer("collab:pointer", { id, pointer: ok ? { x: Math.min(1, Math.max(0, p.x as number)), y: Math.min(1, Math.max(0, p.y as number)) } : null });
    });
    client.on("share", (note) => sendToRenderer("collab:share", note));
    client.on("status", (status) => {
      // The server drops a person's notes when they disconnect, so put them back after a reconnect.
      if (status === "connected" && collab) for (const [topic, data] of collab.shares) client.share(topic, data);
      publishCollab();
    });
    client.on("users", (users) => { if (collab) collab.users = users; publishCollab(); });
    client.on("dropped", (dropped) => { if (dropped.length) sendToRenderer("collab:note", { kind: "dropped", count: dropped.length }); });
    client.on("ended", ({ reason }) => { void leaveCollab(reason); });
  };
  const leaveCollab = async (reason?: string) => {
    if (!collab) return;
    const c = collab;
    const finalProject = c.project;
    collab = null;
    c.net?.stop();
    c.client.close();
    if (c.server) {
      c.server.endSession(c.code); // tell the others it ended (closes their sockets with the SESSION_ENDED code) before shutting the server
      await new Promise((r) => setTimeout(r, 200)); // let the close frames flush so joiners see "host ended" rather than a dropped link
      await c.server.close();
    }
    if (c.remote) {
      // The session lives on the online server: ask it to end the session for everyone.
      await fetch(`${c.remote.http}/sessions/${c.code}`, { method: "DELETE", headers: { "X-Host-Key": c.remote.hostKey }, signal: AbortSignal.timeout(4000) }).catch(() => {});
    }
    if (c.hosting && finalProject) {
      service.adopt(finalProject); // the host's own project carries the result of the session
    } else {
      // A guest's own open project is never touched: show it again and keep the session as a separate new project.
      pushToUi(service.current, service.canUndo, service.canRedo);
      if (finalProject) {
        const saved = workspace.importProject(`${finalProject.name} (session)`.slice(0, 80), finalProject);
        publishProjects();
        telemetry.record("ui.collab", { action: "saveSessionCopy" });
        sendToRenderer("collab:note", { kind: "saved-copy", name: saved.name });
      }
    }
    publishCollab();
    if (reason === "host-ended") sendToRenderer("collab:note", { kind: "host-ended" });
    if (reason === "cannot-join") sendToRenderer("collab:note", { kind: "cannot-join" });
  };

  service.subscribe((project, meta) => {
    if (collab) return; // during a session the shared project drives the UI and engine
    pushProjectToEngine(project);
    sendToRenderer("project:update", { project, ...meta });
  });

  ipcMain.handle("project:get", () => ({
    project: collab ? (collab.project ?? service.current) : service.current,
    projects: projectList(),
    collab: collabStateMsg(),
    canUndo: service.canUndo,
    canRedo: service.canRedo,
    engine: engineState,
    status: lastStatus,
  }));
  ipcMain.handle("op:dispatch", (_e, body: OpBody, group?: string) => {
    if (collab) {
      const before = collab.project;
      const result = collab.client.dispatch(body);
      if (result.ok && before) telemetry.recordOps(before, [body]);
      return result;
    }
    const before = service.current;
    const result = service.dispatch(body, group);
    if (result.ok) telemetry.recordOps(before, [body]);
    return result;
  });
  ipcMain.handle("op:batch", (_e, bodies: OpBody[], group?: string) => {
    if (collab) {
      const before = collab.project;
      const result = collab.client.dispatchBatch(bodies);
      if (result.ok && before) telemetry.recordOps(before, bodies);
      return result;
    }
    const before = service.current;
    const result = service.dispatchBatch(bodies, group);
    if (result.ok) telemetry.recordOps(before, bodies);
    return result;
  });
  ipcMain.handle("history:undo", () => {
    if (collab) return false; // local undo is off during a session; use the shared restore instead
    const ok = service.undo();
    if (ok) telemetry.record("history", { kind: "undo" });
    return ok;
  });
  ipcMain.handle("history:redo", () => {
    if (collab) return false;
    const ok = service.redo();
    if (ok) telemetry.record("history", { kind: "redo" });
    return ok;
  });
  // With a singer connected (vocal mode) Play also starts the song on the singer's PC at the same planned moment; the engine then starts a moment later.
  ipcMain.on("transport:play", () => { if (!live.syncPlay()) engine.send({ t: "play" }); });
  ipcMain.on("transport:stop", () => { live.syncStop(); liveHost.stop(); });
  ipcMain.on("transport:metronome", (_e, on: boolean) => {
    metronomeOn = !!on;
    engine.send({ t: "setMetronome", on: metronomeOn });
  });
  ipcMain.on("transport:seek", (_e, tick: number) => { liveHost.seek(tick); live.syncSeek(); });
  ipcMain.on("engine:preview", (_e, p: { trackId: string; pitch: number; velocity: number; on: boolean }) => {
    const slot = slots.slotFor(p.trackId);
    if (slot !== undefined) engine.send({ t: "preview", slot, pitch: p.pitch, velocity: p.velocity, on: p.on });
  });
  ipcMain.handle("export:wav", async (_e, explicitPath?: string, options?: { tailSeconds?: number }) => {
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
    const tailSeconds = typeof options?.tailSeconds === "number" ? Math.max(0, Math.min(10, options.tailSeconds)) : 2;
    engine.send({ t: "exportWav", id, path: target, tailSeconds });
    sendToRenderer("export:status", { state: "running", id, fraction: 0, path: target });
    return { ok: true, id };
  });
  // ---- remote recording (Component 4, now inside the DAW): the recordings folder, and the live session service ----
  const recordingsRootDefault = process.env.DAW_RR_WATCH_DIR ?? path.join(app.getPath("music"), "RemoteRecording");
  const recording = new RecordingService({
    settingsFile: path.join(app.getPath("userData"), "recording.json"),
    defaultWatchDir: recordingsRootDefault,
    onChange: (s) => sendToRenderer("recording:state", s),
  });
  recording.start();
  // What the remote-recording service needs from the project and the transport. The backing track is the arrangement without the recorded
  // "Vocal take" tracks (the singer must not hear earlier takes unless the producer unmutes... they are never part of it).
  const activeProject = () => (collab ? (collab.project ?? service.current) : service.current);
  const withoutVocals = (p: Project): Project => {
    if (!Object.values(p.tracks).some((t) => isVocalTrackName(t.name))) return p;
    const tracks = Object.fromEntries(Object.entries(p.tracks).filter(([, t]) => !isVocalTrackName(t.name)));
    return { ...p, tracks, trackOrder: p.trackOrder.filter((id) => tracks[id]) };
  };
  // Where the producer last put the playhead. While nothing plays this is what Record starts from, so a take lands where it was asked for
  // even if the audio engine is slow to report a position it was just told to go to (it is the producer's intention, not a measurement).
  let intendedTick: number | null = null;
  const liveHost = {
    engineReady: () => engineState.connected,
    fingerprint: () => {
      const snap = toEngineSnapshot(withoutVocals(activeProject()), slots, (id) => library.pathOf(id));
      return createHash("sha1").update(JSON.stringify(snap)).digest("hex");
    },
    tick: () => (lastStatus?.playing ? lastStatus.tick : (intendedTick ?? lastStatus?.tick ?? 0)),
    playing: () => lastStatus?.playing ?? false,
    tempo: () => activeProject().tempo,
    play: () => engine.send({ t: "play" }),
    stop: () => { intendedTick = 0; engine.send({ t: "stop" }); },
    seek: (tick: number) => { intendedTick = tick; engine.send({ t: "seek", tick }); },
    renderBacking: async () => {
      if (!engineState.connected) return { ok: false as const, reason: "the audio engine is not running" };
      const project = activeProject();
      const stripped = withoutVocals(project);
      const id = randomUUID();
      const target = path.join(app.getPath("temp"), `daw-backing-${id}.wav`);
      const done = new Promise<{ t: string; message?: string; seconds?: number }>((resolve) => {
        exportWaiters.set(id, resolve);
        setTimeout(() => resolve({ t: "exportError", message: "the render took too long" }), 10 * 60_000);
      });
      try {
        if (stripped !== project) engine.send({ t: "loadProject", project: toEngineSnapshot(stripped, slots, (sid) => library.pathOf(sid)) });
        else pushProjectToEngine(project);
        engine.send({ t: "exportWav", id, path: target, tailSeconds: 0 });
        const e = await done;
        if (e.t !== "exportDone") return { ok: false as const, reason: e.message ?? "the export failed" };
        return { ok: true as const, file: target, seconds: e.seconds ?? 0 };
      } finally {
        exportWaiters.delete(id);
        if (stripped !== project) pushProjectToEngine(activeProject()); // the engine goes back to the real arrangement
      }
    },
  };
  const live = new LiveRecordingService({
    host: liveHost,
    backingDir: path.join(app.getPath("userData"), "backing"),
    recordingsRoot: recording.folder,
    logFile: path.join(app.getPath("userData"), "recording-logs", `live-${new Date().toISOString().slice(0, 10)}.jsonl`),
    appVersion: app.getVersion(),
    onState: (s) => sendToRenderer("live:state", s),
    toRenderer: sendToRenderer,
  });
  live.start();
  ipcMain.handle("recording:state", () => recording.state());
  ipcMain.handle("recording:chooseFolder", async (_e, explicitPath?: unknown) => {
    let dir = typeof explicitPath === "string" && process.env.DAW_E2E === "1" ? explicitPath : undefined;
    if (!dir) {
      const picked = await dialog.showOpenDialog(win!, { title: "Folder where recordings are saved", properties: ["openDirectory"], defaultPath: recording.state().watchDir });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
      dir = picked.filePaths[0];
    }
    recording.setWatchDir(dir);
    live.setRecordingsRoot(dir);
    return { ok: true };
  });
  ipcMain.handle("recording:openFolder", async () => {
    const dir = recording.state().watchDir;
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return err ? { ok: false, reason: err } : { ok: true };
  });
  ipcMain.handle("recording:pollNow", () => (process.env.DAW_E2E === "1" ? (recording.pollNow(), true) : false));
  // Copies one recording into the sound library and returns its entry; the window then places it on a new track.
  ipcMain.handle("recording:addTake", async (_e, file?: unknown) => {
    if (libraryStatus.state !== "ready") return { ok: false, reason: "The sound library is still being prepared." };
    if (!engineState.connected) return { ok: false, reason: "The audio engine is not running." };
    let source = typeof file === "string" ? file : undefined;
    if (!source) {
      const picked = await dialog.showOpenDialog(win!, { title: "Add a recording", properties: ["openFile"], defaultPath: recording.state().watchDir, filters: [{ name: "Audio", extensions: ["wav", "aiff", "aif", "flac", "ogg"] }] });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
      source = picked.filePaths[0];
    }
    const result = await library.importFile(source, (p) => sendToRenderer("library:importProgress", p));
    sendToRenderer("library:importProgress", { phase: "done", done: 0, total: 0 });
    if (!result.ok) return result;
    sendToRenderer("library:update", library.list());
    recording.dismiss(source);
    telemetry.record("ui.recording", { action: "addTake" });
    return result;
  });
  // ---- live session: control from the window ----
  const text = (v: unknown, max = 80): string => (typeof v === "string" ? v.slice(0, max) : "");
  const num = (v: unknown, min: number, max: number, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback);
  ipcMain.handle("live:state", () => live.state());
  ipcMain.handle("live:interfaces", () => listInterfaces());
  ipcMain.handle("live:create", async (_e, o: { bind?: unknown; port?: unknown; name?: unknown; mode?: unknown }) => {
    telemetry.record("ui.recording", { action: "create-session" });
    return live.createSession({ bind: text(o?.bind, 45), port: num(o?.port, 1024, 65531, 52000), name: text(o?.name, 40), mode: o?.mode === "vocal" ? "vocal" : "both" });
  });
  ipcMain.handle("live:syncPlay", (_e, on: unknown) => (live.setSyncPlay(on === true), { ok: true }));
  ipcMain.handle("live:backingReady", (_e, id: unknown) => (typeof id === "string" && live.backingReady(id), { ok: true }));
  ipcMain.handle("live:backingFailed", (_e, id: unknown, why: unknown) => (typeof id === "string" && live.backingFailed(id, text(why, 200)), { ok: true }));
  ipcMain.handle("live:readBacking", (_e, file: unknown) => (typeof file === "string" ? live.readBacking(file) : null));
  ipcMain.on("live:latency", (_e, us: unknown) => { if (typeof us === "number" && Number.isFinite(us)) live.setLatencyUs(Math.min(2_000_000, Math.max(0, us))); });
  ipcMain.handle("live:join", async (_e, o: { host?: unknown; port?: unknown; code?: unknown; name?: unknown }) => {
    telemetry.record("ui.recording", { action: "join-session" });
    return live.join({ host: text(o?.host, 45), port: num(o?.port, 1, 65535, 52000), code: text(o?.code, 6), name: text(o?.name, 40) });
  });
  ipcMain.handle("live:leave", async () => { await live.leave(); return { ok: true }; });
  ipcMain.handle("live:consent", (_e, on: unknown) => (live.setConsent(on === true), { ok: true }));
  ipcMain.handle("live:deliveryConsent", (_e, on: unknown) => (live.setDeliveryConsent(on === true), { ok: true }));
  ipcMain.handle("live:record", () => { const r = live.record(); telemetry.record("ui.recording", { action: r ? "record-refused" : "record" }); return r ? { ok: false, reason: r } : { ok: true }; });
  ipcMain.handle("live:stop", () => { const r = live.stop(); return r ? { ok: false, reason: r } : { ok: true }; });
  ipcMain.handle("live:newCode", () => ({ ok: true, code: live.newCode() }));
  ipcMain.handle("live:lead", (_e, ms: unknown, auto: unknown) => (live.setLead(num(ms, 300, 10000, 1000), auto !== false), { ok: true }));
  ipcMain.handle("live:autoTransfer", (_e, on: unknown) => (live.setAutoTransfer(on === true), { ok: true }));
  ipcMain.handle("live:transfer", async (_e, take: unknown) => { const r = await live.requestTransfer(num(take, 1, 999, 0)); return r ? { ok: false, reason: r } : { ok: true }; });
  ipcMain.handle("live:cancelTransfer", (_e, take: unknown) => (live.cancelTransfer(num(take, 1, 999, 0)), { ok: true }));
  ipcMain.handle("live:talkback", (_e, send: unknown, hear: unknown) => (live.setTalkback(send === true, hear === true), { ok: true }));
  // ---- live session: audio from the window (high rate, no reply) ----
  ipcMain.on("live:captureState", (_e, s: { open?: unknown; deviceName?: unknown; sampleRate?: unknown; channels?: unknown; failed?: unknown }) =>
    live.captureState({ open: s?.open === true, deviceName: text(s?.deviceName, 120), sampleRate: num(s?.sampleRate, 8000, 192000, 48000), channels: num(s?.channels, 1, 2, 1), failed: text(s?.failed, 200) }));
  ipcMain.on("live:capture", (_e, frame: unknown, samples: unknown) => {
    if (typeof frame === "number" && samples instanceof Float32Array) live.capture(frame, samples);
  });
  ipcMain.on("live:send", (_e, opus: unknown, mediaIndex: unknown, muted: unknown) => {
    if (opus instanceof Uint8Array && typeof mediaIndex === "number") live.liveSend(opus, mediaIndex, muted === true);
  });
  ipcMain.on("live:incomingStats", (_e, r: Record<string, unknown>) => {
    const n = (k: string) => (typeof r?.[k] === "number" ? (r[k] as number) : 0);
    live.liveIncomingStats({ received: n("received"), lostEstimate: n("lostEstimate"), late: n("late"), duplicates: n("duplicates"), reordered: n("reordered"), jitterUs: n("jitterUs"), jbFill: n("jbFill"), jbTarget: n("jbTarget"), underruns: n("underruns"), concealed: n("concealed"), decodeErrors: n("decodeErrors") });
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
    liveHost.stop();
    telemetry.record("ui.project", { action: "new" });
    publishProjects();
    return { ok: true, id: meta.id };
  });
  ipcMain.handle("project:open", (_e, id: unknown) => {
    if (typeof id !== "string" || !workspace.exists(id)) return { ok: false, reason: "unknown project" };
    service.load(workspace.storeFor(id));
    activeProjectId = id;
    workspace.touch(id);
    liveHost.stop();
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
    if (id === activeProjectId) {
      // Switch to another project first so this one's journal file is closed before its folder is removed.
      const other = workspace.list().find((p) => p.id !== id);
      const nextId = other ? other.id : workspace.create("My first project").id;
      service.load(workspace.storeFor(nextId));
      activeProjectId = nextId;
      workspace.touch(nextId);
      liveHost.stop();
    }
    workspace.delete(id);
    publishProjects();
    return { ok: true };
  });
  // ---- project files (Save / Save as / Open to a real file the user picks) ----
  const PROJECT_EXT = "daw";
  const writeProjectFile = (filePath: string, project: Project) => fs.writeFileSync(filePath, JSON.stringify({ format: "collab-daw-project", version: 1, project }, null, 2));
  const doSave = async (forceDialog: boolean, explicitPath?: string) => {
    const linked = workspace.meta(activeProjectId)?.filePath;
    let target = explicitPath && process.env.DAW_E2E === "1" ? explicitPath : forceDialog ? undefined : linked;
    if (!target) {
      const picked = await dialog.showSaveDialog(win!, {
        title: forceDialog ? "Save project as" : "Save project",
        defaultPath: path.join(app.getPath("documents"), `${service.current.name}.${PROJECT_EXT}`),
        filters: [{ name: "DAW project", extensions: [PROJECT_EXT] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      target = picked.filePath;
    }
    try {
      writeProjectFile(target, service.current);
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
    const base = path.basename(target, path.extname(target));
    if (workspace.exists(activeProjectId)) {
      workspace.setFilePath(activeProjectId, target);
      workspace.renameIndexOnly(activeProjectId, base);
    }
    service.setName(base); // the project takes the file's name
    telemetry.record("ui.project", { action: forceDialog ? "saveAs" : "save" });
    publishProjects();
    return { ok: true, path: target };
  };
  ipcMain.handle("project:saveFile", (_e, explicitPath?: unknown) => doSave(false, typeof explicitPath === "string" ? explicitPath : undefined));
  ipcMain.handle("project:saveFileAs", (_e, explicitPath?: unknown) => doSave(true, typeof explicitPath === "string" ? explicitPath : undefined));
  ipcMain.handle("project:openFile", async (_e, explicitPath?: unknown) => {
    let filePath = typeof explicitPath === "string" && process.env.DAW_E2E === "1" ? explicitPath : undefined;
    if (!filePath) {
      const picked = await dialog.showOpenDialog(win!, {
        title: "Open project",
        properties: ["openFile"],
        filters: [{ name: "DAW project", extensions: [PROJECT_EXT] }, { name: "All files", extensions: ["*"] }],
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
      filePath = picked.filePaths[0];
    }
    let project: Project;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { project?: Project } & Partial<Project>;
      const body = (raw.project ?? raw) as Project;
      if (!body || typeof body !== "object" || typeof body.tracks !== "object") throw new Error("not a project file");
      project = migrateProject(body);
    } catch {
      return { ok: false, reason: "That file is not a valid project." };
    }
    const name = path.basename(filePath, path.extname(filePath));
    const meta = workspace.importProject(name, project, filePath);
    service.load(workspace.storeFor(meta.id));
    activeProjectId = meta.id;
    workspace.touch(meta.id);
    liveHost.stop();
    telemetry.record("ui.project", { action: "openFile" });
    publishProjects();
    return { ok: true, id: meta.id };
  });
  ipcMain.handle("project:importMidi", async (_e, explicitPath?: unknown) => {
    let filePath = typeof explicitPath === "string" && process.env.DAW_E2E === "1" ? explicitPath : undefined;
    if (!filePath) {
      const picked = await dialog.showOpenDialog(win!, {
        title: "Import MIDI",
        properties: ["openFile"],
        filters: [{ name: "MIDI file", extensions: ["mid", "midi"] }],
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
      filePath = picked.filePaths[0];
    }
    let project: Project;
    let trackCount = 0;
    try {
      const parsed = parseMidi(new Uint8Array(fs.readFileSync(filePath)));
      const base = path.basename(filePath, path.extname(filePath));
      project = midiToProject(parsed, randomUUID(), base);
      trackCount = project.trackOrder.length;
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "That MIDI file could not be read." };
    }
    const name = path.basename(filePath, path.extname(filePath));
    const meta = workspace.importProject(name, project);
    service.load(workspace.storeFor(meta.id));
    activeProjectId = meta.id;
    workspace.touch(meta.id);
    liveHost.stop();
    telemetry.record("ui.project", { action: "importMidi", tracks: trackCount });
    publishProjects();
    return { ok: true, id: meta.id, tracks: trackCount };
  });
  // ---- collaboration: host / join / leave ----
  ipcMain.handle("collab:state", () => collabStateMsg());
  ipcMain.handle("collab:host", async (_e, name?: unknown, online?: unknown) => {
    if (collab) return { ok: false, reason: "already in a session" };
    // "Different network": the session is created on a separate server (reached by address, optionally with an access token).
    if (online && typeof online === "object") {
      const { server: serverInput, token } = online as { server?: unknown; token?: unknown };
      if (typeof serverInput !== "string" || !serverInput.trim()) return { ok: false, reason: "enter the server address" };
      const addr = parseServerAddress(serverInput);
      try {
        const res = await fetch(`${addr.http}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(typeof token === "string" && token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}) },
          body: JSON.stringify({ project: service.current }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401) return { ok: false, reason: "wrong access token" };
        if (!res.ok) return { ok: false, reason: `the server replied ${res.status}` };
        const { code, hostKey } = (await res.json()) as { code: string; hostKey: string };
        const client = new CollabClient({ baseUrl: addr.ws, code, name: cleanName(name), color: "#22d3ee", WebSocketImpl: NodeWebSocket as unknown as typeof globalThis.WebSocket });
        collab = { client, server: null, remote: { http: addr.http, hostKey }, net: null, lan: isLanHost(addr.ws), shares: new Map(), hosting: true, users: [], project: null, code, address: addr.http };
        wireClient(client, addr.ws);
        client.connect();
        telemetry.record("ui.collab", { action: "hostOnline" });
        publishCollab();
        return { ok: true, code, address: addr.http };
      } catch (err) {
        return { ok: false, reason: err instanceof TypeError || (err as Error)?.name === "TimeoutError" ? `cannot reach ${addr.http}. Is the server running, and is the address right?` : String(err) };
      }
    }
    try {
      const server = await startSessionServer(0);
      const code = server.createSession(service.current);
      const client = new CollabClient({ baseUrl: `ws://127.0.0.1:${server.port}`, code, name: cleanName(name), color: "#22d3ee", WebSocketImpl: NodeWebSocket as unknown as typeof globalThis.WebSocket });
      collab = { client, server, remote: null, net: null, lan: true, shares: new Map(), hosting: true, users: [], project: null, code, address: `${lanIp()}:${server.port}` };
      wireClient(client, `ws://127.0.0.1:${server.port}`);
      client.connect();
      telemetry.record("ui.collab", { action: "host" });
      publishCollab();
      return { ok: true, code, address: collab.address };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  });
  ipcMain.handle("collab:join", (_e, address: unknown, code: unknown, name?: unknown) => {
    if (collab) return { ok: false, reason: "already in a session" };
    if (typeof address !== "string" || !address.trim() || typeof code !== "string" || !/\d{6}/.test(code)) return { ok: false, reason: "enter the host address and the 6-digit code" };
    const baseUrl = parseServerAddress(address).ws; // accepts 192.168.1.5, 192.168.1.5:5000, https://abc.trycloudflare.com ...
    const client = new CollabClient({ baseUrl, code, name: cleanName(name), color: "#f472b6", WebSocketImpl: NodeWebSocket as unknown as typeof globalThis.WebSocket });
    collab = { client, server: null, remote: null, net: null, lan: isLanHost(baseUrl), shares: new Map(), hosting: false, users: [], project: null, code, address: address.trim() };
    wireClient(client, baseUrl);
    client.connect();
    telemetry.record("ui.collab", { action: "join" });
    publishCollab();
    return { ok: true };
  });
  ipcMain.on("collab:pointer", (_e, p: unknown) => {
    if (!collab || collab.client.status !== "connected") return;
    const q = p as { x?: unknown; y?: unknown } | null;
    collab.client.setPresence(q && typeof q.x === "number" && typeof q.y === "number" ? { pointer: { x: q.x, y: q.y } } : { pointer: null });
  });
  // A small note for the whole room (used by Live recording to hand the Producer's address and pairing code to the Singers).
  ipcMain.handle("collab:share", (_e, topic: unknown, data: unknown) => {
    if (!collab || typeof topic !== "string") return { ok: false };
    if (data === null || data === undefined) collab.shares.delete(topic);
    else collab.shares.set(topic, data);
    collab.client.share(topic, data ?? null);
    sendToRenderer("collab:share", { id: collab.client.clientId, topic, data: data ?? null }); // the server does not echo a note to its sender
    return { ok: true };
  });
  ipcMain.handle("collab:net", () => collab?.net?.snapshot() ?? null);
  ipcMain.handle("collab:netExport", async (_e, explicitPath?: unknown) => {
    if (!collab?.net) return { ok: false, reason: "not in a session" };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    let target = typeof explicitPath === "string" && process.env.DAW_E2E === "1" ? explicitPath : undefined;
    if (!target) {
      const picked = await dialog.showSaveDialog(win!, { title: "Export network measurements", defaultPath: `network-${collab.code}-${stamp}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      target = picked.filePath;
    }
    try {
      fs.writeFileSync(target, collab.net.toCsv());
      return { ok: true, file: target };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  });
  ipcMain.handle("collab:leave", async () => {
    await leaveCollab();
    telemetry.record("ui.collab", { action: "leave" });
    return { ok: true };
  });
  ipcMain.handle("app:isDev", () => !app.isPackaged || process.env.DAW_E2E === "1");
  ipcMain.on("shell:show", (_e, filePath: string) => shell.showItemInFolder(filePath));
  ipcMain.on("debug:killEngine", () => engine.killForTest());

  engine.start();
  createWindow();

  app.on("before-quit", () => {
    recording.stop();
    void live.shutdown();
    if (collab) { collab.client.close(); void collab.server?.close(); }
    telemetry.recordSummary(service.current);
    engine.stop();
    service.close();
  });
  app.on("window-all-closed", () => app.quit());
});
