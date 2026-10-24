import os from "node:os";
import path from "node:path";
import { media, type Role } from "@daw/recording";

type ReceiverReport = media.ReceiverReport;
import {
  CaptureRecorderPort, JsonlFileLogger, MediaEndpoint, SessionController, type ControllerSnapshot, type EndpointStats, type IncomingAudio, type TransferView,
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
}

export interface LiveServiceOptions {
  /** where takes are written (the watched folder, so they also show up in the Recordings list) */
  recordingsRoot: string;
  logFile: string;
  appVersion: string;
  onState: (s: LiveState) => void;
  /** sends decoded-side traffic to the renderer */
  toRenderer: (channel: string, payload: unknown) => void;
}

const EMPTY_CAPTURE = { open: false, device: "", level: 0, blocks: 0, sampleRate: 48000, failed: "" };

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

/**
 * Remote recording inside the DAW (Component 4, ported to TypeScript). Owns the session controller, the local master recorder, the
 * live talkback socket and the plumbing to the window that captures and plays audio. The window decides nothing about timing: it
 * only streams microphone blocks here and plays what arrives.
 */
export class LiveRecordingService {
  private logger: Logger;
  readonly memLog = new MemoryLogger();
  readonly port: CaptureRecorderPort;
  private controller: SessionController | null = null;
  private endpoint: MediaEndpoint | null = null;
  private endpointKey = "";
  private role: Role | null = null;
  private error = "";
  private send = false;
  private hear = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastJson = "";
  private autoTransfer = true;
  private name = os.userInfo().username || "";

  constructor(private opts: LiveServiceOptions) {
    this.logger = teeLogger(new JsonlFileLogger(opts.logFile), this.memLog);
    this.port = new CaptureRecorderPort({ recordingsRoot: opts.recordingsRoot, logger: this.logger });
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 200);
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.port.closeForShutdown(); // a take in progress is finalised, not left as a .partial
    this.endpoint?.stop();
    this.endpoint = null;
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

  private makeController(role: Role): SessionController {
    const c = new SessionController(
      { role, appVersion: this.opts.appVersion, displayName: this.name || (role === "producer" ? "Producer" : "Singer"), autoTransfer: this.autoTransfer, receivedRoot: path.join(this.port.recordingsRoot, "received") },
      this.port,
      this.logger,
    );
    c.startPolling(50);
    return c;
  }

  private async dispose(): Promise<void> {
    this.endpoint?.stop();
    this.endpoint = null;
    this.endpointKey = "";
    const c = this.controller;
    this.controller = null;
    this.role = null;
    this.seen.clear();
    await c?.shutdown();
  }

  /** Producer: open the session on one network address. */
  async createSession(opts: { bind: string; port: number; name?: string }): Promise<{ ok: boolean; reason?: string }> {
    await this.dispose();
    if (opts.name?.trim()) this.name = opts.name.trim();
    this.error = "";
    const c = this.makeController("producer");
    const err = await c.createSession(opts.bind, opts.port);
    if (err) {
      void c.shutdown();
      this.error = err;
      this.push(true);
      return { ok: false, reason: err };
    }
    this.controller = c;
    this.role = "producer";
    this.push(true);
    return { ok: true };
  }

  async join(opts: { host: string; port: number; code: string; name?: string }): Promise<{ ok: boolean; reason?: string }> {
    await this.dispose();
    if (opts.name?.trim()) this.name = opts.name.trim();
    this.error = "";
    const c = this.makeController("performer");
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
  record(): string { return this.act((c) => c.startTake(), "start or join a session first"); }
  stop(): string { return this.act((c) => (c.role === "producer" ? c.stopTake() : c.stopAndSave()), "no session"); }
  newCode(): string { return this.act((c) => c.newPairingCode(), ""); }
  setLead(ms: number, auto: boolean): void { this.act((c) => { c.setStartLeadMs(ms); c.setAutoStartLead(auto); }, undefined); }
  setAutoTransfer(on: boolean): void {
    this.autoTransfer = on;
    this.act((c) => c.setAutoTransfer(on), undefined);
  }
  async requestTransfer(takeId: number): Promise<string> {
    const c = this.controller;
    const r = c ? await c.requestTransfer(takeId) : "no session";
    this.push(true);
    return r;
  }
  cancelTransfer(takeId: number): void { this.act((c) => c.cancelTransfer(takeId), undefined); }

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
    if (t.takeId && t.localFinalised && t.localFile && (t.localStatus === 0 || t.localStatus === 1)) {
      out.push({ key: `mine-${t.takeId}`, takeId: t.takeId, kind: "mine", label: `${mine} ${t.takeId}`, file: t.localFile, seconds: t.localFrames / this.port.captureState.sampleRate, ready: true });
    }
    for (const x of s.transfers as TransferView[]) {
      if (s.role === "producer" && x.state === "verified" && x.file) {
        out.push({ key: `copy-${x.takeId}`, takeId: x.takeId, kind: "singer-copy", label: `Singer's take ${x.takeId}`, file: x.file, seconds: x.durationS, ready: true });
      }
    }
    return out;
  }

  /** Every take of this session on this PC (finished ones only), newest session state last. Kept across takes by remembering earlier snapshots. */
  private seen = new Map<string, SessionTake>();

  state(): LiveState {
    const c = this.controller;
    const s = c ? c.snapshot() : null;
    if (s) {
      this.ensureEndpoint(s);
      for (const t of this.takes(s)) this.seen.set(t.key, t);
    }
    const cs = this.port.captureState;
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
