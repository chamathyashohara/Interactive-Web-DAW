import fs from "node:fs";
import path from "node:path";
import { TakeWatcher, type TakeFile } from "./takeWatcher";

interface Settings {
  watchDir?: string;
}

export interface RecordingState {
  /** The folder takes are recorded into and watched (Music\RemoteRecording unless moved). */
  watchDir: string;
  /** Recordings noticed since the DAW started, newest first. */
  takes: TakeFile[];
}

export interface RecordingOptions {
  /** A small JSON file in the user-data folder that remembers the chosen folder. */
  settingsFile: string;
  /** Used until the user picks another folder. */
  defaultWatchDir: string;
  onChange: (state: RecordingState) => void;
}

/**
 * The recordings folder of the remote-recording tab. Takes made by the in-app recorder are written here (see liveRecording.ts); this notices
 * every finished WAV that appears, so a take can be added to the project, wherever it came from.
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

  state(): RecordingState {
    return { watchDir: this.watcher.folder, takes: this.watcher.list() };
  }

  get folder(): string {
    return this.watcher.folder;
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
