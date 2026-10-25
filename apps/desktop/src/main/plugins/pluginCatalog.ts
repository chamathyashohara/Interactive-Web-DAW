import fs from "node:fs";
import path from "node:path";
import { defaultPluginFolders, pluginFormatOf, prettyName, scanPlugins, type PluginEntry } from "./pluginScan";

export interface PluginList {
  entries: PluginEntry[];
  /** The folders searched: the standard ones plus any the user added. */
  folders: string[];
  /** Folders the user added (can be removed). */
  userFolders: string[];
}

/**
 * The plugins the user can pick from: everything found in the standard plugin folders plus any folders they added, and single plugin
 * files they chose by hand (so a plugin installed anywhere works). The extra folders and files are remembered in one small JSON file.
 * No Electron imports, so it is unit-testable in plain Node.
 */
export class PluginCatalog {
  private userFolders: string[] = [];
  private userFiles: string[] = [];

  constructor(
    private readonly file: string,
    private readonly standardFolders: string[] = defaultPluginFolders(),
  ) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { folders?: unknown; files?: unknown };
      if (Array.isArray(raw.folders)) this.userFolders = raw.folders.filter((f): f is string => typeof f === "string");
      if (Array.isArray(raw.files)) this.userFiles = raw.files.filter((f): f is string => typeof f === "string");
    } catch {
      /* first run: nothing saved yet */
    }
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ folders: this.userFolders, files: this.userFiles }, null, 2));
    } catch {
      /* the list just will not be remembered */
    }
  }

  list(): PluginList {
    const folders = [...new Set([...this.standardFolders, ...this.userFolders])];
    const byId = new Map<string, PluginEntry>();
    for (const e of scanPlugins(folders)) byId.set(e.id, e);
    for (const file of this.userFiles) {
      const entry = this.entryForFile(file);
      if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
    }
    return { entries: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)), folders, userFolders: [...this.userFolders] };
  }

  private entryForFile(file: string): PluginEntry | null {
    const format = pluginFormatOf(path.basename(file));
    if (!format) return null;
    try {
      const st = fs.statSync(file);
      return { id: file, name: prettyName(path.basename(file)), folder: path.dirname(file), bundle: st.isDirectory(), format };
    } catch {
      return null; // the file is gone
    }
  }

  /** Adds a folder to search (a folder that does not exist is refused). */
  addFolder(folder: string): boolean {
    try {
      if (!fs.statSync(folder).isDirectory()) return false;
    } catch {
      return false;
    }
    if (!this.userFolders.includes(folder) && !this.standardFolders.includes(folder)) {
      this.userFolders.push(folder);
      this.save();
    }
    return true;
  }

  removeFolder(folder: string) {
    this.userFolders = this.userFolders.filter((f) => f !== folder);
    this.save();
  }

  /** Remembers a single plugin file the user chose by hand and returns its entry (null if it is not a plugin file). */
  addFile(file: string): PluginEntry | null {
    const entry = this.entryForFile(file);
    if (!entry) return null;
    if (!this.userFiles.includes(file)) {
      this.userFiles.push(file);
      this.save();
    }
    return entry;
  }
}
