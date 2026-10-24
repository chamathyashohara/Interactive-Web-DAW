import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EXE_NAME, findRecorderApp, type RecorderRole } from "./recorderApps";
import { TakeWatcher, type TakeFile } from "./takeWatcher";

interface Settings {
  producerExe?: string;
  performerExe?: string;
  watchDir?: string;
}

export interface RecordingState {
  apps: Record<RecorderRole, { found: boolean; path: string | null }>;
  /** The folder watched for new recordings (where the recorder programs save takes). */
  watchDir: string;
  /** Recordings noticed since the DAW started, newest first. */
  takes: TakeFile[];
}

export interface RecordingOptions {
  /** A small JSON file in the user-data folder that remembers the chosen program paths and folder. */
  settingsFile: string;
  /** Used until the user picks another folder (Music\RemoteRecording, the recorder programs' own default). */
  defaultWatchDir: string;
  /** Where to look for the programs when none was chosen. */
  searchRoots: string[];
  /** Overrides (DAW_RR_PRODUCER / DAW_RR_PERFORMER). */
  env?: Partial<Record<RecorderRole, string>>;
  onChange: (state: RecordingState) => void;
}

/**
 * The "Live recording" tab's side in the main process. Component 4 stays two separate programs (Producer Studio and
 * Performer Client); this starts the right one for the role the user picked and notices the recordings they save, so a take can be added to the project.
 */
export class RecordingService {
  private settings: Settings;
  private watcher: TakeWatcher;

  constructor(private opts: RecordingOptions) {
    this.settings = this.readSettings();
    this.watcher = new TakeWatcher(this.settings.watchDir ?? opts.defaultWatchDir, () => opts.onChange(this.state()));
  }

  start() {
    this.watcher.start();
  }

  stop() {
    this.watcher.stop();
  }

  private readSettings(): Settings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.settingsFile, "utf8")) as Settings;
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  private saveSettings() {
    try {
      fs.mkdirSync(path.dirname(this.opts.settingsFile), { recursive: true });
      fs.writeFileSync(this.opts.settingsFile, JSON.stringify(this.settings, null, 2));
    } catch {
      /* not being able to remember a choice must never stop recording */
    }
  }

  private exePath(role: RecorderRole): string | null {
    return findRecorderApp(role, { env: this.opts.env?.[role], saved: role === "producer" ? this.settings.producerExe : this.settings.performerExe, roots: this.opts.searchRoots });
  }

  state(): RecordingState {
    const app = (role: RecorderRole) => {
      const p = this.exePath(role);
      return { found: p !== null, path: p };
    };
    return { apps: { producer: app("producer"), performer: app("performer") }, watchDir: this.watcher.folder, takes: this.watcher.list() };
  }

  /** Starts Producer Studio or Performer Client as its own window. */
  launch(role: RecorderRole): Promise<{ ok: boolean; reason?: string }> {
    const exe = this.exePath(role);
    if (!exe) {
      return Promise.resolve({
        ok: false,
        reason: `${EXE_NAME[role]} was not found. Build the remote recording component (components/remote-recording/docs/build/WINDOWS_BUILD.md), or use "Locate…" to point to it.`,
      });
    }
    return new Promise((resolve) => {
      const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: "ignore" });
      child.once("error", (err) => resolve({ ok: false, reason: `Could not start ${EXE_NAME[role]}: ${err.message}` }));
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    });
  }

  /** Remembers where a program is (when the user picked it by hand). */
  locate(role: RecorderRole, file: string) {
    if (role === "producer") this.settings.producerExe = file;
    else this.settings.performerExe = file;
    this.saveSettings();
    this.opts.onChange(this.state());
  }

  setWatchDir(dir: string) {
    this.settings.watchDir = dir;
    this.saveSettings();
    this.watcher.setFolder(dir);
  }

  dismiss(file: string) {
    this.watcher.dismiss(file);
  }

  /** Test hook: check the folder now instead of waiting for the timer. */
  pollNow() {
    this.watcher.poll();
  }
}
