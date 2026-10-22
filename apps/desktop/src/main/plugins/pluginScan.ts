import fs from "node:fs";
import path from "node:path";

export interface PluginEntry {
  /** Stable id: the absolute path to the .vst3 (what the engine will be told to load). */
  id: string;
  /** Display name, e.g. "Sylenth1" (the bundle name without its extension). */
  name: string;
  /** Where it was found, for grouping in the UI. */
  folder: string;
  /** A bundle directory (true) or a single file (false). */
  bundle: boolean;
}

/** Standard VST3 locations on Windows (per-machine and per-user). Linux/macOS paths are added for completeness. */
export function defaultPluginFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  const folders: string[] = [];
  if (process.platform === "win32") {
    const common = env["CommonProgramFiles"] ?? path.join(env["ProgramFiles"] ?? "C:\\Program Files", "Common Files");
    folders.push(path.join(common, "VST3"));
    if (env["LOCALAPPDATA"]) folders.push(path.join(env["LOCALAPPDATA"], "Programs", "Common", "VST3"));
  } else if (process.platform === "darwin") {
    if (env["HOME"]) folders.push(path.join(env["HOME"], "Library", "Audio", "Plug-Ins", "VST3"));
    folders.push("/Library/Audio/Plug-Ins/VST3");
  } else {
    if (env["HOME"]) folders.push(path.join(env["HOME"], ".vst3"));
    folders.push("/usr/lib/vst3", "/usr/local/lib/vst3");
  }
  return folders;
}

const prettyName = (base: string) => base.replace(/\.vst3$/i, "");

/**
 * Finds VST3 plugins under the given folders (one level deep, as installers lay them out: a plugin can be a `.vst3`
 * file or a `.vst3` bundle directory). Pure filesystem work, no audio and no plugin loading, so it is safe and testable;
 * whether a plugin actually loads and runs is decided later by the engine. Unreadable folders are skipped, not fatal.
 */
export function scanPlugins(folders: string[]): PluginEntry[] {
  const found = new Map<string, PluginEntry>();
  for (const folder of folders) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      continue; // missing or unreadable folder: nothing from here
    }
    for (const e of entries) {
      if (!/\.vst3$/i.test(e.name)) continue;
      const id = path.join(folder, e.name);
      if (found.has(id)) continue;
      found.set(id, { id, name: prettyName(e.name), folder, bundle: e.isDirectory() });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
