/**
 * Delivery of the rendered backing track from the producer to the singer.
 *
 * The producer renders the arrangement to a WAV (the DAW's own offline export) and serves it over a tiny HTTP server bound to the
 * session's one chosen interface (control port + 3), only to the joined singer's address and only with the one-time token sent over the
 * control link. The singer downloads it (resuming with Range requests after a break), checks the SHA-256 against the id the producer
 * announced, and only then says it has the backing track. The singer then plays it from its own disk, so the music never depends on the
 * network while a take is running: no dropouts, no jitter, and the same samples the producer's export contains.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { makeRandomToken, normalizeAddress } from "./clock";
import { type Logger, nullLogger } from "./log";

export function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    s.on("data", (d) => h.update(d));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export interface PublishedBacking {
  id: string;
  bytes: number;
  token: string;
}

export class BackingServer {
  private server: http.Server | null = null;
  private current: { id: string; file: string; bytes: number; token: string } | null = null;
  private allowed = "";
  served = 0;
  refused = 0;

  constructor(private bindAddress: string, private port: number, private log: Logger = nullLogger) {}

  get listening(): boolean { return this.server !== null; }
  setAllowedPeer(ip: string): void { this.allowed = ip; }

  start(): Promise<string> {
    if (this.bindAddress === "0.0.0.0") return Promise.resolve("listening on all interfaces is not allowed");
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => this.handle(req, res));
      const onErr = (e: Error) => resolve(e.message);
      s.once("error", onErr);
      s.listen({ host: this.bindAddress, port: this.port }, () => {
        s.off("error", onErr);
        s.on("error", () => {});
        this.server = s;
        resolve("");
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
    this.current = null;
  }

  /** Makes `file` (already hashed: `id`) the backing track on offer. A new token is issued every time. */
  publish(file: string, id: string, bytes: number): PublishedBacking {
    const token = makeRandomToken(32);
    this.current = { id, file, bytes, token };
    return { id, bytes, token };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const peer = normalizeAddress(req.socket.remoteAddress);
    const cur = this.current;
    const m = /^\/([0-9a-f]{32})\/([0-9a-f]{64})\.wav$/.exec(req.url ?? "");
    if (!cur || !this.allowed || peer !== this.allowed || !m || m[1] !== cur.token || m[2] !== cur.id || req.method !== "GET") {
      this.refused++;
      this.log.log("warn", "backing", "refused", "backing request refused", { from: peer });
      res.writeHead(404).end();
      return;
    }
    let start = 0;
    let end = cur.bytes - 1;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
      if (start > end || start >= cur.bytes) {
        res.writeHead(416, { "Content-Range": `bytes */${cur.bytes}` }).end();
        return;
      }
    }
    res.writeHead(range ? 206 : 200, {
      "Content-Type": "audio/wav",
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${cur.bytes}` } : {}),
    });
    const stream = fs.createReadStream(cur.file, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    res.on("finish", () => { this.served++; });
    stream.pipe(res);
  }
}

export interface DownloadOptions {
  host: string;
  port: number;
  token: string;
  id: string;
  bytes: number;
  /** final path; written as <dest>.partial first */
  dest: string;
  retryMs?: number;
  giveUpMs?: number;
  onProgress?: (done: number, total: number) => void;
  /** return true to abandon the download (the session ended, or a newer backing track was announced) */
  cancelled?: () => boolean;
}

/** Downloads and verifies a backing track. Resolves "" on success, otherwise a plain-English reason. */
export async function downloadBacking(o: DownloadOptions): Promise<string> {
  const part = `${o.dest}.partial`;
  const retry = o.retryMs ?? 500;
  const giveUp = Date.now() + (o.giveUpMs ?? 60000);
  fs.mkdirSync(o.dest.replace(/[\\/][^\\/]*$/, ""), { recursive: true });
  try { fs.rmSync(part, { force: true }); } catch { /* start clean */ }
  let have = 0;
  while (have < o.bytes) {
    if (o.cancelled?.()) return "the download was cancelled";
    if (Date.now() > giveUp) return "the backing track could not be downloaded in time";
    const err = await new Promise<string>((resolve) => {
      const req = http.get({ host: o.host, port: o.port, path: `/${o.token}/${o.id}.wav`, headers: have ? { Range: `bytes=${have}-` } : {} }, (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return resolve(`the producer refused the download (HTTP ${res.statusCode})`);
        }
        if (have && res.statusCode !== 206) {
          res.resume();
          return resolve("resume not supported");
        }
        const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
        res.on("data", (d: Buffer) => {
          have += d.length;
          o.onProgress?.(have, o.bytes);
          if (o.cancelled?.()) req.destroy();
        });
        res.pipe(out);
        out.on("finish", () => resolve(""));
        res.on("error", (e) => resolve(e.message));
        res.on("aborted", () => resolve("the connection was interrupted"));
      });
      req.setTimeout(10000, () => req.destroy(new Error("no data for 10 s")));
      req.on("error", (e) => resolve(e.message));
    });
    if (err.startsWith("the producer refused")) return err;
    if (err === "resume not supported") have = 0;
    else if (err && have < o.bytes) await new Promise((r) => setTimeout(r, retry));
    try { have = fs.existsSync(part) ? fs.statSync(part).size : 0; } catch { have = 0; }
  }
  const got = await sha256OfFile(part);
  if (got !== o.id) {
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
    return "the backing track arrived damaged (its SHA-256 does not match); it will be sent again";
  }
  fs.renameSync(part, o.dest);
  return "";
}
