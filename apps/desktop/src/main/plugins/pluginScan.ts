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
 * Finds VST3 plugins under the given folders. A plugin can be a `.vst3` file, a `.vst3` bundle directory, or a `.vst3`
 * nested one level inside a vendor folder (e.g. `VST3/Spire-1.5_x64/Spire.vst3`), so this looks into non-`.vst3`
 * subfolders one level deep. Pure filesystem work, no audio and no plugin loading, so it is safe and testable; whether a
 * plugin actually loads and runs is decided later by the engine. Unreadable folders are skipped, not fatal.
 */
export function scanPlugins(folders: string[]): PluginEntry[] {
  const found = new Map<string, PluginEntry>();
  const add = (folder: string, e: fs.Dirent) => {
    const id = path.join(folder, e.name);
    if (!found.has(id)) found.set(id, { id, name: prettyName(e.name), folder, bundle: e.isDirectory() });
  };
  const read = (folder: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return []; // missing or unreadable folder: nothing from here
    }
  };
  for (const folder of folders) {
    for (const e of read(folder)) {
      if (/\.vst3$/i.test(e.name)) add(folder, e);
      else if (e.isDirectory()) for (const sub of read(path.join(folder, e.name))) if (/\.vst3$/i.test(sub.name)) add(path.join(folder, e.name), sub);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
