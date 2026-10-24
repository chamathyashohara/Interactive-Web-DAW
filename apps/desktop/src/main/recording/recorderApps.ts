import fs from "node:fs";
import path from "node:path";

/** Component 4 (remote recording) is two separate programs; the DAW only starts them. */
export type RecorderRole = "producer" | "performer";

export const EXE_NAME: Record<RecorderRole, string> = {
  producer: "ProducerStudio.exe",
  performer: "PerformerClient.exe",
};

/** How deep below a search folder the programs are looked for (the build puts them in build/<preset>/bin/<Config>). */
const MAX_DEPTH = 5;

function walk(dir: string, name: string, depth: number, found: string[]) {
  if (depth > MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) found.push(full);
    else if (e.isDirectory() && e.name !== "node_modules" && e.name !== "CMakeFiles") walk(full, name, depth + 1, found);
  }
}

/** All copies of a program found under the search folders; a Release build comes first. */
export function searchRecorderApp(role: RecorderRole, roots: string[]): string[] {
  const found: string[] = [];
  for (const root of roots) walk(root, EXE_NAME[role], 0, found);
  return found.sort((a, b) => Number(/release/i.test(b)) - Number(/release/i.test(a)));
}

export interface FindOptions {
  /** A path chosen by the user ("Locate…"), remembered between runs. */
  saved?: string;
  /** Test / deployment override (DAW_RR_PRODUCER, DAW_RR_PERFORMER). */
  env?: string;
  /** Folders to search when nothing was chosen. */
  roots: string[];
}

/** The program to start for a role, or null when it has not been built / located. */
export function findRecorderApp(role: RecorderRole, opts: FindOptions): string | null {
  for (const chosen of [opts.env, opts.saved]) {
    if (chosen && fs.existsSync(chosen)) return chosen;
  }
  return searchRecorderApp(role, opts.roots)[0] ?? null;
}
