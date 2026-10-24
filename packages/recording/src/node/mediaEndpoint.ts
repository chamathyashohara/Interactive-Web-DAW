/**
 * The live (talkback) UDP path, a port of live_endpoint.cpp (PROTOCOL_OVERVIEW §12, §13). One socket carries both directions:
 *  - the producer binds the media port (control port + 1) on its selected interface and learns the performer's endpoint from its datagrams;
 *  - the performer's socket is connected to producer:media_port.
 * Opus encoding/decoding and the jitter buffer live in the renderer (WebCodecs / Web Audio); this class owns the sockets, packet validation,
 * peer reachability and the receiver reports. Every datagram that fails a check is counted by reason.
 */
import dgram from "node:dgram";
import {
  type InvalidCounts, type MediaHeader, PacketType, REPORT_BYTES, REPORT_FLAG_CLOSING, REPORT_FLAG_PLAYING, STREAM_PERFORMER_MIC, STREAM_PRODUCER_MIC,
  type ReceiverReport, emptyReport, invalidTotal, newInvalidCounts, parsePacket, readReport, writePacket, writeReport, FLAG_MUTED, CODEC_OPUS,
} from "../mediaPacket";
import { type Clock, msToNs, normalizeAddress, systemClock } from "./clock";
import { type Logger, nullLogger } from "./log";

export interface MediaEndpointConfig {
  /** true: producer (bind + learn the performer's endpoint); false: performer (connect) */
  bindMode: boolean;
  /** bind mode: the selected interface */
  localAddress: string;
  /** bind mode: the performer's IP (its control connection); otherwise the producer's host */
  peerAddress: string;
  /** the producer's media port (control port + 1) */
  mediaPort: number;
  /** the session id as a u32 */
  sessionId: number;
  outgoingStream: number;
  incomingStream: number;
  peerTimeoutMs?: number;
  reportIntervalMs?: number;
  clock?: Clock;
  logger?: Logger;
}

export interface IncomingAudio {
  seq: number;
  mediaIndex: number;
  payload: Uint8Array;
  /** the sender had its microphone muted: the payload is encoded silence */
  muted: boolean;
  arrivalNs: number;
}

export interface EndpointStats {
  running: boolean;
  localEndpoint: string;
  peerKnown: boolean;
  peerEndpoint: string;
  peerReachable: boolean;
  peerHeard: boolean;
  peerClosed: boolean;
  controlLinkUp: boolean;
  lastRxAgeMs: number;
  peerTimeouts: number;
  packetsSent: number;
  bytesSent: number;
  sendErrors: number;
  audioReceived: number;
  endOfStreamSent: number;
  reportsSent: number;
  reportsReceived: number;
  invalid: InvalidCounts;
  invalidTotal: number;
  hasRemoteReport: boolean;
  remoteReport: ReceiverReport;
  remoteReportAgeMs: number;
}

const MAX_SEEN = 1024;

export class MediaEndpoint {
  private cfg: Required<Omit<MediaEndpointConfig, "clock" | "logger">>;
  private clock: Clock;
  private log: Logger;
  private socket: dgram.Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private expectedPeerIp = "";
  private peer: { address: string; port: number } | null = null;
  private peerClosed = false;
  private wasHeard = false;
  private lastRxNs = 0;
  private controlUp = false;
  private sending = true;
  private seq = 0;
  private reportSeq = 0;
  private nextReportNs = 0;
  private hearing = true;
  private incoming = emptyReport();
  private invalid = newInvalidCounts();
  private seen = new Set<number>();
  private lastSeq = -1;
  private peerTimeouts = 0;
  private packetsSent = 0;
  private bytesSent = 0;
  private sendErrors = 0;
  private audioReceived = 0;
  private eosSent = 0;
  private reportsSent = 0;
  private reportsReceived = 0;
  private remote: ReceiverReport | null = null;
  private remoteNs = 0;
  running = false;

  onAudio: (p: IncomingAudio) => void = () => {};
  onEndOfStream: () => void = () => {};

  constructor(config: MediaEndpointConfig) {
    this.clock = config.clock ?? systemClock;
    this.log = config.logger ?? nullLogger;
    this.cfg = { peerTimeoutMs: 3000, reportIntervalMs: 500, ...config } as Required<Omit<MediaEndpointConfig, "clock" | "logger">>;
  }

  /** Returns "" or an error text. */
  start(): Promise<string> {
    const c = this.cfg;
    if (c.sessionId === 0 || c.mediaPort === 0) return Promise.resolve("live media needs a session id and a media port");
    if (c.outgoingStream === c.incomingStream) return Promise.resolve("live media: incoming and outgoing stream ids must differ");
    this.expectedPeerIp = c.peerAddress;
    return new Promise((resolve) => {
      const s = dgram.createSocket({ type: "udp4", reuseAddr: false });
      const fail = (e: Error) => { try { s.close(); } catch { /* not open */ } resolve(`live media: ${e.message}`); };
      s.once("error", fail);
      s.on("message", (msg, rinfo) => this.onDatagram(new Uint8Array(msg.buffer, msg.byteOffset, msg.length), rinfo));
      const ready = () => {
        s.off("error", fail);
        s.on("error", (e) => this.log.log("warn", "live", "socket_error", e.message));
        this.socket = s;
        this.running = true;
        this.peer = c.bindMode ? null : { address: c.peerAddress, port: c.mediaPort };
        this.nextReportNs = this.clock.nowNs();
        this.timer = setInterval(() => this.tick(), 20);
        this.log.log("info", "live", "endpoint_started", "live media endpoint started", { role: c.bindMode ? "producer" : "performer", peer: c.peerAddress, out: c.outgoingStream, in: c.incomingStream });
        resolve("");
      };
      if (c.bindMode) s.bind({ port: c.mediaPort, address: c.localAddress, exclusive: true }, ready);
      else s.connect(c.mediaPort, c.peerAddress, ready);
    });
  }

  /** Tells the other side this direction is closing (twice: UDP may lose one), then closes. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.finishOutgoing();
    this.sendReport(true);
    this.sendReport(true);
    const s = this.socket;
    this.socket = null;
    setTimeout(() => { try { s?.close(); } catch { /* already closed */ } }, 50);
  }

  setControlLinkUp(up: boolean): void { this.controlUp = up; }

  /** The performer's "hear" switch, reported to the sender as the playing flag. */
  setHearing(on: boolean): void { this.hearing = on; }

  /** Send switch: turning it off ends the stream on purpose (END_OF_STREAM x2) so the other side refills without counting loss. */
  setSending(on: boolean): void {
    if (this.sending && !on) this.finishOutgoing();
    this.sending = on;
  }

  /** Statistics of the incoming stream, from the renderer's jitter buffer (received, lost, late, jitter, fill, ...). */
  setIncomingReport(r: Partial<ReceiverReport>): void { this.incoming = { ...this.incoming, ...r }; }

  /** One Opus packet from the encoder. Returns true if a datagram was sent. */
  sendAudio(opus: Uint8Array, mediaIndex: number, muted: boolean): boolean {
    if (!this.running || !this.sending || !this.reachable()) return false;
    const flags = CODEC_OPUS | (muted ? FLAG_MUTED : 0);
    const d = writePacket({ seq: this.seq, mediaIndex, sessionId: this.cfg.sessionId, streamId: this.cfg.outgoingStream, type: PacketType.Audio, flags }, opus);
    if (!d) return false;
    this.seq = (this.seq + 1) >>> 0;
    return this.sendDatagram(d);
  }

  private finishOutgoing(): void {
    if (!this.reachable()) return;
    for (let i = 0; i < 2; i++) {
      const d = writePacket({ seq: this.seq, mediaIndex: 0, sessionId: this.cfg.sessionId, streamId: this.cfg.outgoingStream, type: PacketType.EndOfStream, flags: 0 }, new Uint8Array(0));
      this.seq = (this.seq + 1) >>> 0;
      if (d && this.sendDatagram(d)) this.eosSent++;
    }
  }

  private sendDatagram(d: Uint8Array): boolean {
    const s = this.socket;
    if (!s || !this.peer) return false;
    try {
      if (this.cfg.bindMode) s.send(d, this.peer.port, this.peer.address, (e) => { if (e) this.sendErrors++; });
      else s.send(d, (e) => { if (e) this.sendErrors++; });
      this.packetsSent++;
      this.bytesSent += d.length;
      return true;
    } catch {
      this.sendErrors++;
      return false;
    }
  }

  private sendReport(closing: boolean): void {
    if (!this.socket || !this.peer) return;
    const r: ReceiverReport = { ...this.incoming, invalidPackets: invalidTotal(this.invalid), flags: (this.hearing ? REPORT_FLAG_PLAYING : 0) | (closing ? REPORT_FLAG_CLOSING : 0) };
    const d = writePacket({ seq: this.reportSeq, mediaIndex: 0, sessionId: this.cfg.sessionId, streamId: this.cfg.incomingStream, type: PacketType.ReceiverReport, flags: 0 }, writeReport(r));
    this.reportSeq = (this.reportSeq + 1) >>> 0;
    if (d && this.sendDatagram(d)) this.reportsSent++;
  }

  private heard(now: number): boolean {
    return this.lastRxNs !== 0 && now - this.lastRxNs <= msToNs(this.cfg.peerTimeoutMs);
  }

  private reachable(): boolean {
    const now = this.clock.nowNs();
    const heard = this.heard(now);
    if (this.wasHeard && !heard) {
      this.peerTimeouts++;
      this.log.log("warn", "live", "peer_timeout", "no live datagram from the remote side", { control_link_up: this.controlUp });
    }
    this.wasHeard = heard;
    return !!this.peer && !this.peerClosed && (heard || this.controlUp);
  }

  private tick(): void {
    this.reachable(); // keeps the timeout counter honest even when nothing is being sent
    const now = this.clock.nowNs();
    if (now >= this.nextReportNs) {
      this.sendReport(false);
      this.nextReportNs = now + msToNs(this.cfg.reportIntervalMs);
    }
  }

  private onDatagram(data: Uint8Array, rinfo: dgram.RemoteInfo): void {
    if (!this.running) return;
    const now = this.clock.nowNs();
    const from = normalizeAddress(rinfo.address);
    // Step 1: the source must be the paired peer (producer: any port from the performer's IP; performer: the connected socket already filters).
    if (this.cfg.bindMode ? from !== this.expectedPeerIp : from !== this.cfg.peerAddress || rinfo.port !== this.cfg.mediaPort) {
      this.invalid.src_rejected++;
      return;
    }
    const parsed = parsePacket(data, this.cfg.sessionId);
    if (parsed.check !== "ok") {
      this.invalid[parsed.check]++;
      return;
    }
    const h: MediaHeader = parsed.header;
    let accepted = false;
    let closing = false;
    if (h.type === PacketType.ReceiverReport) {
      if (h.streamId === this.cfg.outgoingStream) {
        const r = readReport(parsed.payload);
        closing = (r.flags & REPORT_FLAG_CLOSING) !== 0;
        this.reportsReceived++;
        this.remote = r;
        this.remoteNs = now;
        accepted = true;
      }
    } else if (h.streamId === this.cfg.incomingStream) {
      accepted = true;
      if (h.type === PacketType.Audio) {
        if (this.lastSeq >= 0 && ((this.lastSeq - h.seq) | 0) >= 64) this.seen.clear(); // sequence stepped back: a new stream, not duplicates
        this.lastSeq = h.seq;
        if (this.seen.has(h.seq)) {
          this.incoming = { ...this.incoming, duplicates: this.incoming.duplicates + 1 };
        } else {
          this.seen.add(h.seq);
          if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value as number);
          this.audioReceived++;
          this.onAudio({ seq: h.seq, mediaIndex: h.mediaIndex, payload: parsed.payload.slice(), muted: (h.flags & FLAG_MUTED) !== 0, arrivalNs: now });
        }
      } else {
        this.seen.clear();
        this.lastSeq = -1;
        this.onEndOfStream();
      }
    }
    if (!accepted) {
      this.invalid.wrong_stream++;
      return;
    }
    this.lastRxNs = now;
    if (this.cfg.bindMode && (!this.peer || this.peer.address !== from || this.peer.port !== rinfo.port)) {
      this.peer = { address: from, port: rinfo.port };
      this.log.log("info", "live", "peer_learned", "performer media endpoint learned from its datagrams", { peer: `${from}:${rinfo.port}` });
    }
    if (closing) {
      if (!this.peerClosed) this.log.log("info", "live", "peer_closed", "remote side stopped its live media", {});
      this.peerClosed = true;
    } else {
      this.peerClosed = false;
    }
  }

  stats(): EndpointStats {
    const now = this.clock.nowNs();
    const heard = this.heard(now);
    return {
      running: this.running,
      localEndpoint: this.socket ? (() => { try { const a = this.socket!.address(); return `${a.address}:${a.port}`; } catch { return ""; } })() : "",
      peerKnown: !!this.peer,
      peerEndpoint: this.peer ? `${this.peer.address}:${this.peer.port}` : "",
      peerReachable: !!this.peer && !this.peerClosed && (heard || this.controlUp),
      peerHeard: heard,
      peerClosed: this.peerClosed,
      controlLinkUp: this.controlUp,
      lastRxAgeMs: this.lastRxNs === 0 ? -1 : (now - this.lastRxNs) / 1e6,
      peerTimeouts: this.peerTimeouts,
      packetsSent: this.packetsSent,
      bytesSent: this.bytesSent,
      sendErrors: this.sendErrors,
      audioReceived: this.audioReceived,
      endOfStreamSent: this.eosSent,
      reportsSent: this.reportsSent,
      reportsReceived: this.reportsReceived,
      invalid: { ...this.invalid },
      invalidTotal: invalidTotal(this.invalid),
      hasRemoteReport: this.remote !== null,
      remoteReport: this.remote ?? emptyReport(),
      remoteReportAgeMs: this.remoteNs === 0 ? -1 : (now - this.remoteNs) / 1e6,
    };
  }
}

export { STREAM_PERFORMER_MIC, STREAM_PRODUCER_MIC, REPORT_BYTES };
