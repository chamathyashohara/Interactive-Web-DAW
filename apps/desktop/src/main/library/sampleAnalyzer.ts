import { randomUUID } from "node:crypto";
import type { SampleInfo } from "@daw/engine-protocol";
import type { Analyzer } from "./libraryService";

interface Pending {
  resolve: (info: Extract<SampleInfo, { ok: true }>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Asks the audio engine to decode a file and report its length and waveform (so every format the engine reads works,
 * and the decode code exists only once). Requests are matched to answers by id.
 */
export class SampleAnalyzer {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly send: (cmd: { t: "analyzeSample"; id: string; path: string }) => void,
    private readonly isUp: () => boolean,
    private readonly timeoutMs = 60_000,
  ) {}

  readonly analyze: Analyzer = (absPath) =>
    new Promise((resolve, reject) => {
      if (!this.isUp()) return reject(new Error("the audio engine is not running"));
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("the audio engine took too long to read this file"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ t: "analyzeSample", id, path: absPath });
    });

  onInfo(info: SampleInfo): void {
    const p = this.pending.get(info.id);
    if (!p) return;
    this.pending.delete(info.id);
    clearTimeout(p.timer);
    if (info.ok) p.resolve(info);
    else p.reject(new Error(info.message));
  }

  /** The engine went away: nothing pending will be answered. */
  failAll(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
