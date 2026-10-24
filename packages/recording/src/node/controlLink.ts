/**
 * The TCP control link (producer listens, performer connects), a port of control_link.cpp onto Node's `net`.
 * Handshake: HELLO / HELLO_ACK (versions), JOIN / JOIN_ACK (pairing code or resume token); then heartbeats feed the clock-offset estimator.
 * The owner polls `pollEvents()`; nothing here calls back into application code.
 */
import net from "node:net";
import { ClockOffsetEstimator } from "../clockOffset";
import { ErrorCode, errorCodeName } from "../errors";
import {
  Frame, FrameDecoder, MsgType, PROTOCOL_MAJOR, PROTOCOL_MINOR, Tag, encodeFrame, msgTypeName,
} from "../controlProtocol";
import { LinkState } from "../session";
import { type Clock, makePairingCode, makeRandomToken, msToNs, normalizeAddress, systemClock } from "./clock";

export interface LinkTimings {
  heartbeatIntervalMs: number;
  linkLostAfterMs: number;
  connectTimeoutMs: number;
  handshakeTimeoutMs: number;
  reconnectIntervalMs: number;
  reconnectGiveUpMs: number;
  pairingCodeTtlMs: number;
  maxFailedJoins: number;
}
export const DEFAULT_LINK_TIMINGS: LinkTimings = {
  heartbeatIntervalMs: 1000,
  linkLostAfterMs: 6000, // Stage 12: was 3000
  connectTimeoutMs: 5000,
  handshakeTimeoutMs: 3000,
  reconnectIntervalMs: 2000,
  reconnectGiveUpMs: 120000,
  pairingCodeTtlMs: 600000,
  maxFailedJoins: 5,
};

export interface ServerParams {
  bindAddress: string;
  port: number;
  sessionId: string;
  producerName: string;
  appVersion: string;
  maxTakeSeconds: number;
  timings?: Partial<LinkTimings>;
  clock?: Clock;
}
export interface ClientParams {
  hostAddress: string;
  port: number;
  pairingCode: string; // never logged
  performerName: string;
  appVersion: string;
  timings?: Partial<LinkTimings>;
  clock?: Clock;
}

export type LinkEvent =
  | { kind: "state"; state: LinkState; text: string }
  | { kind: "joined"; resumed: boolean; text: string }
  | { kind: "frame"; frame: Frame }
  | { kind: "peer-closed"; code: number; text: string }
  | { kind: "join-rejected"; code: number; text: string }
  | { kind: "protocol-error"; text: string }
  | { kind: "info"; text: string; code?: number };

export interface LinkStats {
  framesSent: number;
  framesReceived: number;
  staleFramesDropped: number;
  protocolErrors: number;
  heartbeatsReceived: number;
  connections: number;
  reconnectAttempts: number;
  failedJoins: number;
  controlRttNs: number;
  controlRttBestNs: number;
  /** estimated (peer clock - local clock) */
  thetaNs: number;
  thetaUncertaintyNs: number;
  offsetSamples: number;
}

export interface JoinInfo {
  sessionId: string;
  peerName: string;
  peerAppVersion: string;
  peerAddress: string;
  maxTakeSeconds: number;
  /** agreed minor version (min of both sides); 2+ = take transfer */
  protocolMinor: number;
}

type Phase = "idle" | "connecting" | "await-hello" | "await-hello-ack" | "await-join" | "await-join-ack" | "joined" | "closing";

const TICK_MS = 20;

export class ControlLink {
  private t: LinkTimings;
  private clock: Clock;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private events: LinkEvent[] = [];
  private _state: LinkState = LinkState.Disconnected;
  private _stats: LinkStats = {
    framesSent: 0, framesReceived: 0, staleFramesDropped: 0, protocolErrors: 0, heartbeatsReceived: 0, connections: 0, reconnectAttempts: 0,
    failedJoins: 0, controlRttNs: -1, controlRttBestNs: -1, thetaNs: 0, thetaUncertaintyNs: -1, offsetSamples: 0,
  };
  private join: JoinInfo = { sessionId: "", peerName: "", peerAppVersion: "", peerAddress: "", maxTakeSeconds: 0, protocolMinor: 0 };
  private _pairingCode = "";
  private codeCreatedNs = 0;
  private codeUsed = false;
  private failedJoins = 0;
  private resumeToken = "";
  private clientId = "";

  private listener: net.Server | null = null;
  private conn: net.Socket | null = null;
  private connReady = false;
  private rejecting: { socket: net.Socket; closeAtNs: number }[] = [];
  private connPeer = "";
  private decoder = new FrameDecoder();
  private nextMsgId = 1;
  private lastRxMsgId = 0;
  private phase: Phase = "idle";
  private phaseDeadlineNs = 0;
  private lastRxNs = 0;
  private lastHbTxNs = 0;
  private linkLostSinceNs = 0;
  private nextReconnectNs = 0;
  private everJoined = false;
  private offset = new ClockOffsetEstimator();
  private testMajor = 0;
  private suspendHeartbeats = false;
  private stopped = false;

  private constructor(private readonly isServer: boolean, private sp: ServerParams | null, private cp: ClientParams | null) {
    const timings = (isServer ? sp!.timings : cp!.timings) ?? {};
    this.t = { ...DEFAULT_LINK_TIMINGS, ...timings };
    this.clock = (isServer ? sp!.clock : cp!.clock) ?? systemClock;
  }

  static server(params: ServerParams): ControlLink {
    return new ControlLink(true, params, null);
  }
  static client(params: ClientParams): ControlLink {
    return new ControlLink(false, null, params);
  }

  get state(): LinkState { return this._state; }
  get server_(): boolean { return this.isServer; }
  get pairingCode(): string { return this._pairingCode; }
  stats(): LinkStats { return { ...this._stats }; }
  joinInfo(): JoinInfo { return { ...this.join }; }
  pollEvents(): LinkEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
  testSuspendHeartbeats(on: boolean): void { this.suspendHeartbeats = on; }
  testSetProtocolMajor(major: number): void { this.testMajor = major; }
  /** TEST ONLY: drops the TCP connection without saying goodbye. */
  testDropConnection(): void {
    if (this.conn) this.closeConnection("test: connection dropped", true);
  }

  /** Starts listening (producer) or connecting (performer). Resolves with an error text, or "" on success. */
  start(): Promise<string> {
    if (this.running) return Promise.resolve("");
    if (this.isServer) {
      const sp = this.sp!;
      if (sp.bindAddress === "0.0.0.0") return Promise.resolve("listening on all interfaces (0.0.0.0) is not allowed; choose one network interface");
      return new Promise((resolve) => {
        const server = net.createServer((s) => this.onIncoming(s));
        const onErr = (e: Error) => resolve(`cannot listen on ${sp.bindAddress}:${sp.port}: ${e.message}`);
        server.once("error", onErr);
        server.listen({ host: sp.bindAddress, port: sp.port, exclusive: true }, () => {
          server.off("error", onErr);
          server.on("error", (e) => this.pushInfo(`listener error: ${e.message}`));
          this.listener = server;
          this.newPairingCode();
          this.join.sessionId = sp.sessionId;
          this.running = true;
          this.setState(LinkState.Listening, `listening on ${sp.bindAddress}:${sp.port}`);
          this.ticker = setInterval(() => this.tick(), TICK_MS);
          resolve("");
        });
      });
    }
    const cp = this.cp!;
    if (net.isIPv4(cp.hostAddress) === false) return Promise.resolve(`not an IPv4 address: ${cp.hostAddress}`);
    this.clientId = makeRandomToken(8);
    this.running = true;
    this.startClientConnect();
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    return Promise.resolve("");
  }

  /** Says goodbye (SESSION_CLOSED) if joined, then closes. Resolves when the sockets are gone. */
  stop(reason: number = ErrorCode.Shutdown): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    this.running = false;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    return new Promise((resolve) => {
      const finish = () => {
        this.listener?.close();
        this.listener = null;
        for (const r of this.rejecting) r.socket.destroy();
        this.rejecting = [];
        this.phase = "idle";
        this.setState(LinkState.Disconnected, "stopped");
        resolve();
      };
      const c = this.conn;
      if (!c || c.destroyed) return finish();
      if (this.phase === "joined") {
        const bye = new Frame(MsgType.SessionClosed).setU16(Tag.ErrorCode, reason);
        this.writeFrame(bye);
      }
      // Half-close, then wait for the peer to close (<= 500 ms): closing with unread data makes Windows send a reset that can destroy the goodbye.
      const timer = setTimeout(() => { c.destroy(); }, 500);
      c.once("close", () => { clearTimeout(timer); finish(); });
      c.resume();
      c.end();
      this.conn = null;
    });
  }

  newPairingCode(): string {
    this._pairingCode = makePairingCode();
    this.codeCreatedNs = this.clock.nowNs();
    this.codeUsed = false;
    this.failedJoins = 0;
    return this._pairingCode;
  }

  /** Queues an application frame; false if the link is not Connected. */
  send(frame: Frame): boolean {
    if (this._state !== LinkState.Connected || this.phase !== "joined") return false;
    this.writeFrame(frame);
    return true;
  }

  // ---------------------------------------------------------------------------------------------

  private setState(s: LinkState, why: string): void {
    const old = this._state;
    this._state = s;
    if (old !== s) this.events.push({ kind: "state", state: s, text: why });
  }
  private pushInfo(text: string, code?: number): void {
    this.events.push({ kind: "info", text, code });
  }

  private writeFrame(f: Frame): void {
    f.msgId = this.nextMsgId++;
    f.setI64(Tag.SentNs, this.clock.nowNs());
    const c = this.conn;
    if (c && !c.destroyed && c.writable) c.write(encodeFrame(f));
    this._stats.framesSent++;
  }

  private sendErrorAndClose(code: number, text: string, refId: number): void {
    const e = new Frame(MsgType.Error);
    e.refId = refId;
    e.setU16(Tag.ErrorCode, code).setStr(Tag.ErrorText, text);
    this.writeFrame(e);
    this.phase = "closing";
    this.phaseDeadlineNs = this.clock.nowNs() + msToNs(500);
    this.pushInfo(`refused peer: ${errorCodeName(code)} (${text})`, code);
    this.conn?.end(); // flushes the ERROR frame first
  }

  private closeConnection(why: string, lost: boolean): void {
    const wasJoined = this.phase === "joined";
    const c = this.conn;
    this.conn = null;
    this.connReady = false;
    if (c) {
      c.removeAllListeners("data");
      c.on("error", () => {});
      c.destroy();
    }
    this.decoder = new FrameDecoder();
    this.phase = "idle";
    const now = this.clock.nowNs();
    if (this.isServer) {
      this.setState(this.everJoined ? LinkState.LinkLost : LinkState.Listening, why);
      return;
    }
    if (lost && this.everJoined) {
      if (wasJoined || this.linkLostSinceNs === 0) this.linkLostSinceNs = now;
      this.nextReconnectNs = now + msToNs(this.t.reconnectIntervalMs);
      this.setState(LinkState.LinkLost, why);
    } else {
      this.setState(LinkState.Disconnected, why);
    }
  }

  // ---- server: a TCP connection arrives ----
  private onIncoming(s: net.Socket): void {
    if (!this.running) return void s.destroy();
    const peer = normalizeAddress(s.remoteAddress);
    s.setNoDelay(true);
    if (this.conn) {
      // One performer per session: tell the newcomer and close it.
      const e = new Frame(MsgType.Error);
      e.msgId = 1;
      e.setI64(Tag.SentNs, this.clock.nowNs()).setU16(Tag.ErrorCode, ErrorCode.SessionFull).setStr(Tag.ErrorText, "this session already has a performer");
      s.on("error", () => {});
      s.write(encodeFrame(e));
      s.end();
      s.resume();
      this.rejecting.push({ socket: s, closeAtNs: this.clock.nowNs() + msToNs(1000) });
      this.pushInfo(`refused a second connection from ${peer} (session full)`);
      return;
    }
    const now = this.clock.nowNs();
    this.adopt(s);
    this.connPeer = peer;
    this.nextMsgId = 1;
    this.lastRxMsgId = 0;
    this.lastRxNs = now;
    this.phase = "await-hello";
    this.phaseDeadlineNs = now + msToNs(this.t.handshakeTimeoutMs);
    if (!this.everJoined) this.setState(LinkState.Handshaking, `connection from ${peer}`);
  }

  private adopt(s: net.Socket): void {
    this.conn = s;
    this.connReady = true;
    this.decoder = new FrameDecoder();
    s.on("data", (d: Buffer) => this.onData(s, d));
    s.on("end", () => { if (this.conn === s && this.phase !== "closing") this.closeConnection("the other side closed the connection", true); });
    s.on("error", (e) => { if (this.conn === s && this.phase !== "closing") this.closeConnection(e.message, true); });
    s.on("close", () => {
      if (this.conn !== s) return;
      if (this.phase === "closing") this.finishClosing();
      else this.closeConnection("the other side closed the connection", true);
    });
  }

  private finishClosing(): void {
    if (this.isServer) {
      this.closeConnection("peer refused", false);
    } else {
      this.everJoined = false;
      this.closeConnection("join refused", false);
    }
  }

  // ---- client: open the connection ----
  private startClientConnect(): void {
    const cp = this.cp!;
    this.decoder = new FrameDecoder();
    this.nextMsgId = 1;
    this.lastRxMsgId = 0;
    if (this.everJoined) this._stats.reconnectAttempts++;
    const s = new net.Socket();
    s.setNoDelay(true);
    this.conn = s;
    this.connReady = false;
    this.phase = "connecting";
    this.phaseDeadlineNs = this.clock.nowNs() + msToNs(this.t.connectTimeoutMs);
    if (!this.everJoined) this.setState(LinkState.Connecting, `connecting to ${cp.hostAddress}:${cp.port}`);
    s.once("connect", () => {
      if (this.conn !== s) return;
      const now = this.clock.nowNs();
      this.adopt(s);
      this.connPeer = cp.hostAddress;
      this.lastRxNs = now;
      const hello = new Frame(MsgType.Hello);
      hello.setU16(Tag.ProtoMajor, this.testMajor || PROTOCOL_MAJOR).setU16(Tag.ProtoMinor, PROTOCOL_MINOR).setU8(Tag.Role, 2).setStr(Tag.AppVersion, cp.appVersion);
      this.writeFrame(hello);
      this.phase = "await-hello-ack";
      this.phaseDeadlineNs = now + msToNs(this.t.handshakeTimeoutMs);
      if (!this.everJoined) this.setState(LinkState.Handshaking, "connected, checking versions");
    });
    s.once("error", (e) => {
      if (this.conn === s && this.phase === "connecting") this.closeConnection(`could not connect: ${e.message}`, true);
    });
    s.connect({ host: cp.hostAddress, port: cp.port });
  }

  // ---- periodic work ----
  private tick(): void {
    if (!this.running) return;
    const now = this.clock.nowNs();
    for (let i = this.rejecting.length - 1; i >= 0; i--) {
      const r = this.rejecting[i]!;
      if (r.socket.destroyed || now > r.closeAtNs) {
        r.socket.destroy();
        this.rejecting.splice(i, 1);
      }
    }
    if (!this.isServer && this.phase === "idle" && this.everJoined && this._state === LinkState.LinkLost && now >= this.nextReconnectNs) {
      if (now - this.linkLostSinceNs > msToNs(this.t.reconnectGiveUpMs)) {
        this.everJoined = false;
        this.setState(LinkState.Disconnected, "gave up reconnecting");
      } else {
        this.startClientConnect();
      }
    }
    if (!this.conn) return;
    switch (this.phase) {
      case "connecting":
        if (now > this.phaseDeadlineNs) this.closeConnection("could not connect: timed out", true);
        break;
      case "await-hello":
      case "await-hello-ack":
      case "await-join":
      case "await-join-ack":
        if (now > this.phaseDeadlineNs) this.closeConnection("handshake timed out", true);
        break;
      case "closing":
        if (now > this.phaseDeadlineNs) this.finishClosing();
        break;
      case "joined":
        if (!this.suspendHeartbeats && now - this.lastHbTxNs >= msToNs(this.t.heartbeatIntervalMs)) {
          this.writeFrame(new Frame(MsgType.Heartbeat));
          this.lastHbTxNs = now;
        }
        if (now - this.lastRxNs > msToNs(this.t.linkLostAfterMs)) {
          this.closeConnection(`no message from the other side for ${this.t.linkLostAfterMs} ms`, true);
        }
        break;
    }
  }

  // ---- receiving ----
  private onData(s: net.Socket, data: Buffer): void {
    if (this.conn !== s || this.phase === "connecting") return;
    this.decoder.feed(data);
    const arrival = this.clock.nowNs();
    for (;;) {
      if (this.conn !== s) return;
      const r = this.decoder.next();
      if (r.kind === "need-more") return;
      if (r.kind === "error") {
        this._stats.protocolErrors++;
        this.events.push({ kind: "protocol-error", text: `malformed control data: ${r.error}` });
        this.closeConnection("malformed control data", true);
        return;
      }
      this.handleFrame(r.frame, arrival);
    }
  }

  private handleFrame(f: Frame, arrivalNs: number): void {
    if (f.msgId <= this.lastRxMsgId) {
      this._stats.staleFramesDropped++;
      return;
    }
    this.lastRxMsgId = f.msgId;
    this.lastRxNs = arrivalNs;
    this._stats.framesReceived++;
    if (this.phase !== "joined") {
      if (this.isServer) this.serverHandshake(f);
      else this.clientHandshake(f);
      return;
    }
    switch (f.type) {
      case MsgType.Heartbeat: {
        const ack = new Frame(MsgType.HeartbeatAck);
        ack.refId = f.msgId;
        ack.setI64(Tag.EchoSentNs, f.i64(Tag.SentNs) ?? 0).setI64(Tag.RecvNs, arrivalNs);
        this.writeFrame(ack); // SentNs (t3) is stamped here
        this._stats.heartbeatsReceived++;
        break;
      }
      case MsgType.HeartbeatAck: {
        const t1 = f.i64(Tag.EchoSentNs) ?? 0;
        const t2 = f.i64(Tag.RecvNs) ?? 0;
        const t3 = f.i64(Tag.SentNs) ?? 0;
        this.offset.addSample(t1, t2, t3, arrivalNs);
        this._stats.controlRttNs = arrivalNs - t1;
        if (this.offset.hasEstimate) {
          this._stats.thetaNs = this.offset.thetaNs;
          this._stats.thetaUncertaintyNs = this.offset.uncertaintyNs;
          this._stats.offsetSamples = this.offset.sampleCount;
          this._stats.controlRttBestNs = this.offset.bestDeltaNs;
        }
        break;
      }
      case MsgType.SessionClosed: {
        const code = f.u16(Tag.ErrorCode) ?? 0;
        const text = `the other side closed the session (${errorCodeName(code)})`;
        this.events.push({ kind: "peer-closed", code, text });
        this.everJoined = false; // a deliberate close: no reconnect / no resume
        if (this.isServer) this.resumeToken = "";
        this.closeConnection(text, false);
        break;
      }
      case MsgType.Hello:
      case MsgType.HelloAck:
      case MsgType.Join:
      case MsgType.JoinAck:
        this.pushInfo(`ignored unexpected ${msgTypeName(f.type)} on a joined connection`);
        break;
      default:
        this.events.push({ kind: "frame", frame: f });
    }
  }

  private serverHandshake(f: Frame): void {
    const sp = this.sp!;
    const now = this.clock.nowNs();
    if (this.phase === "await-hello") {
      if (f.type !== MsgType.Hello) return this.sendErrorAndClose(ErrorCode.ProtocolMalformed, "expected HELLO", f.msgId);
      const major = f.u16(Tag.ProtoMajor) ?? 0;
      const minor = f.u16(Tag.ProtoMinor) ?? 0;
      if (major !== PROTOCOL_MAJOR) {
        return this.sendErrorAndClose(ErrorCode.VersionUnsupported, `producer speaks protocol ${PROTOCOL_MAJOR}.${PROTOCOL_MINOR}, performer offered ${major}.${minor}`, f.msgId);
      }
      if ((f.u8(Tag.Role) ?? 0) !== 2) return this.sendErrorAndClose(ErrorCode.WrongRole, "only a Performer Client can join a Producer Studio", f.msgId);
      this.join.peerAppVersion = f.str(Tag.AppVersion) ?? "";
      this.join.protocolMinor = Math.min(PROTOCOL_MINOR, minor);
      const ack = new Frame(MsgType.HelloAck);
      ack.refId = f.msgId;
      ack.setU16(Tag.ProtoMajor, PROTOCOL_MAJOR).setU16(Tag.ProtoMinor, Math.min(PROTOCOL_MINOR, minor)).setStr(Tag.AppVersion, sp.appVersion);
      this.writeFrame(ack);
      this.phase = "await-join";
      this.phaseDeadlineNs = now + msToNs(this.t.handshakeTimeoutMs);
      return;
    }
    if (this.phase !== "await-join") return;
    if (f.type !== MsgType.Join) return this.sendErrorAndClose(ErrorCode.ProtocolMalformed, "expected JOIN", f.msgId);
    const clientId = f.str(Tag.ClientId) ?? "";
    let resumed = false;
    let reject = "";
    if (f.has(Tag.ResumeToken)) {
      if (this.resumeToken !== "" && f.str(Tag.ResumeToken) === this.resumeToken && clientId === this.clientId) resumed = true;
      else reject = "resume refused (session ended or a different performer); join again with a new code";
    } else if (f.has(Tag.PairingCode)) {
      if (this.failedJoins >= this.t.maxFailedJoins) reject = "too many wrong codes; ask the producer for a new pairing code";
      else if (this.codeUsed) reject = "pairing code already used; ask the producer for a new code";
      else if (now - this.codeCreatedNs > msToNs(this.t.pairingCodeTtlMs)) reject = "pairing code expired; ask the producer for a new code";
      else if (f.str(Tag.PairingCode) !== this._pairingCode) {
        this.failedJoins++;
        this._stats.failedJoins++;
        reject = "wrong pairing code";
      } else {
        this.codeUsed = true;
        this.clientId = clientId;
        this.resumeToken = makeRandomToken(32);
      }
    } else {
      reject = "JOIN without pairing code or resume token";
    }
    if (reject) return this.sendErrorAndClose(ErrorCode.BadPairingCode, reject, f.msgId);
    const ack = new Frame(MsgType.JoinAck);
    ack.refId = f.msgId;
    ack.setStr(Tag.SessionId, sp.sessionId).setStr(Tag.ResumeToken, this.resumeToken).setStr(Tag.DisplayName, sp.producerName).setU32(Tag.MaxTakeSeconds, sp.maxTakeSeconds);
    this.join.peerName = f.str(Tag.DisplayName) ?? "";
    this.join.peerAddress = this.connPeer;
    this.join.maxTakeSeconds = sp.maxTakeSeconds;
    this._stats.connections++;
    this.writeFrame(ack);
    this.phase = "joined";
    this.everJoined = true;
    this.lastHbTxNs = 0;
    const text = resumed ? "performer reconnected" : "performer joined";
    this.setState(LinkState.Connected, text);
    this.events.push({ kind: "joined", resumed, text });
  }

  private clientHandshake(f: Frame): void {
    const cp = this.cp!;
    const now = this.clock.nowNs();
    if (f.type === MsgType.Error) {
      const code = f.u16(Tag.ErrorCode) ?? 0;
      const text = f.str(Tag.ErrorText) ?? errorCodeName(code);
      this.events.push({ kind: "join-rejected", code, text });
      this.everJoined = false; // a refusal is final: no automatic retry
      this.closeConnection(`join refused: ${errorCodeName(code)} - ${text}`, false);
      return;
    }
    if (this.phase === "await-hello-ack") {
      if (f.type !== MsgType.HelloAck || (f.u16(Tag.ProtoMajor) ?? 0) !== PROTOCOL_MAJOR) {
        this._stats.protocolErrors++;
        this.everJoined = false;
        this.closeConnection("unexpected reply to HELLO", false);
        return;
      }
      this.join.peerAppVersion = f.str(Tag.AppVersion) ?? "";
      this.join.protocolMinor = Math.min(PROTOCOL_MINOR, f.u16(Tag.ProtoMinor) ?? 0);
      const join = new Frame(MsgType.Join);
      join.setStr(Tag.ClientId, this.clientId);
      if (this.everJoined && this.resumeToken) join.setStr(Tag.ResumeToken, this.resumeToken);
      else join.setStr(Tag.PairingCode, cp.pairingCode);
      join.setStr(Tag.DisplayName, cp.performerName);
      this.writeFrame(join);
      this.phase = "await-join-ack";
      this.phaseDeadlineNs = now + msToNs(this.t.handshakeTimeoutMs);
      return;
    }
    if (this.phase === "await-join-ack" && f.type === MsgType.JoinAck) {
      const resumed = this.everJoined;
      this.join.sessionId = f.str(Tag.SessionId) ?? "";
      this.join.peerName = f.str(Tag.DisplayName) ?? "";
      this.join.peerAddress = cp.hostAddress;
      this.join.maxTakeSeconds = f.u32(Tag.MaxTakeSeconds) ?? 0;
      this.resumeToken = f.str(Tag.ResumeToken) ?? "";
      this._stats.connections++;
      this.phase = "joined";
      this.everJoined = true;
      this.linkLostSinceNs = 0;
      this.lastHbTxNs = 0;
      const text = resumed ? "reconnected" : "joined";
      this.setState(LinkState.Connected, resumed ? "reconnected to the producer" : "joined the producer's session");
      this.events.push({ kind: "joined", resumed, text });
      return;
    }
    this._stats.protocolErrors++;
    this.closeConnection(`unexpected ${msgTypeName(f.type)} during the handshake`, true);
  }
}
