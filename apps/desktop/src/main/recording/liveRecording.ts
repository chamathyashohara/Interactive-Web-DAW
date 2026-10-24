import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { media, type Role } from "@daw/recording";
import { ticksToSeconds } from "@daw/shared";

type ReceiverReport = media.ReceiverReport;
import {
  BackingServer, CaptureRecorderPort, JsonlFileLogger, MediaEndpoint, SessionController, VocalProducerPort, downloadBacking, sha256OfFile,
  type ControllerSnapshot, type EndpointStats, type IncomingAudio, type PortTakeSpec, type RecorderPort, type TransferView,
  teeLogger, type Logger, MemoryLogger,
} from "@daw/recording/node";

/** A network address the Producer can offer the session on. */
export interface NetIface {
  name: string;
  address: string;
  /** a plain-English hint: "this PC only", "Wi-Fi / Ethernet" */
  label: string;
}

/** One recording the user can put in the project: their own take, or a verified copy of the singer's. */
export interface SessionTake {
  key: string;
  takeId: number;
  kind: "mine" | "singer-copy";
  label: string;
  file: string;
  seconds: number;
  /** a copy is only offered once VERIFIED; a local take once it is finalised */
  ready: boolean;
  /** vocal over a backing track: the song position the take was recorded from, and what the DAW needs to put it back on the music */
  vocal: boolean;
  startTick: number;
  tempo: number;
  latencyUs: number;
  lateFrames: number;
}

export type BackingPhase = "off" | "waiting" | "rendering" | "sending" | "downloading" | "decoding" | "ready" | "error";
export interface BackingStatus {
  phase: BackingPhase;
  detail: string;
  /** length of the rendered song, seconds */
  seconds: number;
  bytes: number;
  /** 0..1 while downloading */
  progress: number;
  /** producer: the arrangement changed since the backing track on the singer's PC was rendered */
  stale: boolean;
}

export interface LiveState {
  role: Role | null;
  snapshot: ControllerSnapshot | null;
  capture: { open: boolean; device: string; level: number; blocks: number; sampleRate: number; failed: string };
  media: EndpointStats | null;
  talkback: { send: boolean; hear: boolean };
  takes: SessionTake[];
  recordingsRoot: string;
  history: string[];
  error: string;
  /** "vocal": the singer sings over the producer's song and only the singer is recorded */
  mode: "both" | "vocal";
  backing: BackingStatus;
  /** the producer's Play button also plays the song for the singer */
  syncPlay: boolean;
  /** producer: the song position (ticks) Record would start from */
  startTick: number;
}

/** What the service needs from the rest of the DAW (the project, the audio engine and its transport). */
export interface LiveHost {
  engineReady(): boolean;
  /** Renders the audible arrangement without the "Vocal take" tracks to a WAV file. Not while playing. */
  renderBacking(): Promise<{ ok: true; file: string; seconds: number } | { ok: false; reason: string }>;
  /** Changes whenever what the singer should hear changes (vocal take tracks do not count). */
  fingerprint(): string;
  tick(): number;
  playing(): boolean;
  tempo(): number;
  play(): void;
  stop(): void;
  seek(tick: number): void;
}

export interface LiveServiceOptions {
  /** where takes are written (the watched folder, so they also show up in the Recordings list) */
  recordingsRoot: string;
  /** where backing tracks are rendered (producer) and downloaded (singer) */
  backingDir: string;
  logFile: string;
  appVersion: string;
  onState: (s: LiveState) => void;
  /** sends decoded-side traffic to the renderer */
  toRenderer: (channel: string, payload: unknown) => void;
  host?: LiveHost;
}

const EMPTY_CAPTURE = { open: false, device: "", level: 0, blocks: 0, sampleRate: 48000, failed: "" };
const NO_BACKING: BackingStatus = { phase: "off", detail: "", seconds: 0, bytes: 0, progress: 0, stale: false };

export function listInterfaces(): NetIface[] {
  const out: NetIface[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      const v4 = a.family === "IPv4" || (a.family as unknown) === 4;
      if (!v4 || a.internal || a.address.startsWith("169.254.")) continue; // 169.254.x is "no network"; nobody can reach it
      out.push({ name, address: a.address, label: `${name}${/wi-?fi|wlan|wireless/i.test(name) ? " (Wi-Fi)" : /eth/i.test(name) ? " (cable)" : ""}` });
    }
  }
  out.push({ name: "Loopback", address: "127.0.0.1", label: "This PC only (for trying it out alone)" });
  return out;
}

/** What is known about a take from the moment the producer pressed Record and from the singer's report. */
interface TakeNote {
  startTick: number;
  tempo: number;
  vocal: boolean;
  latencyUs: number;
  lateFrames: number;
}

/**
 * Remote recording inside the DAW (Component 4, ported to TypeScript). Owns the session controller, the local master recorder, the
 * live talkback socket and the plumbing to the window that captures and plays audio. The window decides nothing about timing: it
 * only streams microphone blocks here and plays what arrives.
 *
 * Vocal over a backing track (the default for a producer): the producer renders the arrangement to a WAV, the singer downloads and verifies it,
 * and from then on the singer plays it from disk on the same audio clock as the microphone, starting both on the same sample. Only the singer
 * is recorded; the recording is sent back, verified, and placed on its own track at the position it was recorded from.
 */
export class LiveRecordingService {
  private logger: Logger;
  readonly memLog = new MemoryLogger();
  readonly port: CaptureRecorderPort;
  private controller: SessionController | null = null;
  private endpoint: MediaEndpoint | null = null;
  private endpointKey = "";
  private role: Role | null = null;
  private mode: "both" | "vocal" = "both";
  private error = "";
  private send = false;
  private hear = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastJson = "";
  private autoTransfer = true;
  private name = os.userInfo().username || "";
  private syncPlayOn = true;

  // ---- backing track: producer ----
  private server: BackingServer | null = null;
  private rendering = false;
  private backingFp = "";
  private pendingFp = "";
  private pendingSince = 0;
  private retryAt = 0;
  private currentBackingFile = "";
  private producerBacking: BackingStatus = { ...NO_BACKING };
  private previewActive = false;
  private notes = new Map<number, TakeNote>();
  private pendingStartTick = 0;
  private scheduledTimers = new Set<ReturnType<typeof setTimeout>>();

  // ---- backing track: singer ----
  private haveId = "";
  private dlGen = 0;
  private singerBacking: BackingStatus = { ...NO_BACKING };

  constructor(private opts: LiveServiceOptions) {
    this.logger = teeLogger(new JsonlFileLogger(opts.logFile), this.memLog);
    this.port = new CaptureRecorderPort({ recordingsRoot: opts.recordingsRoot, logger: this.logger });
    this.port.onVocalSchedule = (o) => {
      this.opts.toRenderer("live:playBacking", { startFrame: o.startFrame, offsetSec: o.offsetUs / 1e6, takeId: o.takeId, id: o.backingId });
    };
    this.port.onVocalEnd = () => this.opts.toRenderer("live:stopBacking", null);
  }

  start(): void {
    fs.mkdirSync(this.opts.backingDir, { recursive: true });
    this.timer = setInterval(() => this.tick(), 200);
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.port.closeForShutdown(); // a take in progress is finalised, not left as a .partial
    this.endpoint?.stop();
    this.endpoint = null;
    this.server?.stop();
    this.server = null;
    this.scheduledTimers.forEach(clearTimeout);
    this.scheduledTimers.clear();
    await this.controller?.shutdown();
    this.controller = null;
  }

  setRecordingsRoot(dir: string): void {
    this.port.setRecordingsRoot(dir);
  }

  // ---- microphone plumbing (called from the window) ----

  captureState(s: { open: boolean; deviceName?: string; sampleRate?: number; channels?: number; failed?: string }): void {
    this.port.setCaptureState({ open: s.open, deviceName: s.deviceName ?? "", sampleRate: s.sampleRate ?? 48000, channels: s.channels ?? 1, failed: s.failed ?? "" });
    this.push(true);
  }
  capture(frame: number, samples: Float32Array): void {
    this.port.onCapture(frame, samples);
  }
  /** The window's measurement (or estimate) of the speaker-to-microphone round trip of this PC, microseconds. */
  setLatencyUs(us: number): void {
    this.port.setLatencyUs(us);
  }

  // ---- live talkback plumbing ----

  /** One Opus packet from the window's encoder. */
  liveSend(opus: Uint8Array, mediaIndex: number, muted: boolean): void {
    this.endpoint?.sendAudio(opus, mediaIndex, muted);
  }
  setTalkback(send: boolean, hear: boolean): void {
    this.send = send;
    this.hear = hear;
    this.endpoint?.setSending(send);
    this.endpoint?.setHearing(hear);
    this.push(true);
  }
  liveIncomingStats(r: Partial<ReceiverReport>): void {
    this.endpoint?.setIncomingReport(r);
  }

  // ---- session ----

  private makeController(role: Role, port: RecorderPort): SessionController {
    const c = new SessionController(
      {
        role, appVersion: this.opts.appVersion, displayName: this.name || (role === "producer" ? "Producer" : "Singer"), autoTransfer: this.autoTransfer,
        receivedRoot: path.join(this.port.recordingsRoot, "received"),
        hooks: role === "performer" ? this.singerHooks() : undefined,
      },
      port,
      this.logger,
    );
    c.startPolling(50);
    return c;
  }

  private async dispose(): Promise<void> {
    this.endpoint?.stop();
    this.endpoint = null;
    this.endpointKey = "";
    this.server?.stop();
    this.server = null;
    this.dlGen++;
    this.haveId = "";
    this.backingFp = "";
    this.pendingFp = "";
    this.producerBacking = { ...NO_BACKING };
    this.singerBacking = { ...NO_BACKING };
    this.previewActive = false;
    this.scheduledTimers.forEach(clearTimeout);
    this.scheduledTimers.clear();
    const c = this.controller;
    this.controller = null;
    this.role = null;
    this.seen.clear();
    this.notes.clear();
    this.opts.toRenderer("live:stopBacking", null);
    await c?.shutdown();
  }

  /**
   * Producer: open the session on one network address.
   * mode "vocal": the singer sings over the arrangement and only the singer is recorded; "both": each PC records its own microphone.
   */
  async createSession(opts: { bind: string; port: number; name?: string; mode?: "both" | "vocal" }): Promise<{ ok: boolean; reason?: string }> {
    await this.dispose();
    if (opts.name?.trim()) this.name = opts.name.trim();
    this.error = "";
    const host = this.opts.host;
    this.mode = opts.mode === "vocal" && host ? "vocal" : "both";
    const port: RecorderPort = this.mode === "vocal" && host
      ? new VocalProducerPort({
          engineReady: () => host.engineReady(),
          onStart: (spec) => this.onVocalTakeStart(spec),
          onEnd: (spec) => this.onVocalTakeEnd(spec),
        })
      : this.port;
    const c = this.makeController("producer", port);
    c.setMode(this.mode);
    const err = await c.createSession(opts.bind, opts.port);
    if (err) {
      void c.shutdown();
      this.error = err;
      this.push(true);
      return { ok: false, reason: err };
    }
    this.controller = c;
    this.role = "producer";
    if (this.mode === "vocal") {
      const server = new BackingServer(opts.bind, opts.port + 3, this.logger);
      const serr = await server.start();
      if (serr) {
        this.producerBacking = { ...NO_BACKING, phase: "error", detail: `The backing track cannot be shared: port ${opts.port + 3} is not available (${serr}).` };
      } else {
        this.server = server;
        this.producerBacking = { ...NO_BACKING, phase: "waiting", detail: "Waiting for the singer to join." };
      }
    }
    this.push(true);
    return { ok: true };
  }

  async join(opts: { host: string; port: number; code: string; name?: string }): Promise<{ ok: boolean; reason?: string }> {
    await this.dispose();
    if (opts.name?.trim()) this.name = opts.name.trim();
    this.error = "";
    const c = this.makeController("performer", this.port);
    const err = await c.join(opts.host, opts.port, opts.code);
    if (err) {
      void c.shutdown();
      this.error = err;
      this.push(true);
      return { ok: false, reason: err };
    }
    this.controller = c;
    this.role = "performer";
    this.push(true);
    return { ok: true };
  }

  async leave(): Promise<void> {
    const c = this.controller;
    if (c) {
      await c.leave();
      if (c.snapshot().lastError.startsWith("stop the take")) {
        this.error = c.snapshot().lastError;
        this.push(true);
        return;
      }
    }
    await this.dispose();
    this.push(true);
  }

  private act<T>(f: (c: SessionController) => T, none: T): T {
    const c = this.controller;
    const r = c ? f(c) : none;
    this.push(true);
    return r;
  }
  setConsent(on: boolean): void { this.act((c) => c.setConsent(on), undefined); }
  setDeliveryConsent(on: boolean): void { this.act((c) => c.setDeliveryConsent(on), undefined); }

  /** Producer: Record. In vocal mode this takes the song position from the engine's playhead. */
  record(): string {
    const c = this.controller;
    if (!c) return "start or join a session first";
    if (c.role === "producer" && this.mode === "vocal") {
      const host = this.opts.host!;
      if (this.isBackingStale()) return "The backing track is being updated because the arrangement changed. Try again in a moment.";
      if (this.previewActive) this.syncStop(); // Play and Record cannot overlap
      const tick = host.tick();
      const r = c.startTake({ offsetUs: Math.round(ticksToSeconds(tick, host.tempo()) * 1e6) });
      if (!r) {
        const id = c.snapshot().take.takeId;
        this.notes.set(id, { startTick: tick, tempo: host.tempo(), vocal: true, latencyUs: 0, lateFrames: 0 });
        this.pendingStartTick = tick;
      }
      this.push(true);
      return r;
    }
    const r = c.startTake();
    this.push(true);
    return r;
  }
  stop(): string { return this.act((c) => (c.role === "producer" ? c.stopTake() : c.stopAndSave()), "no session"); }
  newCode(): string { return this.act((c) => c.newPairingCode(), ""); }
  setLead(ms: number, auto: boolean): void { this.act((c) => { c.setStartLeadMs(ms); c.setAutoStartLead(auto); }, undefined); }
  setAutoTransfer(on: boolean): void {
    this.autoTransfer = on;
    this.act((c) => c.setAutoTransfer(on), undefined);
  }
  setSyncPlay(on: boolean): void {
    this.syncPlayOn = on;
    if (!on) this.syncStop();
    this.push(true);
  }
  async requestTransfer(takeId: number): Promise<string> {
    const c = this.controller;
    const r = c ? await c.requestTransfer(takeId) : "no session";
    this.push(true);
    return r;
  }
  cancelTransfer(takeId: number): void { this.act((c) => c.cancelTransfer(takeId), undefined); }

  // ---- producer: the arrangement plays with the singer (the Play button) ----

  private isBackingStale(): boolean {
    const host = this.opts.host;
    if (!host || this.mode !== "vocal") return false;
    return this.backingFp !== host.fingerprint() || this.rendering;
  }

  private canSyncPlay(): boolean {
    const c = this.controller;
    return !!c && c.role === "producer" && this.mode === "vocal" && this.syncPlayOn && c.snapshot().link === 4 && c.peerHasBacking && !this.isBackingStale();
  }

  /** The DAW's Play button. Returns true when the singer was told and the engine will start at the shared moment; false = play locally right now. */
  syncPlay(): boolean {
    const host = this.opts.host;
    const c = this.controller;
    if (!host || !c || !this.canSyncPlay()) return false;
    if (host.playing()) return false;
    const tick = host.tick();
    const res = c.playBacking(Math.round(ticksToSeconds(tick, host.tempo()) * 1e6));
    if (res.error) {
      this.error = `The singer will not hear this: ${res.error}`;
      this.push(true);
      return false;
    }
    this.error = "";
    this.previewActive = true;
    this.atClock(res.startAtNs, () => {
      host.seek(tick);
      host.play();
    });
    this.push(true);
    return true;
  }

  /** The DAW's Stop button: ends the singer's playback too. */
  syncStop(): void {
    // A start that is still waiting for the shared moment must not happen after Stop was pressed.
    this.scheduledTimers.forEach(clearTimeout);
    this.scheduledTimers.clear();
    if (!this.previewActive) return;
    this.previewActive = false;
    this.controller?.stopBacking();
  }

  /** The DAW's seek while playing for the singer: both restart from the new position. */
  syncSeek(): void {
    if (!this.previewActive) return;
    this.syncStop();
    this.opts.host?.stop();
    setTimeout(() => this.syncPlay(), 30);
  }

  private atClock(ns: number, f: () => void): void {
    const delay = Math.max(0, (ns - performance.now() * 1e6) / 1e6);
    const t = setTimeout(() => {
      this.scheduledTimers.delete(t);
      f();
    }, delay);
    this.scheduledTimers.add(t);
  }

  private onVocalTakeStart(spec: PortTakeSpec): void {
    const host = this.opts.host;
    if (!host) return;
    const startTick = this.notes.get(spec.takeId)?.startTick ?? this.pendingStartTick;
    host.stop();
    host.seek(startTick);
    host.play();
  }

  private onVocalTakeEnd(spec: PortTakeSpec): void {
    const host = this.opts.host;
    if (!host) return;
    const startTick = this.notes.get(spec.takeId)?.startTick ?? this.pendingStartTick;
    host.stop();
    host.seek(startTick); // ready for another take from the same place
  }

  // ---- producer: render and deliver the backing track ----

  private async maintainBacking(s: ControllerSnapshot): Promise<void> {
    const host = this.opts.host;
    const c = this.controller;
    if (!host || !c || this.mode !== "vocal" || !this.server) return;
    const connected = s.link === 4;
    this.server.setAllowedPeer(s.peerAddress);
    if (!connected) {
      if (this.producerBacking.phase !== "error") this.producerBacking = { ...this.producerBacking, phase: this.backingFp ? "ready" : "waiting", detail: this.backingFp ? "The singer is not connected." : "Waiting for the singer to join." };
      return;
    }
    if (!c.peerSupportsBacking) {
      this.producerBacking = { ...NO_BACKING, phase: "error", detail: "The singer's app is too old to play a backing track. Update it, or use \"both record\" mode." };
      return;
    }
    const fp = host.fingerprint();
    const busy = s.session === 2 || s.session === 3 || s.session === 4 || s.session === 5 || s.session === 6; // Armed .. Finalising
    if (this.rendering) return;
    if (fp === this.backingFp) {
      const have = c.peerHasBacking;
      this.producerBacking = { ...this.producerBacking, phase: have ? "ready" : "sending", stale: false, detail: have ? "The singer has the current backing track." : "Sending the backing track to the singer…" };
      return;
    }
    // The arrangement changed (or this is the first time): wait until it has been still for a moment, and nothing is playing or recording.
    if (fp !== this.pendingFp) {
      this.pendingFp = fp;
      this.pendingSince = Date.now();
    }
    this.producerBacking = { ...this.producerBacking, stale: !!this.backingFp, phase: this.backingFp ? this.producerBacking.phase : "waiting", detail: this.backingFp ? "The arrangement changed; updating the backing track…" : "Preparing the backing track…" };
    if (Date.now() - this.pendingSince < 1500 || host.playing() || busy || Date.now() < this.retryAt) return;
    this.rendering = true;
    this.producerBacking = { ...this.producerBacking, phase: "rendering", detail: "Rendering the backing track from your arrangement…", stale: true };
    this.push(true);
    try {
      const r = await host.renderBacking();
      if (!r.ok) {
        this.retryAt = Date.now() + 5000;
        this.producerBacking = { ...NO_BACKING, phase: "error", detail: `The backing track could not be rendered: ${r.reason}` };
        return;
      }
      const id = await sha256OfFile(r.file);
      const bytes = fs.statSync(r.file).size;
      const dest = path.join(this.opts.backingDir, `out-${id}.wav`);
      if (r.file !== dest) {
        fs.copyFileSync(r.file, dest);
        try { fs.rmSync(r.file, { force: true }); } catch { /* temp file */ }
      }
      for (const f of fs.readdirSync(this.opts.backingDir)) if (f.startsWith("out-") && path.join(this.opts.backingDir, f) !== dest) {
        try { fs.rmSync(path.join(this.opts.backingDir, f), { force: true }); } catch { /* still being served: next time */ }
      }
      const pub = this.server!.publish(dest, id, bytes);
      this.currentBackingFile = dest;
      this.backingFp = fp;
      c.offerBacking({ id, port: s.port + 3, token: pub.token, bytes });
      this.producerBacking = { phase: "sending", detail: "Sending the backing track to the singer…", seconds: r.seconds, bytes, progress: 0, stale: false };
    } catch (e) {
      this.retryAt = Date.now() + 5000;
      this.producerBacking = { ...NO_BACKING, phase: "error", detail: `The backing track could not be prepared: ${(e as Error).message}` };
    } finally {
      this.rendering = false;
    }
  }

  // ---- singer: download, verify, decode and play the backing track ----

  private singerHooks() {
    return {
      backingHave: () => this.haveId,
      onBackingOffer: (o: { id: string; host: string; port: number; token: string; bytes: number }) => void this.fetchBacking(o),
      onPlayBacking: (startLocalNs: number, offsetUs: number): string => {
        if (!this.haveId) return "the backing track has not arrived";
        const frame = this.port.frameAtNs(startLocalNs);
        if (frame === null) return "the microphone is not running, so the backing track cannot be played in sync";
        this.opts.toRenderer("live:playBacking", { startFrame: frame, offsetSec: offsetUs / 1e6, takeId: 0, id: this.haveId });
        return "";
      },
      onStopBacking: () => this.opts.toRenderer("live:stopBacking", null),
    };
  }

  private async fetchBacking(o: { id: string; host: string; port: number; token: string; bytes: number }): Promise<void> {
    if (o.id === this.haveId || (o.id === this.fetchingId && this.singerBacking.phase !== "error")) return;
    const gen = ++this.dlGen;
    this.fetchingId = o.id;
    const dest = path.join(this.opts.backingDir, `in-${o.id}.wav`);
    this.singerBacking = { phase: "downloading", detail: "Downloading the backing track from the producer…", seconds: 0, bytes: o.bytes, progress: 0, stale: false };
    let lastPush = 0;
    for (let attempt = 1; attempt <= 12; attempt++) {
      if (gen !== this.dlGen || !this.controller) return;
      let err = "";
      if (fs.existsSync(dest) && (await sha256OfFile(dest)) === o.id) {
        err = "";
      } else {
        err = await downloadBacking({
          host: o.host, port: o.port, token: o.token, id: o.id, bytes: o.bytes, dest, cancelled: () => gen !== this.dlGen,
          onProgress: (done, total) => {
            this.singerBacking = { ...this.singerBacking, progress: done / total };
            if (Date.now() - lastPush > 300) {
              lastPush = Date.now();
              this.push(false);
            }
          },
        });
      }
      if (!err) {
        if (gen !== this.dlGen) return;
        this.singerBacking = { ...this.singerBacking, phase: "decoding", progress: 1, detail: "Preparing the backing track for playback…" };
        this.opts.toRenderer("live:backingFile", { id: o.id, path: dest });
        this.push(true);
        return;
      }
      this.singerBacking = { ...this.singerBacking, phase: "downloading", detail: `Downloading the backing track (attempt ${attempt}): ${err}` };
      this.push(true);
      await new Promise((r) => setTimeout(r, Math.min(5000, 500 * attempt)));
    }
    this.singerBacking = { ...this.singerBacking, phase: "error", detail: "The backing track could not be downloaded. Ask the producer to change the arrangement slightly, or rejoin." };
    this.push(true);
  }
  private fetchingId = "";

  /** The window decoded the downloaded backing track and can play it. */
  backingReady(id: string): void {
    if (id !== this.fetchingId) return;
    this.haveId = id;
    this.singerBacking = { ...this.singerBacking, phase: "ready", progress: 1, detail: "The backing track is ready." };
    for (const f of fs.readdirSync(this.opts.backingDir)) if (f.startsWith("in-") && f !== `in-${id}.wav`) {
      try { fs.rmSync(path.join(this.opts.backingDir, f), { force: true }); } catch { /* in use */ }
    }
    this.push(true);
  }
  backingFailed(id: string, why: string): void {
    if (id !== this.fetchingId) return;
    this.haveId = "";
    this.singerBacking = { ...this.singerBacking, phase: "error", detail: `The backing track cannot be played on this PC: ${why}` };
    this.push(true);
  }
  /** The bytes of a downloaded backing track, for the window to decode (only files this service downloaded). */
  readBacking(file: string): Buffer | null {
    const rel = path.relative(this.opts.backingDir, file);
    if (rel.startsWith("..") || path.isAbsolute(rel) || !/^in-[0-9a-f]{64}\.wav$/.test(rel)) return null;
    try { return fs.readFileSync(file); } catch { return null; }
  }

  // ---- state ----

  private ensureEndpoint(s: ControllerSnapshot): void {
    const connected = s.link === 4; // LinkState.Connected
    const sessionU32 = media.sessionIdToU32(s.sessionId);
    const wantKey = connected && sessionU32 ? `${s.sessionId}|${s.peerAddress}|${s.port}` : "";
    if (this.endpointKey && this.endpointKey !== wantKey && !wantKey) {
      // The link is down: keep the socket (the session may resume); only tell it the control link is gone.
      this.endpoint?.setControlLinkUp(false);
      return;
    }
    this.endpoint?.setControlLinkUp(connected);
    if (!wantKey || this.endpointKey === wantKey || sessionU32 === null) return;
    this.endpoint?.stop();
    const producer = s.role === "producer";
    const ep = new MediaEndpoint({
      bindMode: producer,
      localAddress: s.bindAddress,
      peerAddress: producer ? s.peerAddress : s.bindAddress,
      mediaPort: s.port + 1,
      sessionId: sessionU32,
      outgoingStream: producer ? media.STREAM_PRODUCER_MIC : media.STREAM_PERFORMER_MIC,
      incomingStream: producer ? media.STREAM_PERFORMER_MIC : media.STREAM_PRODUCER_MIC,
      logger: this.logger,
    });
    ep.onAudio = (p: IncomingAudio) => this.opts.toRenderer("live:audio", { seq: p.seq, mediaIndex: p.mediaIndex, payload: p.payload, muted: p.muted, arrivalMs: p.arrivalNs / 1e6 });
    ep.onEndOfStream = () => this.opts.toRenderer("live:end", null);
    this.endpoint = ep;
    this.endpointKey = wantKey;
    ep.setSending(this.send);
    ep.setHearing(this.hear);
    void ep.start().then((err) => {
      if (err) {
        this.error = `Talkback could not start: ${err}`;
        if (this.endpoint === ep) {
          this.endpoint = null;
          this.endpointKey = "";
        }
      } else {
        ep.setControlLinkUp(connected);
      }
    });
  }

  private takes(s: ControllerSnapshot): SessionTake[] {
    const out: SessionTake[] = [];
    const t = s.take;
    const mine = s.role === "producer" ? "Your take" : "Your take (singer)";
    const seconds = (frames: number) => frames / this.port.captureState.sampleRate;
    if (t.takeId && t.localFinalised && t.localFile && (t.localStatus === 0 || t.localStatus === 1) && !(s.role === "producer" && this.mode === "vocal")) {
      out.push({ key: `mine-${s.sessionId}-${t.takeId}`, takeId: t.takeId, kind: "mine", label: `${mine} ${t.takeId}`, file: t.localFile, seconds: seconds(t.localFrames), ready: true, vocal: false, startTick: 0, tempo: 0, latencyUs: 0, lateFrames: 0 });
    }
    // what the singer reports about a finished take (its round trip and any late start) is kept per take
    if (s.role === "producer" && t.takeId && t.peerFinalised) {
      const n = this.notes.get(t.takeId);
      if (n) {
        n.latencyUs = t.peerLatencyUs;
        n.lateFrames = t.peerLateFrames;
      }
    }
    for (const x of s.transfers as TransferView[]) {
      if (s.role === "producer" && x.state === "verified" && x.file) {
        const n = this.notes.get(x.takeId);
        out.push({
          key: `copy-${s.sessionId}-${x.takeId}`, takeId: x.takeId, kind: "singer-copy", label: `Singer's take ${x.takeId}`, file: x.file, seconds: x.durationS, ready: true,
          vocal: !!n?.vocal, startTick: n?.startTick ?? 0, tempo: n?.tempo ?? 0, latencyUs: n?.latencyUs ?? 0, lateFrames: n?.lateFrames ?? 0,
        });
      }
    }
    return out;
  }

  /** Every take of this session on this PC (finished ones only), kept across takes by remembering earlier snapshots. */
  private seen = new Map<string, SessionTake>();

  state(): LiveState {
    const c = this.controller;
    const s = c ? c.snapshot() : null;
    if (s) {
      this.ensureEndpoint(s);
      for (const t of this.takes(s)) this.seen.set(t.key, t);
      if (s.role === "producer") void this.maintainBacking(s);
    }
    const cs = this.port.captureState;
    const backing: BackingStatus = this.role === "producer" ? { ...this.producerBacking, stale: this.producerBacking.stale || this.isBackingStale() } : this.role === "performer" ? this.singerBacking : NO_BACKING;
    return {
      role: this.role,
      snapshot: s,
      capture: s || cs.open ? { open: cs.open, device: cs.deviceName, level: this.port.level, blocks: this.port.blocksReceived, sampleRate: cs.sampleRate, failed: cs.failed } : { ...EMPTY_CAPTURE },
      media: this.endpoint?.stats() ?? null,
      talkback: { send: this.send, hear: this.hear },
      takes: [...this.seen.values()].sort((a, b) => a.takeId - b.takeId || (a.kind === "mine" ? -1 : 1)),
      recordingsRoot: this.port.recordingsRoot,
      history: c ? c.takeHistory().slice(-60) : [],
      error: this.error || s?.lastError || "",
      mode: this.mode,
      backing,
      syncPlay: this.syncPlayOn,
      startTick: this.opts.host?.tick() ?? 0,
    };
  }

  private tick(): void {
    this.push(false);
  }

  /** Sends the state to the window when it changed (or always, when forced). */
  private push(force: boolean): void {
    const st = this.state();
    const json = JSON.stringify(st);
    if (!force && json === this.lastJson) return;
    this.lastJson = json;
    this.opts.onState(st);
  }
}

