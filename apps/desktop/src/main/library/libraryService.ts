import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { categorize, cleanName, detectBrandWord, parseBpm, parseKeyTag, trackNameFor, type IndexEntry, type SampleMeta } from "@daw/sounds";
import { ensureStarterLibraryAsync } from "@daw/sounds/node";

/** What the audio engine tells us about a file (decoded by the engine, so every format it supports works). */
export interface SampleAnalysis {
  durationSec: number;
  sampleRate: number;
  channels: number;
  peaks: number[];
}
export type Analyzer = (absPath: string) => Promise<SampleAnalysis>;

export interface ImportProgress {
  phase: "extracting" | "importing" | "done";
  done: number;
  total: number;
  current?: string;
}
export interface ImportResult {
  ok: boolean;
  reason?: string;
  pack?: string;
  added: number;
  duplicates: number;
  failed: { file: string; reason: string }[];
  /** The brand word that was found at the start of the names and removed ("KSHMR"), if any. */
  brandRemoved: string | null;
}

export interface PackInfo {
  name: string;
  origin: "starter" | "imported";
  count: number;
}
export interface LibraryList {
  entries: IndexEntry[];
  packs: PackInfo[];
}

const AUDIO_EXT = new Set([".wav", ".aif", ".aiff", ".flac", ".ogg"]);
const MAX_FILES = 6000;
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const IMPORT_INDEX_VERSION = 1;

interface ImportedIndex {
  version: number;
  entries: IndexEntry[];
}

const safeSegment = (s: string): string => s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "") || "Pack";

function scanAudio(root: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length && found.length < MAX_FILES) {
    const dir = stack.pop()!;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      if (it.isSymbolicLink() || it.name.startsWith("._") || it.name === "__MACOSX") continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) stack.push(full);
      else if (it.isFile() && AUDIO_EXT.has(path.extname(it.name).toLowerCase())) found.push(full);
    }
  }
  return found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * The `tar` that can read zip files. On Windows that is the system bsdtar; a GNU tar earlier on PATH (Git Bash, MSYS)
 * cannot, so the system one is used by full path.
 */
export function systemTar(): string {
  if (process.platform !== "win32") return "tar";
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

/** Extracts a .zip with the system `tar` (Windows 10+, macOS and most Linux ship it; no extra dependency). */
function extractZip(zip: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(systemTar(), ["-xf", zip, "-C", into], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => reject(new Error(`cannot unpack the zip: ${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`cannot unpack the zip (${err.trim().split("\n")[0] ?? `exit ${code}`})`))));
  });
}

const hashFile = (file: string): string => createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 16);

/**
 * The sample library: the Starter packs (generated on first run) plus the packs the user imports.
 * Everything lives in `root` (the app's user-data folder), never in the project or the repository.
 */
export class LibraryService {
  private readonly starterDir: string;
  private readonly importedDir: string;
  private starter: IndexEntry[] = [];
  private imported: IndexEntry[] = [];
  private importing = false;

  constructor(
    private readonly root: string,
    private readonly analyze: Analyzer,
    /** Where the generated Starter packs live; tests share one copy between runs. */
    starterDir?: string,
  ) {
    this.starterDir = starterDir ?? path.join(root, "starter");
    this.importedDir = path.join(root, "imported");
    fs.mkdirSync(this.importedDir, { recursive: true });
    this.imported = this.readImported();
  }

  /** Makes sure the Starter packs exist (first run generates them in a few seconds) and returns the library. */
  async init(onProgress?: (done: number, total: number) => void): Promise<LibraryList> {
    this.starter = (await ensureStarterLibraryAsync(this.starterDir, onProgress)).entries;
    return this.list();
  }

  list(): LibraryList {
    const entries = [...this.starter, ...this.imported];
    const packs = new Map<string, PackInfo>();
    for (const e of entries) {
      const p = packs.get(e.pack) ?? { name: e.pack, origin: e.origin, count: 0 };
      p.count++;
      packs.set(e.pack, p);
    }
    return { entries, packs: [...packs.values()] };
  }

  find(id: string): IndexEntry | undefined {
    return this.starter.find((e) => e.id === id) ?? this.imported.find((e) => e.id === id);
  }

  /** Absolute path of a sample's audio file, or null when the id is unknown or the file has gone missing. */
  pathOf(id: string): string | null {
    const e = this.find(id);
    if (!e) return null;
    const file = path.join(e.origin === "starter" ? this.starterDir : this.importedDir, e.file);
    return fs.existsSync(file) ? file : null;
  }

  /**
   * Imports a .zip or a folder of samples. Names lose a common brand prefix (e.g. "KSHMR"), each sample gets a category
   * and key/tempo tags from its folder and file name, and the audio is copied into the library (the original is untouched).
   */
  async importPath(source: string, onProgress?: (p: ImportProgress) => void): Promise<ImportResult> {
    const empty: ImportResult = { ok: false, added: 0, duplicates: 0, failed: [], brandRemoved: null };
    if (this.importing) return { ...empty, reason: "An import is already running." };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(source);
    } catch {
      return { ...empty, reason: "That file or folder cannot be found." };
    }
    this.importing = true;
    let tmp: string | null = null;
    try {
      let scanRoot = source;
      let packBase = path.basename(source);
      if (stat.isFile()) {
        if (path.extname(source).toLowerCase() !== ".zip") return { ...empty, reason: "Choose a .zip file or a folder of samples." };
        tmp = path.join(this.root, `import-${randomUUID()}`);
        fs.mkdirSync(tmp, { recursive: true });
        onProgress?.({ phase: "extracting", done: 0, total: 1 });
        await extractZip(source, tmp);
        scanRoot = tmp;
        packBase = path.basename(source, path.extname(source));
      }
      const files = scanAudio(scanRoot);
      if (files.length === 0) return { ...empty, reason: "No audio files (.wav, .aiff, .flac, .ogg) were found." };

      const baseOf = (f: string) => path.basename(f, path.extname(f)).replace(/_/g, " ");
      const brand = detectBrandWord(files.map(baseOf));
      const pack = this.uniquePack(safeSegment(cleanName(packBase, brand)));
      const result: ImportResult = { ok: true, pack, added: 0, duplicates: 0, failed: [], brandRemoved: brand };
      const known = new Set(this.imported.map((e) => e.id));
      const usedFiles = new Set(this.imported.map((e) => e.file.toLowerCase()));
      const added: IndexEntry[] = [];

      for (let i = 0; i < files.length; i++) {
        const abs = files[i]!;
        const rel = path.relative(scanRoot, abs);
        onProgress?.({ phase: "importing", done: i, total: files.length, current: path.basename(abs) });
        try {
          if (fs.statSync(abs).size > MAX_FILE_BYTES) throw new Error("file is larger than 300 MB");
          const id = `imported/${hashFile(abs)}`;
          if (known.has(id)) {
            result.duplicates++;
            continue;
          }
          const info = await this.analyze(abs);
          const folders = path.dirname(rel) === "." ? [] : path.dirname(rel).split(path.sep).map((f) => cleanName(f, brand));
          const name = cleanName(baseOf(abs), brand);
          const display = trackNameFor(name);
          const { category, sub } = categorize(folders, name);
          const meta: SampleMeta = {};
          const key = parseKeyTag(name);
          if (key) {
            meta.rootPc = key.pitchClass;
            if (key.minor) meta.key = { tonic: key.pitchClass, mode: "minor" };
          }
          const bpm = parseBpm(name) ?? parseBpm(folders.join(" "));
          if (bpm && category === "Loop") {
            meta.bpm = bpm;
            meta.bars = Math.max(1, Math.round((info.durationSec * bpm) / 240));
          }
          if (category === "Loop") meta.loop = true;

          let relFile = path.join(safeSegment(pack), ...folders.map(safeSegment), `${safeSegment(name)}${path.extname(abs).toLowerCase()}`);
          for (let n = 2; usedFiles.has(relFile.toLowerCase()); n++)
            relFile = path.join(path.dirname(relFile), `${safeSegment(name)} ${n}${path.extname(abs).toLowerCase()}`);
          usedFiles.add(relFile.toLowerCase());
          const dest = path.join(this.importedDir, relFile);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(abs, dest);

          added.push({
            id,
            name: display,
            category,
            sub,
            pack,
            tags: folders.map((f) => f.toLowerCase()),
            meta,
            file: relFile.split(path.sep).join("/"),
            durationSec: Math.round(info.durationSec * 1000) / 1000,
            sampleRate: info.sampleRate,
            channels: info.channels,
            peaks: info.peaks,
            origin: "imported",
          });
          known.add(id);
          result.added++;
        } catch (err) {
          result.failed.push({ file: rel, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      this.imported = [...this.imported, ...added];
      this.writeImported();
      onProgress?.({ phase: "importing", done: files.length, total: files.length });
      return result;
    } catch (err) {
      return { ...empty, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      this.importing = false;
    }
  }

  /**
   * Adds one audio file (a take from the remote recording programs, or any recording) to the library and returns its entry.
   * It goes through the same import as a folder of samples, so it is analysed, copied (the original is untouched) and de-duplicated.
   * Each file becomes its own small pack, named "Recording <name>".
   */
  async importFile(file: string, onProgress?: (p: ImportProgress) => void): Promise<{ ok: boolean; reason?: string; entry?: IndexEntry }> {
    const ext = path.extname(file).toLowerCase();
    if (![".wav", ".aiff", ".aif", ".flac", ".ogg"].includes(ext)) return { ok: false, reason: "Choose a .wav, .aiff, .flac or .ogg recording." };
    if (!fs.existsSync(file)) return { ok: false, reason: "That recording cannot be found." };
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "daw-take-"));
    try {
      const folder = path.join(stage, `Recording ${path.basename(file, ext).replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 40)}`);
      fs.mkdirSync(folder, { recursive: true });
      fs.copyFileSync(file, path.join(folder, path.basename(file)));
      const result = await this.importPath(folder, onProgress);
      if (!result.ok) return { ok: false, reason: result.reason ?? "The recording could not be added." };
      if (result.failed.length) return { ok: false, reason: result.failed[0]!.reason };
      const entry = this.find(`imported/${hashFile(file)}`);
      return entry ? { ok: true, entry } : { ok: false, reason: "The recording was not added to the library." };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }

  /** Deletes an imported pack from the library (the user's original files are never touched). The Starter packs cannot be removed. */
  removePack(name: string): boolean {
    const mine = this.imported.filter((e) => e.pack === name);
    if (mine.length === 0) return false;
    for (const e of mine) fs.rmSync(path.join(this.importedDir, e.file), { force: true });
    fs.rmSync(path.join(this.importedDir, safeSegment(name)), { recursive: true, force: true });
    this.imported = this.imported.filter((e) => e.pack !== name);
    this.writeImported();
    return true;
  }

  private uniquePack(base: string): string {
    const taken = new Set(this.list().packs.map((p) => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  }

  private readImported(): IndexEntry[] {
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(this.importedDir, "index.json"), "utf8")) as ImportedIndex;
      if (idx.version !== IMPORT_INDEX_VERSION || !Array.isArray(idx.entries)) return [];
      return idx.entries.filter((e) => fs.existsSync(path.join(this.importedDir, e.file)));
    } catch {
      return [];
    }
  }

  private writeImported(): void {
    const file = path.join(this.importedDir, "index.json");
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: IMPORT_INDEX_VERSION, entries: this.imported } satisfies ImportedIndex));
    fs.renameSync(tmp, file);
  }
}
