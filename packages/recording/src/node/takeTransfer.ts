/**
 * Verified take transfer (RRXF v1, ADR-014/ADR-020): the performer's original WAV travels to the producer as a *copy*, in
 * hashed chunks over its own TCP connection (control port + 2). Ported from take_sender.cpp / take_receiver.cpp.
 *
 * VERIFIED is set in exactly one place: after the whole-file SHA-256 of the bytes ON THE PRODUCER'S DISK matched the performer's
 * hash, the WAV parsed as a complete float32 file matching the offer (and the performer's TAKE_FINALISED frame count), and the
 * file was moved to its final name without replacing anything. The performer's original is only ever opened read-only.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { toHex } from "../bytes";
import { ErrorCode } from "../errors";
import { inspectWav } from "../wav";
import {
  DEFAULT_CHUNK_BYTES, MAX_CHUNK_BYTES, MIN_CHUNK_BYTES, XDecoder, XType, type XMsg, chunkCountFor, encodeX, xmsg, xtypeName,
} from "../transferProtocol";
import { type Clock, makeRandomToken, msToNs, normalizeAddress, systemClock } from "./clock";
import { type Logger, nullLogger } from "./log";

export type TransferState = "queued" | "transferring" | "retrying" | "verifying" | "verified" | "failed";
export const transferStateFinal = (s: TransferState): boolean => s === "verified" || s === "failed";

export interface TransferView {
  takeId: number;
  state: TransferState;
  bytesTotal: number;
  bytesDone: number;
  chunksTotal: number;
  chunksDone: number;
  chunkBytes: number;
  connections: number;
  resumedFromChunk: number;
  resumes: number;
  chunkRejects: number;
  hashFailures: number;
  alreadyVerified: boolean;
  sha256Hex: string;
  /** producer: final copy (VERIFIED) or partial; performer: the original */
  file: string;
  detail: string;
  sampleRate: number;
  channels: number;
  bits: number;
  frames: number;
  durationS: number;
  framesVsReport: string;
  sourceShaAfterHex: string;
  sourceUnchanged: boolean;
  startedNs: number;
  finishedNs: number;
}
const newView = (takeId: number): TransferView => ({
  takeId, state: "queued", bytesTotal: 0, bytesDone: 0, chunksTotal: 0, chunksDone: 0, chunkBytes: 0, connections: 0, resumedFromChunk: 0, resumes: 0,
  chunkRejects: 0, hashFailures: 0, alreadyVerified: false, sha256Hex: "", file: "", detail: "", sampleRate: 0, channels: 0, bits: 0, frames: 0, durationS: 0,
  framesVsReport: "", sourceShaAfterHex: "", sourceUnchanged: false, startedNs: 0, finishedNs: 0,
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hhmmss = () => new Date().toISOString().slice(11, 23);
const takeTag = (take: number) => `take ${take}: `;
const displaySafeName = (s: string) => s.replace(/[^A-Za-z0-9._ -]/g, "?").slice(0, 128);

/** SHA-256 of a file, read in pieces so a long take does not stall the app. */
export function sha256File(file: string): Promise<{ digest: Uint8Array; bytes: number }> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    let bytes = 0;
    const s = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    s.on("data", (d) => {
      h.update(d);
      bytes += (d as Buffer).length;
    });
    s.on("error", reject);
    s.on("end", () => resolve({ digest: new Uint8Array(h.digest()), bytes }));
  });
}
const sha256Bytes = (b: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(b).digest());
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function readHead(file: string, n = 4096): { head: Uint8Array; size: number } {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(n, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return { head: new Uint8Array(buf), size };
  } finally {
    fs.closeSync(fd);
  }
}

/** A TCP connection speaking RRXF. */
class XConn {
  readonly decoder = new XDecoder();
  inbox: XMsg[] = [];
  error = "";
  closed = false;
  /** true while one handler loop is working through `inbox` (messages must be handled strictly in order) */
  draining = false;
  private waiters: (() => void)[] = [];
  constructor(readonly socket: net.Socket) {
    socket.setNoDelay(true);
    socket.on("data", (d: Buffer) => {
      this.decoder.feed(d);
      for (;;) {
        const r = this.decoder.next();
        if (r.kind === "need-more") break;
        if (r.kind === "error") {
          this.error = r.error;
          this.closed = true;
          socket.destroy();
          break;
        }
        this.inbox.push(r.message);
      }
      this.wake();
    });
    socket.on("error", (e) => {
      this.error = e.message;
      this.closed = true;
      this.wake();
    });
    socket.on("close", () => {
      this.closed = true;
      if (!this.error) this.error = "the connection was closed";
      this.wake();
    });
  }
  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  send(m: XMsg): void {
    if (!this.closed && this.socket.writable) this.socket.write(encodeX(m));
  }
  get pendingOut(): number { return this.socket.writableLength; }
  /** Resolves after `ms` or as soon as something happens. */
  activity(ms: number): Promise<void> {
    if (this.inbox.length || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }
  closeAfterFlush(ms = 200): void {
    if (this.socket.destroyed) return;
    const t = setTimeout(() => this.socket.destroy(), ms);
    this.socket.once("close", () => clearTimeout(t));
    this.socket.end();
  }
  close(): void {
    this.socket.destroy();
  }
}

// =================================================================================================
// Producer side
// =================================================================================================

export interface ReceiverParams {
  bindAddress: string;
  port: number;
  sessionId: string;
  helloTimeoutMs?: number;
  idleTimeoutMs?: number;
  resumeWaitMs?: number;
  maxHashFailures?: number;
  maxSameChunkRejects?: number;
  ackEveryChunks?: number;
  clock?: Clock;
}

interface RecvPaths { dir: string; finalWav: string; partial: string; journal: string; record: string }

interface Job {
  v: TransferView;
  token: string;
  expectedFrames: number;
  paths: RecvPaths;
  offer: XMsg | null;
  next: number;
  fd: number | null;
  retryDeadlineNs: number;
  sameChunkRejects: number;
  discarding: boolean;
  sinceAck: number;
  verifying: boolean;
}

type RPhase = "await-hello" | "await-offer" | "receiving" | "verifying";
interface RConn { x: XConn; peer: string; phase: RPhase; deadlineNs: number; lastRxNs: number; take: number; chunksThisConn: number }

const take_stem = (take: number, sessionId: string) => `take${String(take).padStart(2, "0")}_performer_${sessionId}`;

export class TakeReceiver {
  private p: Required<Omit<ReceiverParams, "clock">>;
  private clock: Clock;
  private server: net.Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private jobs = new Map<number, Job>();
  private conn: RConn | null = null;
  private allowedPeer = "";
  private lines: string[] = [];
  private refusedConnections = 0;
  private testDropAfter = 0;
  running = false;

  constructor(params: ReceiverParams, private log: Logger = nullLogger) {
    this.clock = params.clock ?? systemClock;
    this.p = {
      bindAddress: params.bindAddress, port: params.port, sessionId: params.sessionId, helloTimeoutMs: params.helloTimeoutMs ?? 5000,
      idleTimeoutMs: params.idleTimeoutMs ?? 10000, resumeWaitMs: params.resumeWaitMs ?? 60000, maxHashFailures: params.maxHashFailures ?? 2,
      maxSameChunkRejects: params.maxSameChunkRejects ?? 4, ackEveryChunks: params.ackEveryChunks ?? 16,
    };
  }

  get port(): number { return this.p.port; }
  get refused(): number { return this.refusedConnections; }
  /** TEST ONLY: cuts the transfer connection after n chunks, once. */
  testDropAfterChunks(n: number): void { this.testDropAfter = n; }

  start(): Promise<string> {
    if (this.p.bindAddress === "0.0.0.0") return Promise.resolve("listening on all interfaces is not allowed");
    return new Promise((resolve) => {
      const s = net.createServer((sock) => this.accept(sock));
      const onErr = (e: Error) => resolve(e.message);
      s.once("error", onErr);
      s.listen({ host: this.p.bindAddress, port: this.p.port }, () => {
        s.off("error", onErr);
        s.on("error", () => {});
        this.server = s;
        this.running = true;
        this.timer = setInterval(() => this.timers(), 100);
        this.history(`transfer listener on ${this.p.bindAddress}:${this.p.port}`);
        resolve("");
      });
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.conn?.x.close();
    this.conn = null;
    for (const j of this.jobs.values()) this.closeFd(j);
    this.server?.close();
    this.server = null;
  }

  setAllowedPeer(ipv4: string): void { this.allowedPeer = ipv4; }

  /** Asks for take `takeId`. Returns the one-time token (never log it) or an error text. */
  expect(takeId: number, expectedFrames: number, dir: string): { token: string } | { error: string } {
    const old = this.jobs.get(takeId);
    if (old && !transferStateFinal(old.v.state)) return { error: `a transfer of take ${takeId} is already ${old.v.state}` };
    if (takeId < 1 || takeId > 999) return { error: "take id outside 1..999" };
    if (!dir) return { error: "no folder for received takes" };
    const stem = take_stem(takeId, this.p.sessionId);
    const j: Job = {
      v: newView(takeId), token: makeRandomToken(32), expectedFrames,
      paths: { dir, finalWav: path.join(dir, `${stem}.wav`), partial: path.join(dir, `${stem}.wav.xfer.partial`), journal: path.join(dir, `${stem}.wav.xfer.journal`), record: path.join(dir, `${stem}.wav.transfer.json`) },
      offer: null, next: 0, fd: null, retryDeadlineNs: 0, sameChunkRejects: 0, discarding: false, sinceAck: 0, verifying: false,
    };
    j.v.state = "queued";
    j.v.startedNs = this.clock.nowNs();
    j.retryDeadlineNs = j.v.startedNs + msToNs(this.p.resumeWaitMs);
    j.v.file = j.paths.partial;
    j.v.detail = "waiting for the performer";
    this.jobs.set(takeId, j);
    return { token: j.token };
  }

  cancel(takeId: number, why: string): void {
    const j = this.jobs.get(takeId);
    if (!j || transferStateFinal(j.v.state)) return;
    if (this.conn && this.conn.take === takeId) {
      if (j.fd !== null) this.persist(j);
      this.abortConn(why, ErrorCode.Cancelled);
    }
    this.fail(j, why);
  }

  anyActive(): boolean {
    return [...this.jobs.values()].some((j) => !transferStateFinal(j.v.state));
  }
  transfers(): TransferView[] {
    return [...this.jobs.values()].map((j) => ({ ...j.v })).sort((a, b) => a.takeId - b.takeId);
  }
  takeHistory(): string[] {
    const out = this.lines;
    this.lines = [];
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  private history(line: string): void {
    this.lines.push(`${hhmmss()}  ${line}`);
    if (this.lines.length > 500) this.lines.shift();
  }
  private closeFd(j: Job): void {
    if (j.fd !== null) {
      try { fs.closeSync(j.fd); } catch { /* already closed */ }
      j.fd = null;
    }
  }
  private fail(j: Job, why: string): void {
    this.closeFd(j);
    j.v.state = "failed";
    j.v.detail = why;
    j.v.finishedNs = this.clock.nowNs();
    this.history(`${takeTag(j.v.takeId)}FAILED: ${why} (the performer's original is unchanged)`);
    this.log.log("warn", "transfer", "failed", why, { take: j.v.takeId });
  }
  private persist(j: Job): void {
    if (j.fd !== null && j.offer) {
      try { fs.fsyncSync(j.fd); } catch (e) { this.history(`${takeTag(j.v.takeId)}flush failed: ${(e as Error).message}`); }
      try {
        fs.writeFileSync(j.paths.journal, JSON.stringify({ sessionId: this.p.sessionId, takeId: j.v.takeId, fileBytes: j.offer.fileBytes, sha256: toHex(j.offer.fileSha), chunkBytes: j.offer.chunkBytes, chunksDone: j.next }));
      } catch (e) {
        this.history(`${takeTag(j.v.takeId)}cannot write the transfer journal: ${(e as Error).message}`);
      }
    }
  }
  private readJournal(file: string): { sessionId: string; takeId: number; fileBytes: number; sha256: string; chunkBytes: number; chunksDone: number } | null {
    try {
      const t = fs.readFileSync(file, "utf8");
      return t.length > 4096 ? null : JSON.parse(t);
    } catch {
      return null;
    }
  }
  private abortConn(text: string, code: number): void {
    const c = this.conn;
    if (!c) return;
    c.x.send(xmsg(XType.Abort, { code, text }));
    c.x.closeAfterFlush(500);
    this.conn = null;
  }
  private finishConn(): void {
    this.conn?.x.closeAfterFlush(500);
    this.conn = null;
  }

  private connectionLost(why: string, abortCode: number = ErrorCode.Ok): void {
    const c = this.conn;
    if (!c) return;
    const take = c.take;
    const phase = c.phase;
    if (abortCode !== ErrorCode.Ok) {
      c.x.send(xmsg(XType.Abort, { code: abortCode, text: why }));
      c.x.closeAfterFlush(500);
    } else {
      c.x.close();
    }
    this.conn = null;
    const j = this.jobs.get(take);
    if (!j || transferStateFinal(j.v.state) || phase === "await-hello" || phase === "verifying") return;
    if (j.v.state === "transferring" && j.fd !== null) this.persist(j);
    this.closeFd(j);
    j.v.state = "retrying";
    j.v.detail = `connection lost (${why}); waiting for the performer to resume`;
    j.retryDeadlineNs = this.clock.nowNs() + msToNs(this.p.resumeWaitMs);
    this.history(`${takeTag(take)}PAUSED: ${why}; ${j.next} of ${j.v.chunksTotal} chunks kept on disk`);
    this.log.log("warn", "transfer", "connection_lost", why, { take, chunks_kept: j.next });
  }

  private accept(sock: net.Socket): void {
    const peer = normalizeAddress(sock.remoteAddress);
    const x = new XConn(sock);
    if (!this.running) return x.close();
    if (!this.allowedPeer || peer !== this.allowedPeer) {
      const n = ++this.refusedConnections;
      if (n <= 3 || n % 100 === 0) {
        this.log.log("warn", "transfer", "connection_refused", "not the joined performer's address", { from: peer, refused_so_far: n });
        this.history(`transfer connection from ${peer} refused (not the joined performer; ${n} so far)`);
      }
      return x.close(); // no reply to strangers
    }
    if (this.conn) {
      x.send(xmsg(XType.Abort, { code: ErrorCode.Busy, text: "another transfer is running" }));
      return x.closeAfterFlush(200);
    }
    const now = this.clock.nowNs();
    this.conn = { x, peer, phase: "await-hello", deadlineNs: now + msToNs(this.p.helloTimeoutMs), lastRxNs: now, take: 0, chunksThisConn: 0 };
    // Handle messages as they arrive.
    const pump = () => { void this.drain(x); };
    sock.on("data", pump);
    sock.on("close", () => { if (this.conn?.x === x) this.connectionLost(x.error || "the connection was closed"); });
  }

  private async drain(x: XConn): Promise<void> {
    if (x.draining) return;
    x.draining = true;
    try {
      while (this.conn?.x === x && x.inbox.length) {
        const m = x.inbox.shift()!;
        await this.handle(m);
      }
    } finally {
      x.draining = false;
    }
  }

  private async handle(m: XMsg): Promise<void> {
    const c = this.conn;
    if (!c) return;
    c.lastRxNs = this.clock.nowNs();
    switch (c.phase) {
      case "await-hello":
        if (m.type !== XType.Hello) return this.abortConn("expected HELLO", ErrorCode.ProtocolMalformed);
        return this.onHello(m);
      case "await-offer":
        if (m.type === XType.Abort) return this.connectionLost(`performer aborted: ${m.text}`);
        if (m.type !== XType.Offer) return this.abortConn("expected OFFER", ErrorCode.ProtocolMalformed);
        return this.onOffer(m);
      case "receiving":
        if (m.type === XType.Chunk) return this.onChunk(m);
        if (m.type === XType.Done) return this.onDone(m);
        if (m.type === XType.Abort) return this.connectionLost(`performer aborted: ${m.text}`);
        return this.connectionLost(`unexpected ${xtypeName(m.type)}`, ErrorCode.ProtocolMalformed);
      case "verifying":
        return;
    }
  }

  private onHello(m: XMsg): void {
    if (m.sessionId !== this.p.sessionId) {
      this.log.log("warn", "transfer", "hello_refused", "wrong session", { got: m.sessionId, take: m.takeId });
      this.history(`transfer HELLO for another session (${m.sessionId}) refused; nothing written`);
      return this.abortConn("wrong session", ErrorCode.TransferRefused);
    }
    const j = this.jobs.get(m.takeId);
    if (!j || transferStateFinal(j.v.state)) {
      this.history(`transfer HELLO for take ${m.takeId} refused: not requested`);
      this.log.log("warn", "transfer", "hello_refused", "take not requested", { take: m.takeId });
      return this.abortConn("no transfer was requested for this take", ErrorCode.UnknownTake);
    }
    if (m.token !== j.token) {
      this.history(`${takeTag(m.takeId)}HELLO with a wrong token refused; nothing written`);
      this.log.log("warn", "transfer", "hello_refused", "wrong token", { take: m.takeId });
      return this.abortConn("wrong transfer token", ErrorCode.TransferRefused);
    }
    const c = this.conn!;
    c.take = m.takeId;
    c.phase = "await-offer";
    c.deadlineNs = this.clock.nowNs() + msToNs(this.p.helloTimeoutMs);
    j.v.connections++;
  }

  private checkOffer(j: Job, o: XMsg): string {
    if (o.takeId !== j.v.takeId) return "offer for a different take";
    if (o.fileBytes < 58 || o.fileBytes > 0xffffffff + 8) return "file size out of range";
    if (o.chunkBytes < MIN_CHUNK_BYTES || o.chunkBytes > MAX_CHUNK_BYTES) return "chunk size out of range";
    if (o.chunkCount !== chunkCountFor(o.fileBytes, o.chunkBytes)) return "chunk count does not match the size";
    if (!(o.formatTag === 3 || o.formatTag === 0xfffe) || o.bits !== 32) return "not a 32-bit float WAV";
    if (o.channels < 1 || o.channels > 32 || o.sampleRate < 8000 || o.sampleRate > 384000) return "format out of range";
    if (o.frames * o.channels * 4 > o.fileBytes) return "frame count larger than the file";
    if (j.expectedFrames !== 0 && o.frames !== j.expectedFrames) return `offered ${o.frames} frames but the performer reported ${j.expectedFrames} in TAKE_FINALISED`;
    if (j.offer && (o.fileBytes !== j.offer.fileBytes || !bytesEqual(o.fileSha, j.offer.fileSha) || o.chunkBytes !== j.offer.chunkBytes)) {
      return "the performer's file differs from the one this transfer started with";
    }
    return "";
  }

  private async onOffer(m: XMsg): Promise<void> {
    const c = this.conn!;
    const j = this.jobs.get(c.take)!;
    const bad = this.checkOffer(j, m);
    if (bad) {
      this.abortConn(bad, ErrorCode.TransferRefused);
      return this.fail(j, `offer refused: ${bad}`);
    }
    j.offer = { ...m, data: new Uint8Array(0) };
    j.v.bytesTotal = m.fileBytes;
    j.v.chunksTotal = m.chunkCount;
    j.v.chunkBytes = m.chunkBytes;
    j.v.sha256Hex = toHex(m.fileSha);
    const tag = takeTag(j.v.takeId);
    try { fs.mkdirSync(j.paths.dir, { recursive: true }); } catch { /* reported below if it matters */ }
    if (fs.existsSync(j.paths.finalWav)) {
      try {
        const have = await sha256File(j.paths.finalWav);
        if (this.conn !== c) return;
        if (have.bytes === m.fileBytes && bytesEqual(have.digest, m.fileSha) && !this.checkWav(j, j.paths.finalWav)) {
          c.x.send(xmsg(XType.Result, { takeId: j.v.takeId, code: 0, already: true, text: "an identical verified copy already exists; nothing was rewritten" }));
          this.finishConn();
          Object.assign(j.v, { state: "verified", alreadyVerified: true, bytesDone: m.fileBytes, chunksDone: m.chunkCount, file: j.paths.finalWav, detail: "an identical verified copy already exists; nothing was rewritten", finishedNs: this.clock.nowNs() });
          this.history(`${tag}duplicate request: identical verified copy already present (SHA-256 ${j.v.sha256Hex})`);
          return;
        }
      } catch { /* fall through to the refusal */ }
      const why = `a different file already exists for this take (${j.paths.finalWav}); it was not overwritten`;
      this.abortConn(why, ErrorCode.TransferRefused);
      return this.fail(j, why);
    }
    let free = Number.MAX_SAFE_INTEGER;
    try { free = fs.statfsSync(j.paths.dir).bavail * fs.statfsSync(j.paths.dir).bsize; } catch { /* unknown: do not block */ }
    if (free < m.fileBytes + (1 << 20)) {
      this.abortConn("not enough disk space on the producer PC", ErrorCode.DiskSpace);
      return this.fail(j, `not enough disk space for ${m.fileBytes} bytes`);
    }
    let next = 0;
    const jr = this.readJournal(j.paths.journal);
    const partialExists = fs.existsSync(j.paths.partial);
    if (partialExists && jr && jr.sessionId === this.p.sessionId && jr.takeId === j.v.takeId && jr.fileBytes === m.fileBytes && jr.sha256 === j.v.sha256Hex && jr.chunkBytes === m.chunkBytes) {
      const onDisk = fs.statSync(j.paths.partial).size;
      next = Math.min(jr.chunksDone, Math.floor(onDisk / m.chunkBytes), m.chunkCount);
    } else if (partialExists) {
      const aside = this.setAside(j.paths.partial, "stale");
      this.history(`${tag}an unrelated partial file was set aside (${aside}); starting from chunk 0`);
    }
    try {
      j.fd = fs.openSync(j.paths.partial, fs.existsSync(j.paths.partial) ? "r+" : "w+");
      fs.ftruncateSync(j.fd, next * m.chunkBytes);
    } catch (e) {
      this.abortConn("producer cannot write the copy", ErrorCode.DiskWrite);
      return this.fail(j, (e as Error).message);
    }
    j.next = next;
    j.discarding = false;
    j.sameChunkRejects = 0;
    j.sinceAck = 0;
    this.persist(j);
    c.x.send(xmsg(XType.Resume, { takeId: j.v.takeId, nextChunk: next, code: 0 }));
    c.phase = "receiving";
    j.v.state = "transferring";
    j.v.resumedFromChunk = next;
    if (next > 0) j.v.resumes++;
    j.v.chunksDone = next;
    j.v.bytesDone = Math.min(next * m.chunkBytes, m.fileBytes);
    j.v.detail = next > 0 ? `resumed from chunk ${next}` : "receiving";
    this.history(tag + (next > 0 ? `RESUMED from chunk ${next} of ${m.chunkCount}` : `started: ${m.fileBytes} bytes in ${m.chunkCount} chunks, '${displaySafeName(m.name)}'`));
    this.log.log("info", "transfer", next > 0 ? "resumed" : "started", "offer accepted", { take: j.v.takeId, bytes: m.fileBytes, chunks: m.chunkCount, from_chunk: next, sha256: j.v.sha256Hex });
  }

  private onChunk(m: XMsg): void {
    const c = this.conn!;
    const j = this.jobs.get(c.take)!;
    const offer = j.offer!;
    if (j.discarding && m.index !== j.next) return; // still in flight from before the NACK
    j.discarding = false;
    if (m.index !== j.next || j.next >= offer.chunkCount) return this.connectionLost(`chunk ${m.index} out of order`, ErrorCode.ProtocolMalformed);
    const offset = m.index * offer.chunkBytes;
    const want = Math.min(offer.chunkBytes, offer.fileBytes - offset);
    const ok = m.data.length === want && bytesEqual(sha256Bytes(m.data), m.chunkSha);
    if (!ok) {
      j.v.chunkRejects++;
      j.sameChunkRejects++;
      this.history(`${takeTag(j.v.takeId)}chunk ${m.index} failed its SHA-256 check; asked again`);
      this.log.log("warn", "transfer", "chunk_rejected", "chunk hash mismatch", { take: j.v.takeId, chunk: m.index });
      if (j.sameChunkRejects >= this.p.maxSameChunkRejects) {
        this.persist(j);
        this.abortConn("chunk failed its check repeatedly", ErrorCode.TransferHashMismatch);
        return this.fail(j, `chunk ${m.index} failed its SHA-256 check ${j.sameChunkRejects} times`);
      }
      c.x.send(xmsg(XType.Nack, { nextChunk: j.next, code: ErrorCode.TransferHashMismatch }));
      j.discarding = true;
      return;
    }
    try {
      fs.writeSync(j.fd!, m.data, 0, m.data.length, offset);
    } catch (e) {
      this.abortConn("producer cannot write the copy", ErrorCode.DiskWrite);
      return this.fail(j, (e as Error).message);
    }
    j.next++;
    j.sameChunkRejects = 0;
    j.sinceAck++;
    c.chunksThisConn++;
    j.v.chunksDone = j.next;
    j.v.bytesDone = Math.min(j.next * offer.chunkBytes, offer.fileBytes);
    if (j.sinceAck >= this.p.ackEveryChunks || j.next === offer.chunkCount) {
      this.persist(j);
      c.x.send(xmsg(XType.Ack, { nextChunk: j.next }));
      j.sinceAck = 0;
    }
    if (this.testDropAfter !== 0 && c.chunksThisConn === this.testDropAfter) {
      this.testDropAfter = 0;
      this.history(`${takeTag(j.v.takeId)}TEST: producer drops the transfer connection`);
      this.connectionLost("test: connection dropped by the producer");
    }
  }

  private async onDone(m: XMsg): Promise<void> {
    const c = this.conn!;
    const j = this.jobs.get(c.take)!;
    if (j.discarding) return; // sent before our NACK arrived; a new DONE follows the resent chunks
    if (m.takeId !== j.v.takeId || j.next !== j.offer!.chunkCount) return this.connectionLost("DONE before all chunks arrived", ErrorCode.ProtocolMalformed);
    this.persist(j);
    this.closeFd(j);
    c.phase = "verifying";
    j.verifying = true;
    j.v.state = "verifying";
    j.v.detail = "checking SHA-256 of the file on disk and the WAV structure";
    this.history(`${takeTag(j.v.takeId)}all ${j.offer!.chunkCount} chunks received; VERIFYING`);
    const res = xmsg(XType.Result, { takeId: j.v.takeId });
    await this.verify(j, res);
    j.verifying = false;
    if (this.conn === c) {
      c.x.send(res);
      this.finishConn();
    }
  }

  /** Returns "" when the file is a complete float32 WAV matching the offer, else the reason. */
  private checkWav(j: Job, file: string): string {
    const offer = j.offer!;
    let info;
    try {
      const { head, size } = readHead(file);
      info = inspectWav(head, size);
    } catch (e) {
      return `cannot read the WAV: ${(e as Error).message}`;
    }
    let bad = "";
    if (!info.ok) bad = `not a complete float32 WAV${info.problems.map((p) => `; ${p}`).join("")}`;
    else if (info.sampleRate !== offer.sampleRate || info.channels !== offer.channels) bad = "WAV format differs from the offer";
    else if (info.frames !== offer.frames) bad = `WAV has ${info.frames} frames, the offer said ${offer.frames}`;
    else if (j.expectedFrames !== 0 && info.frames !== j.expectedFrames) bad = `WAV has ${info.frames} frames, TAKE_FINALISED said ${j.expectedFrames}`;
    if (!bad) {
      j.v.sampleRate = info.sampleRate;
      j.v.channels = info.channels;
      j.v.bits = info.bits;
      j.v.frames = info.frames;
      j.v.durationS = info.sampleRate ? info.frames / info.sampleRate : 0;
      j.v.framesVsReport = j.expectedFrames === 0 ? "no report" : "match";
    }
    return bad;
  }

  private setAside(file: string, why: string): string {
    for (let n = 1; n < 1000; n++) {
      const target = `${file}.${why}-${n}`;
      if (!fs.existsSync(target)) {
        try { fs.renameSync(file, target); return target; } catch { return file; }
      }
    }
    return file;
  }

  private async verify(j: Job, res: XMsg): Promise<void> {
    const offer = j.offer!;
    const tag = takeTag(j.v.takeId);
    let have: { digest: Uint8Array; bytes: number };
    try {
      have = await sha256File(j.paths.partial);
    } catch (e) {
      res.code = ErrorCode.DiskWrite;
      res.text = `producer could not read back the copy: ${(e as Error).message}`;
      return this.fail(j, res.text);
    }
    if (have.bytes !== offer.fileBytes || !bytesEqual(have.digest, offer.fileSha)) {
      j.v.hashFailures++;
      const aside = this.setAside(j.paths.partial, "rejected");
      try { fs.rmSync(j.paths.journal, { force: true }); } catch { /* bookkeeping only */ }
      j.next = 0;
      res.code = ErrorCode.TransferHashMismatch;
      res.text = `whole-file SHA-256 mismatch: expected ${toHex(offer.fileSha)}, got ${toHex(have.digest)} (${have.bytes} bytes)`;
      this.log.log("warn", "transfer", "hash_mismatch", res.text, { take: j.v.takeId, set_aside: aside });
      if (j.v.hashFailures >= this.p.maxHashFailures) {
        this.fail(j, `${res.text}; rejected copy kept as ${aside}`);
      } else {
        j.v.state = "retrying";
        j.v.detail = `${res.text}; the performer will send the file again`;
        j.retryDeadlineNs = this.clock.nowNs() + msToNs(this.p.resumeWaitMs);
        this.history(`${tag}SHA-256 MISMATCH, rejected copy kept as ${aside}; retrying from the start`);
      }
      return;
    }
    const bad = this.checkWav(j, j.paths.partial);
    if (bad) {
      const aside = this.setAside(j.paths.partial, "rejected");
      try { fs.rmSync(j.paths.journal, { force: true }); } catch { /* bookkeeping only */ }
      res.code = ErrorCode.TransferInvalidFile;
      res.text = `hash matched but the WAV check failed: ${bad}`;
      return this.fail(j, `${res.text}; kept as ${aside}`);
    }
    try {
      // link + unlink = rename that refuses to replace an existing file
      fs.linkSync(j.paths.partial, j.paths.finalWav);
      fs.unlinkSync(j.paths.partial);
    } catch (e) {
      res.code = ErrorCode.TransferRefused;
      res.text = `could not move the copy to its final name without replacing a file: ${(e as Error).message}`;
      return this.fail(j, res.text);
    }
    try { fs.rmSync(j.paths.journal, { force: true }); } catch { /* bookkeeping only */ }
    Object.assign(j.v, { file: j.paths.finalWav, bytesDone: have.bytes, state: "verified", finishedNs: this.clock.nowNs(), detail: "SHA-256 and WAV checks passed" });
    try {
      fs.writeFileSync(j.paths.record, JSON.stringify({
        what: "verified copy of the performer's take (the original stays on the performer's PC)",
        session_id: this.p.sessionId, take_id: j.v.takeId, file: path.basename(j.paths.finalWav), name_sent_by_performer: displaySafeName(offer.name),
        bytes: have.bytes, sha256: j.v.sha256Hex, sha256_checked_on: "bytes on the producer's disk after the transfer", sample_rate: j.v.sampleRate,
        channels: j.v.channels, bits: j.v.bits, frames: j.v.frames, duration_s: Number(j.v.durationS.toFixed(3)), frames_vs_take_finalised: j.v.framesVsReport,
        chunks: offer.chunkCount, chunk_bytes: offer.chunkBytes, connections: j.v.connections, resumes: j.v.resumes, chunk_rejects: j.v.chunkRejects,
        hash_failures: j.v.hashFailures, verified_utc: new Date().toISOString(),
      }, null, 2));
    } catch (e) {
      this.history(`${tag}note: transfer record not written: ${(e as Error).message}`);
    }
    res.code = 0;
    res.text = `SHA-256 ${j.v.sha256Hex} matched; WAV ${j.v.frames} frames, ${j.v.sampleRate} Hz, ${j.v.channels} ch`;
    this.history(`${tag}VERIFIED: ${j.v.file} (${have.bytes} bytes, SHA-256 ${j.v.sha256Hex}, ${j.v.frames} frames = ${j.v.durationS.toFixed(3)} s, ${j.v.sampleRate} Hz, ${j.v.channels} ch float32)`);
    this.log.log("info", "transfer", "verified", "copy verified", { take: j.v.takeId, bytes: have.bytes, sha256: j.v.sha256Hex, frames: j.v.frames, connections: j.v.connections, resumes: j.v.resumes });
  }

  private timers(): void {
    const now = this.clock.nowNs();
    const c = this.conn;
    if (c) {
      if ((c.phase === "await-hello" || c.phase === "await-offer") && now > c.deadlineNs) {
        if (c.phase === "await-hello") this.abortConn("no HELLO", ErrorCode.Timeout);
        else this.connectionLost("no OFFER in time");
      } else if (c.phase === "receiving" && now - c.lastRxNs > msToNs(this.p.idleTimeoutMs)) {
        this.connectionLost(`no data for ${this.p.idleTimeoutMs / 1000} s`);
      }
    }
    for (const j of this.jobs.values()) {
      const busyHere = this.conn?.take === j.v.takeId;
      if ((j.v.state === "queued" || j.v.state === "retrying") && !busyHere && !j.verifying && now > j.retryDeadlineNs) {
        this.fail(j, j.v.state === "queued" ? `the performer did not start sending within ${this.p.resumeWaitMs / 1000} s` : `the performer did not resume within ${this.p.resumeWaitMs / 1000} s`);
      }
    }
  }
}

// =================================================================================================
// Performer side
// =================================================================================================

export interface SendJob {
  host: string;
  port: number;
  sessionId: string;
  /** one-time, from TRANSFER_REQUEST; never logged */
  token: string;
  takeId: number;
  /** the finalised original (never modified) */
  file: string;
  takeStatus: number;
}

export interface SenderParams {
  chunkBytes?: number;
  connectTimeoutMs?: number;
  replyTimeoutMs?: number;
  retryIntervalMs?: number;
  giveUpAfterMs?: number;
  maxHashRestarts?: number;
  maxQueuedBytes?: number;
  clock?: Clock;
}

type Outcome = "verified" | "hash-mismatch" | "failed" | "lost";

export class TakeSender {
  private p: Required<Omit<SenderParams, "clock">>;
  private clock: Clock;
  private views = new Map<number, TransferView>();
  private lines: string[] = [];
  private stopFlag = false;
  private isBusy = false;
  private current: Promise<void> | null = null;
  private activeConn: XConn | null = null;
  // test hooks
  private testDropAfter = 0;
  private testCorruptChunk = 0;

  constructor(params: SenderParams = {}, private log: Logger = nullLogger) {
    this.clock = params.clock ?? systemClock;
    this.p = {
      chunkBytes: params.chunkBytes ?? DEFAULT_CHUNK_BYTES, connectTimeoutMs: params.connectTimeoutMs ?? 5000, replyTimeoutMs: params.replyTimeoutMs ?? 10000,
      retryIntervalMs: params.retryIntervalMs ?? 1000, giveUpAfterMs: params.giveUpAfterMs ?? 60000, maxHashRestarts: params.maxHashRestarts ?? 1,
      maxQueuedBytes: params.maxQueuedBytes ?? 256 * 1024,
    };
  }

  get busy(): boolean { return this.isBusy; }
  testDropAfterChunks(n: number): void { this.testDropAfter = n; }
  testCorruptChunkIndex(i: number): void { this.testCorruptChunk = i + 1; }

  /** Returns "" when sending has started, otherwise the reason it could not. */
  start(job: SendJob): string {
    if (this.isBusy) return "another take is being sent";
    const v = newView(job.takeId);
    v.file = job.file;
    v.detail = "preparing";
    this.views.set(job.takeId, v);
    this.stopFlag = false;
    this.isBusy = true;
    this.current = this.run(job).catch((e) => {
      this.log.log("error", "transfer", "send_crashed", String(e), { take: job.takeId });
      v.state = "failed";
      v.detail = `internal error: ${(e as Error).message}`;
      this.isBusy = false;
    });
    return "";
  }

  async stop(): Promise<void> {
    this.stopFlag = true;
    this.activeConn?.close();
    await this.current;
  }

  transfers(): TransferView[] {
    return [...this.views.values()].map((v) => ({ ...v })).sort((a, b) => a.takeId - b.takeId);
  }
  takeHistory(): string[] {
    const out = this.lines;
    this.lines = [];
    return out;
  }
  private history(line: string): void {
    this.lines.push(`${hhmmss()}  ${line}`);
    if (this.lines.length > 500) this.lines.shift();
  }
  private publish(v: TransferView): void {
    this.views.set(v.takeId, v);
  }

  private connect(host: string, port: number): Promise<{ sock: net.Socket } | { error: string }> {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      const t = setTimeout(() => { sock.destroy(); resolve({ error: "timed out" }); }, this.p.connectTimeoutMs);
      sock.once("connect", () => { clearTimeout(t); resolve({ sock }); });
      sock.once("error", (e) => { clearTimeout(t); resolve({ error: e.message }); });
      sock.connect({ host, port });
    });
  }

  private async run(job: SendJob): Promise<void> {
    const tag = `take ${job.takeId} send: `;
    const v = newView(job.takeId);
    v.file = job.file;
    v.startedNs = this.clock.nowNs();
    v.detail = "checking the file and computing its SHA-256";
    this.publish(v);
    let fh: fs.promises.FileHandle | null = null;
    const finish = async (st: TransferState, detail: string) => {
      // The original must be exactly as it was: hash it again through the same read-only handle.
      if (fh && v.sha256Hex) {
        try {
          const after = await sha256File(job.file);
          v.sourceShaAfterHex = toHex(after.digest);
          v.sourceUnchanged = v.sourceShaAfterHex === v.sha256Hex;
        } catch { /* reported as not unchanged below */ }
      }
      await fh?.close().catch(() => {});
      v.state = st;
      v.detail = detail;
      v.finishedNs = this.clock.nowNs();
      this.publish(v);
      this.history(`${tag}${st}: ${detail}${v.sourceShaAfterHex ? `; original ${v.sourceUnchanged ? "unchanged" : "CHANGED"} (SHA-256 after ${v.sourceShaAfterHex})` : ""}`);
      this.log.log(st === "verified" ? "info" : "warn", "transfer", st === "verified" ? "send_verified" : "send_failed", detail, { take: job.takeId, sha256: v.sha256Hex, original_unchanged: v.sourceUnchanged, connections: v.connections });
      this.isBusy = false;
    };

    let info: fs.Stats;
    try {
      fh = await fs.promises.open(job.file, "r");
      info = await fh.stat();
    } catch (e) {
      return finish("failed", `cannot open the take: ${(e as Error).message}`);
    }
    const head = Buffer.alloc(Math.min(4096, info.size));
    await fh.read(head, 0, head.length, 0);
    const w = inspectWav(new Uint8Array(head), info.size);
    if (!w.ok) return finish("failed", "not a finalised float32 WAV; nothing was sent");
    let src: Uint8Array;
    try {
      src = (await sha256File(job.file)).digest;
    } catch (e) {
      return finish("failed", `cannot hash the take: ${(e as Error).message}`);
    }
    const cb = this.p.chunkBytes;
    const offer = xmsg(XType.Offer, {
      takeId: job.takeId, fileBytes: info.size, chunkBytes: cb, chunkCount: chunkCountFor(info.size, cb), fileSha: src, formatTag: w.formatTag === 0xfffe ? 0xfffe : 3,
      bits: w.bits, channels: w.channels, sampleRate: w.sampleRate, frames: w.frames, takeStatus: job.takeStatus, name: path.basename(job.file),
    });
    v.sha256Hex = toHex(src);
    v.bytesTotal = info.size;
    v.chunkBytes = cb;
    v.chunksTotal = offer.chunkCount;
    v.frames = offer.frames;
    v.sampleRate = offer.sampleRate;
    v.channels = offer.channels;
    v.detail = "connecting to the producer";
    this.publish(v);
    this.history(`${tag}QUEUED: ${v.bytesTotal} bytes, SHA-256 ${v.sha256Hex} (original opened read-only)`);

    let restarts = 0;
    let troubleSince = 0;
    const buf = Buffer.alloc(cb);
    while (!this.stopFlag) {
      const now = this.clock.nowNs();
      if (troubleSince !== 0 && now - troubleSince > msToNs(this.p.giveUpAfterMs)) {
        return finish("failed", `could not complete the transfer for ${this.p.giveUpAfterMs / 1000} s; last problem: ${v.detail}`);
      }
      const c = await this.connect(job.host, job.port);
      if ("error" in c) {
        if (troubleSince === 0) troubleSince = now;
        v.state = "retrying";
        v.detail = `cannot reach the producer (${c.error}); retrying`;
        this.publish(v);
        await sleep(this.p.retryIntervalMs);
        continue;
      }
      v.connections++;
      const x = new XConn(c.sock);
      this.activeConn = x;
      x.send(xmsg(XType.Hello, { sessionId: job.sessionId, token: job.token, takeId: job.takeId }));
      x.send(offer);

      let out: Outcome = "lost";
      let why = "";
      let already = false;
      let resumed = false;
      let nextSend = 0;
      let doneSent = false;
      let sentHere = 0;
      let dropAt = 0;
      let acked = 0;
      let lastRx = this.clock.nowNs();
      const resultWait = msToNs(this.p.replyTimeoutMs) + Math.floor(v.bytesTotal / (20 * 1024 * 1024)) * 1e9;
      while (!this.stopFlag) {
        if (resumed) {
          while (dropAt === 0 && !doneSent && nextSend < offer.chunkCount && x.pendingOut < this.p.maxQueuedBytes) {
            const off = nextSend * cb;
            const want = Math.min(cb, v.bytesTotal - off);
            const r = await fh.read(buf, 0, want, off);
            if (r.bytesRead !== want) {
              why = "cannot read the take: short read";
              out = "failed";
              break;
            }
            const data = new Uint8Array(buf.subarray(0, want));
            const chunkSha = sha256Bytes(data);
            if (this.testCorruptChunk === nextSend + 1) {
              data[Math.floor(data.length / 2)]! ^= 1; // TEST: damaged after hashing
              this.testCorruptChunk = 0;
              this.history(`${tag}TEST: chunk ${nextSend} damaged after hashing`);
            }
            x.send(xmsg(XType.Chunk, { index: nextSend, data, chunkSha }));
            nextSend++;
            sentHere++;
            if (this.testDropAfter !== 0 && sentHere === this.testDropAfter) {
              this.testDropAfter = 0;
              dropAt = this.clock.nowNs() + msToNs(2000);
            }
          }
          if (out === "failed") break;
          if (dropAt !== 0 && ((x.pendingOut === 0 && acked + 8 >= nextSend) || this.clock.nowNs() > dropAt)) {
            this.history(`${tag}TEST: performer drops the connection after ${sentHere} chunks (${acked} acknowledged)`);
            x.close();
            why = "test: connection dropped by the performer";
            out = "lost";
            break;
          }
          if (!doneSent && nextSend === offer.chunkCount) {
            x.send(xmsg(XType.Done, { takeId: job.takeId }));
            doneSent = true;
            v.state = "verifying";
            v.detail = "all chunks sent; the producer is verifying";
            this.publish(v);
          }
        }
        await x.activity(resumed && nextSend < offer.chunkCount ? 1 : 20);
        let end = false;
        while (x.inbox.length) {
          const m = x.inbox.shift()!;
          lastRx = this.clock.nowNs();
          if (m.type === XType.Resume && !resumed) {
            if (m.code !== 0) { why = `producer refused: ${m.text}`; out = "failed"; end = true; break; }
            if (m.nextChunk > offer.chunkCount) { why = "producer asked for a chunk beyond the end"; out = "failed"; end = true; break; }
            resumed = true;
            nextSend = m.nextChunk;
            v.resumedFromChunk = nextSend;
            if (nextSend > 0) v.resumes++;
            v.chunksDone = nextSend;
            v.state = "transferring";
            v.detail = nextSend > 0 ? `resumed from chunk ${nextSend}` : "sending";
            this.publish(v);
            this.history(tag + (nextSend > 0 ? `RESUMING from chunk ${nextSend}` : "TRANSFERRING"));
            troubleSince = 0;
          } else if (m.type === XType.Ack) {
            acked = m.nextChunk;
            v.chunksDone = Math.min(m.nextChunk, offer.chunkCount);
            v.bytesDone = Math.min(v.chunksDone * cb, v.bytesTotal);
            troubleSince = 0;
            this.publish(v);
          } else if (m.type === XType.Nack) {
            v.chunkRejects++;
            this.history(`${tag}producer rejected chunk ${m.nextChunk}; sending again from there`);
            nextSend = Math.min(m.nextChunk, offer.chunkCount);
            doneSent = false;
            v.state = "transferring";
          } else if (m.type === XType.Result) {
            out = m.code === 0 ? "verified" : m.code === ErrorCode.TransferHashMismatch ? "hash-mismatch" : "failed";
            already = m.already;
            why = m.text;
            end = true;
            break;
          } else if (m.type === XType.Abort) {
            why = `producer: ${m.text}`;
            out = m.code === ErrorCode.Busy ? "lost" : "failed";
            end = true;
            break;
          }
        }
        if (end) break;
        if (x.closed && !x.inbox.length) {
          why = x.error;
          out = "lost";
          break;
        }
        const quiet = this.clock.nowNs() - lastRx;
        if (!doneSent && quiet > msToNs(this.p.replyTimeoutMs)) { why = `no reply from the producer for ${this.p.replyTimeoutMs / 1000} s`; out = "lost"; break; }
        if (doneSent && quiet > resultWait) { why = "no verification result from the producer"; out = "lost"; break; }
      }
      this.activeConn = null;
      if (this.stopFlag) {
        x.close();
        return finish("failed", "stopped on this PC before the producer verified the copy");
      }
      switch (out) {
        case "verified":
          x.closeAfterFlush(200);
          v.alreadyVerified = already;
          v.bytesDone = v.bytesTotal;
          v.chunksDone = v.chunksTotal;
          return finish("verified", `the producer verified the copy${already ? " (it already had an identical one)" : ""}: ${why}`);
        case "hash-mismatch":
          x.closeAfterFlush(200);
          v.hashFailures++;
          if (restarts < this.p.maxHashRestarts) {
            restarts++;
            v.state = "retrying";
            v.detail = "producer found a whole-file SHA-256 mismatch; sending again from the start";
            this.publish(v);
            this.history(`${tag}producer reported SHA-256 MISMATCH (${why}); sending again`);
            continue;
          }
          return finish("failed", `whole-file SHA-256 mismatch again: ${why}`);
        case "failed":
          x.closeAfterFlush(200);
          return finish("failed", why);
        case "lost":
          x.close();
          if (troubleSince === 0) troubleSince = this.clock.nowNs();
          v.state = "retrying";
          v.detail = `connection lost (${why}); retrying`;
          this.publish(v);
          this.history(`${tag}PAUSED: ${why}; retrying in ${this.p.retryIntervalMs} ms`);
          await sleep(this.p.retryIntervalMs);
          continue;
      }
    }
    return finish("failed", "stopped on this PC before the producer verified the copy");
  }
}
