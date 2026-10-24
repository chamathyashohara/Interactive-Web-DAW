import fs from "node:fs";
import path from "node:path";

export interface TakeFile {
  /** Absolute path of the recording. */
  file: string;
  /** File name without the folder. */
  name: string;
  bytes: number;
  /** When the DAW noticed it (epoch ms). */
  seenAt: number;
}

const MAX_DEPTH = 3;
const MAX_LISTED = 20;

/** true for a file that starts like a finished WAV (a recording that is still being written, or a stray file, is not offered). */
export function looksLikeWav(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) < 12) return false;
    return head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WAVE";
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function listWavs(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_DEPTH) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase().endsWith(".wav")) out.push(full);
    else if (e.isDirectory()) listWavs(full, depth + 1, out);
  }
  return out;
}

/**
 * Watches the folder where the recorder programs save takes and reports new WAV files.
 * Files already there when watching starts are not offered. A file is offered once its size has stopped changing
 * between two checks, so a take that is still being recorded or copied is never picked up half written.
 */
export class TakeWatcher {
  private known = new Set<string>();
  private sizes = new Map<string, number>();
  private takes: TakeFile[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private dir: string,
    private onChange: (takes: TakeFile[]) => void,
    private intervalMs = 1500,
  ) {}

  get folder(): string {
    return this.dir;
  }

  start() {
    this.stop();
    for (const f of listWavs(this.dir)) this.known.add(f);
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Changes the watched folder; the list of offered takes starts again. */
  setFolder(dir: string) {
    this.dir = dir;
    this.known.clear();
    this.sizes.clear();
    this.takes = [];
    this.start();
    this.onChange(this.list());
  }

  list(): TakeFile[] {
    return [...this.takes];
  }

  /** Removes a take from the offered list (it was added to the project, or the user does not want it). */
  dismiss(file: string) {
    const before = this.takes.length;
    this.takes = this.takes.filter((t) => t.file !== file);
    if (this.takes.length !== before) this.onChange(this.list());
  }

  /** One check of the folder. Public so tests do not have to wait for the timer. */
  poll() {
    let changed = false;
    for (const f of listWavs(this.dir)) {
      if (this.known.has(f)) continue;
      let size: number;
      try {
        size = fs.statSync(f).size;
      } catch {
        continue;
      }
      const before = this.sizes.get(f);
      this.sizes.set(f, size);
      if (before !== size || size <= 44 || !looksLikeWav(f)) continue; // still growing, empty, or not a WAV: look again next time
      this.known.add(f);
      this.sizes.delete(f);
      this.takes = [{ file: f, name: path.basename(f), bytes: size, seenAt: Date.now() }, ...this.takes].slice(0, MAX_LISTED);
      changed = true;
    }
    if (changed) this.onChange(this.list());
  }
}
