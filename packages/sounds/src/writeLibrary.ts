import fs from "node:fs";
import path from "node:path";
import { SR } from "./dsp.ts";
import { PEAK_BUCKETS, computePeaks, type IndexEntry, type LibraryIndex } from "./indexTypes.ts";
import { STARTER_VERSION, starterSpecs, type SampleSpec } from "./library.ts";
import { encodeWav } from "./wav.ts";

const safeFile = (s: string) => s.replace(/[<>:"/\\|?*]+/g, "").trim();

export function entryFor(spec: SampleSpec, channels: Float32Array[]): { entry: IndexEntry; relPath: string } {
  const relPath = `${safeFile(spec.pack)}/${safeFile(spec.category)}/${safeFile(spec.name)}.wav`;
  return {
    relPath,
    entry: {
      id: spec.id,
      name: spec.name,
      category: spec.category,
      sub: spec.sub,
      pack: spec.pack,
      tags: spec.tags,
      meta: spec.meta,
      file: relPath,
      durationSec: Math.round((channels[0]!.length / SR) * 1000) / 1000,
      sampleRate: SR,
      channels: channels.length,
      peaks: computePeaks(channels),
      origin: "starter",
    },
  };
}

/** Writes the Starter library (WAV files + index.json + version.json) into `dir`, replacing anything already there. */
export function writeStarterLibrary(dir: string, onProgress?: (done: number, total: number) => void, specs: SampleSpec[] = starterSpecs()): LibraryIndex {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const entries: IndexEntry[] = [];
  specs.forEach((spec, i) => {
    const channels = spec.render();
    const { entry, relPath } = entryFor(spec, channels);
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, encodeWav(channels));
    entries.push(entry);
    onProgress?.(i + 1, specs.length);
  });
  const index: LibraryIndex = { version: STARTER_VERSION, entries };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index));
  fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify({ version: STARTER_VERSION }));
  return index;
}

/** The installed library when it is complete and current, else null. */
function readInstalled(dir: string): LibraryIndex | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, "version.json"), "utf8")) as { version?: number };
    if (v.version === STARTER_VERSION) {
      const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")) as LibraryIndex;
      if (index.entries.length > 0 && index.entries.every((e) => fs.existsSync(path.join(dir, e.file)))) return index;
    }
  } catch {
    /* missing or damaged: regenerate */
  }
  return null;
}

/** Returns the installed Starter library, generating it first if it is missing or out of date (version changed). */
export function ensureStarterLibrary(dir: string, onProgress?: (done: number, total: number) => void, specs?: SampleSpec[]): LibraryIndex {
  const installed = readInstalled(dir);
  if (installed) return installed;
  const tmp = `${dir}.tmp`;
  const index = writeStarterLibrary(tmp, onProgress, specs);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return index;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Same as ensureStarterLibrary, but yields to the event loop between sounds so an app's main process stays responsive (about 6 s of work). */
export async function ensureStarterLibraryAsync(dir: string, onProgress?: (done: number, total: number) => void, specs: SampleSpec[] = starterSpecs()): Promise<LibraryIndex> {
  const installed = readInstalled(dir);
  if (installed) return installed;
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const entries: IndexEntry[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const channels = spec.render();
    const { entry, relPath } = entryFor(spec, channels);
    const full = path.join(tmp, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, encodeWav(channels));
    entries.push(entry);
    onProgress?.(i + 1, specs.length);
    await yieldToEventLoop();
  }
  const index: LibraryIndex = { version: STARTER_VERSION, entries };
  fs.writeFileSync(path.join(tmp, "index.json"), JSON.stringify(index));
  fs.writeFileSync(path.join(tmp, "version.json"), JSON.stringify({ version: STARTER_VERSION }));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return index;
}
