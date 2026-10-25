import fs from "node:fs";
import path from "node:path";

export type PluginFormat = "vst3" | "vst2";

export interface PluginEntry {
  /** Stable id: the absolute path to the plugin file (what the engine is told to load). */
  id: string;
  /** Display name, e.g. "Sylenth1" (the file name without its extension). */
  name: string;
  /** Where it was found, for grouping in the UI. */
  folder: string;
  /** A bundle directory (true) or a single file (false). */
  bundle: boolean;
  format: PluginFormat;
}

/** Standard plugin locations on Windows (per-machine and per-user VST3, and the usual VST2 folders). Other platforms get sensible defaults. */
export function defaultPluginFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  const folders: string[] = [];
  if (process.platform === "win32") {
    const pf = env["ProgramFiles"] ?? "C:\\Program Files";
    const common = env["CommonProgramFiles"] ?? path.join(pf, "Common Files");
    folders.push(path.join(common, "VST3"));
    if (env["LOCALAPPDATA"]) folders.push(path.join(env["LOCALAPPDATA"], "Programs", "Common", "VST3"));
    // VST2 (.dll): where installers usually put them
    folders.push(path.join(pf, "Steinberg", "VSTPlugins"), path.join(pf, "VSTPlugins"), path.join(common, "VST2"));
    const pf86 = env["ProgramFiles(x86)"];
    if (pf86) folders.push(path.join(pf86, "VSTPlugins"), path.join(pf86, "Steinberg", "VSTPlugins"));
  } else if (process.platform === "darwin") {
    if (env["HOME"]) folders.push(path.join(env["HOME"], "Library", "Audio", "Plug-Ins", "VST3"));
    folders.push("/Library/Audio/Plug-Ins/VST3");
  } else {
    if (env["HOME"]) folders.push(path.join(env["HOME"], ".vst3"));
    folders.push("/usr/lib/vst3", "/usr/local/lib/vst3");
  }
  return folders;
}

/** "Diva(x64).vst3" -> "Diva": the extension and a trailing architecture tag are noise in a track name. */
export const prettyName = (base: string) => {
  const bare = base.replace(/\.(vst3|dll)$/i, "");
  return bare.replace(/\s*[(_-]?(x64|x86_64|64bit)\)?$/i, "").trim() || bare;
};
const formatOf = (name: string): PluginFormat | null => (/\.vst3$/i.test(name) ? "vst3" : /\.dll$/i.test(name) ? "vst2" : null);

/** The format of a plugin file the user picked, by its extension (null when it is neither). */
export const pluginFormatOf = formatOf;

/**
 * Finds plugins under the given folders. A VST3 can be a `.vst3` file, a `.vst3` bundle directory, or one nested a level inside a
 * vendor folder (`VST3/Spire-1.5_x64/Spire.vst3`); a VST2 is a `.dll` sitting in the folder. Pure filesystem work, no loading, so it is
 * safe and testable; whether a plugin really opens is decided by the plugin host. Unreadable folders are skipped.
 */
export function scanPlugins(folders: string[]): PluginEntry[] {
  const found = new Map<string, PluginEntry>();
  const add = (folder: string, e: fs.Dirent, format: PluginFormat) => {
    const id = path.join(folder, e.name);
    if (!found.has(id)) found.set(id, { id, name: prettyName(e.name), folder, bundle: e.isDirectory(), format });
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
      const f = formatOf(e.name);
      if (f === "vst3") add(folder, e, "vst3");
      else if (f === "vst2" && e.isFile()) add(folder, e, "vst2");
      else if (e.isDirectory()) for (const sub of read(path.join(folder, e.name))) if (formatOf(sub.name) === "vst3") add(path.join(folder, e.name), sub, "vst3");
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
