/**
 * Producer/performer session control, a port of session_controller.cpp (Stages 6, 9, 11, 12).
 *
 * Rules enforced here:
 *  - every state change goes through sessionTransition(); invalid events change nothing, are logged, and messages that caused them are refused;
 *  - take ids are strictly increasing: a duplicated or delayed ARM/SCHEDULE_START/STOP can never start or stop a second recording
 *    (duplicates are answered idempotently, stale ones refused);
 *  - the producer shows a performer step only after the performer's own message (ARM_ACK, START_ACK, TAKE_STARTED, TAKE_FINALISED);
 *  - pairing codes and resume tokens are never logged.
 *
 * Single-threaded: poll() runs on a timer owned by the caller (or `startPolling`).
 */
import path from "node:path";
import { ErrorCode, TakeStatus, type Role, errorCodeName, takeStatusName } from "../errors";
import { Frame, MINOR_BACKING, MsgType, Tag, msgTypeName } from "../controlProtocol";
import {
  LinkState, type LocalReadiness, ReadyItem, type ReadinessCheck, SessionEvent, SessionState, decodeChecks, encodeChecks, isTakeRunning, linkStateName,
  sessionStateName, sessionTransition,
} from "../session";
import { ControlLink, type LinkEvent, type LinkStats, type LinkTimings, type JoinInfo } from "./controlLink";
import { type Clock, makeSessionId, msToNs, systemClock } from "./clock";
import { type Logger, nullLogger } from "./log";
import type { PortEvent, PortTakeSpec, RecorderPort } from "./recorderPort";
import { TakeReceiver, TakeSender, type SenderParams, type TransferView } from "./takeTransfer";

export interface SessionTimingConfig {
  startLeadMs: number;
  /** Stage 12: the producer sizes the lead for the link it measured (never below startLeadMs). */
  autoStartLead: boolean;
  armAckMarginMs: number;
  stopLeadMs: number;
  finaliseReportWaitMs: number;
  maxTakeSeconds: number;
}
export const DEFAULT_TIMING: SessionTimingConfig = {
  startLeadMs: 1000, autoStartLead: true, armAckMarginMs: 100, stopLeadMs: 300, finaliseReportWaitMs: 10000, maxTakeSeconds: 1800,
};

/** What the application around the controller does for the backing-track features (all optional). */
export interface ControllerHooks {
  /** performer: the producer announced a backing track; download it from `host`. */
  onBackingOffer?(o: { id: string; host: string; port: number; token: string; bytes: number }): void;
  /** performer: the id of the backing track this PC holds ("" = none). */
  backingHave?(): string;
  /** performer: play the backing track from `offsetUs` at `startLocalNs` (this PC's clock). Returns "" or why it cannot. */
  onPlayBacking?(startLocalNs: number, offsetUs: number): string;
  /** performer: stop the backing track now. */
  onStopBacking?(): void;
}

export interface BackingOffer {
  id: string;
  port: number;
  token: string;
  bytes: number;
}

export interface ControllerConfig {
  role: Role;
  hooks?: ControllerHooks;
  timing?: Partial<SessionTimingConfig>;
  link?: Partial<LinkTimings>;
  appVersion: string;
  displayName: string;
  /** performer: SCHEDULE_START must follow ARM within this time */
  armToScheduleTimeoutMs?: number;
  statusIntervalMs?: number;
  /** performer: clock-offset samples needed before it can accept a schedule */
  minOffsetSamples?: number;
  /** TEST ONLY: non-zero announces this major in HELLO */
  testProtocolMajor?: number;
  autoTransfer?: boolean;
  /** producer: used when the recorder has no session folder */
  receivedRoot?: string;
  transferResumeWaitMs?: number;
  transferSender?: SenderParams;
  clock?: Clock;
}

/** Everything the UI shows about one take. "peer*" flags are set only by the performer's messages. */
export interface TakeView {
  takeId: number;
  armSent: boolean;
  peerArmAck: boolean;
  scheduleSent: boolean;
  peerStartAck: boolean;
  startAtLocalNs: number;
  peerPlannedStartNs: number;
  localStarted: boolean;
  localFirstSampleNs: number;
  localLateFrames: number;
  peerStarted: boolean;
  peerFirstSampleNs: number;
  peerLateFrames: number;
  stopSent: boolean;
  peerStopAck: boolean;
  localFinalised: boolean;
  localStatus: TakeStatus;
  localFrames: number;
  localFile: string;
  localError: string;
  peerFinalised: boolean;
  peerReportTimedOut: boolean;
  peerStatus: TakeStatus;
  peerFrames: number;
  hasStartOffset: boolean;
  startOffsetMs: number;
  startOffsetUncMs: number;
  armSentNs: number;
  armAckRxNs: number;
  scheduleSentNs: number;
  startAckRxNs: number;
  armRxNs: number;
  scheduleRxNs: number;
  startAckSentNs: number;
  peerStartedRxNs: number;
  peerFinalisedRxNs: number;
  stopCmdNs: number;
  stopAtLocalNs: number;
  stopAckRxNs: number;
  localStartedSeenNs: number;
  localFinalisedNs: number;
  localFirstFrame: number;
  peerFirstFrame: number;
  devicePeriodFrames: number;
  devicePeriods: number;
  thetaNs: number;
  thetaUncNs: number;
  offsetSamples: number;
  startLeadMs: number;
  cancelled: boolean;
  cancelReason: string;
  /** vocal over a backing track: song position (microseconds) the take plays and records from, and the singer's measured round trip */
  vocal: boolean;
  offsetUs: number;
  peerLatencyUs: number;
}
export const newTakeView = (): TakeView => ({
  takeId: 0, armSent: false, peerArmAck: false, scheduleSent: false, peerStartAck: false, startAtLocalNs: 0, peerPlannedStartNs: 0, localStarted: false,
  localFirstSampleNs: 0, localLateFrames: 0, peerStarted: false, peerFirstSampleNs: 0, peerLateFrames: 0, stopSent: false, peerStopAck: false,
  localFinalised: false, localStatus: TakeStatus.Complete, localFrames: 0, localFile: "", localError: "", peerFinalised: false, peerReportTimedOut: false,
  peerStatus: TakeStatus.Complete, peerFrames: 0, hasStartOffset: false, startOffsetMs: 0, startOffsetUncMs: 0, armSentNs: 0, armAckRxNs: 0, scheduleSentNs: 0,
  startAckRxNs: 0, armRxNs: 0, scheduleRxNs: 0, startAckSentNs: 0, peerStartedRxNs: 0, peerFinalisedRxNs: 0, stopCmdNs: 0, stopAtLocalNs: 0, stopAckRxNs: 0,
  localStartedSeenNs: 0, localFinalisedNs: 0, localFirstFrame: 0, peerFirstFrame: 0, devicePeriodFrames: 0, devicePeriods: 0, thetaNs: 0, thetaUncNs: 0,
  offsetSamples: 0, startLeadMs: 0, cancelled: false, cancelReason: "", vocal: false, offsetUs: 0, peerLatencyUs: 0,
});

export interface ControllerSnapshot {
  role: Role;
  link: LinkState;
  session: SessionState;
  notReadyReasons: string[];
  sessionId: string;
  /** producer only, for DISPLAY; never logged */
  pairingCode: string;
  bindAddress: string;
  port: number;
  peerName: string;
  peerAddress: string;
  localConsent: boolean;
  peerReady: boolean;
  peerConsent: boolean;
  peerReasons: string;
  localChecks: ReadinessCheck[];
  peerChecks: ReadinessCheck[];
  startLeadMs: number;
  minStartLeadMs: number;
  effectiveStartLeadMs: number;
  autoStartLead: boolean;
  linkStats: LinkStats;
  take: TakeView;
  lastError: string;
  invalidEvents: number;
  refusedMessages: number;
  duplicateMessages: number;
  recorderDescription: string;
  transfers: TransferView[];
  deliveryConsent: boolean;
  peerDeliveryConsent: boolean;
  autoTransfer: boolean;
  protocolMinor: number;
  transferPort: number;
  /** "vocal": only the singer is recorded, over a backing track the producer plays; "both": each PC records its own microphone */
  mode: "both" | "vocal";
  /** producer: the backing track on offer and the id the singer holds; performer: what the producer offered and what is held */
  backing: { offeredId: string; haveId: string; bytes: number; playing: boolean };
}

const carriesSession = (t: number): boolean =>
  [MsgType.PlayAck, MsgType.Arm, MsgType.ArmAck, MsgType.ScheduleStart, MsgType.StartAck, MsgType.TakeStarted, MsgType.Cancel, MsgType.StopSchedule, MsgType.StopAck, MsgType.LocalStop, MsgType.TakeFinalised, MsgType.TransferRequest, MsgType.TransferAck].includes(t as never);

const AUTO_START_LEAD_HEADROOM_MS = 250;
const msBetween = (from: number, to: number): string => (from === 0 || to === 0 ? "n/a" : ((to - from) / 1e6).toFixed(3));

export class SessionController {
  readonly role: Role;
  private cfg: Required<Omit<ControllerConfig, "timing" | "link" | "transferSender" | "clock" | "receivedRoot" | "hooks">> & { timing: SessionTimingConfig; link: Partial<LinkTimings>; transferSender: SenderParams; receivedRoot: string };
  private clock: Clock;
  private link: ControlLink | null = null;
  private linkState: LinkState = LinkState.Disconnected;
  private state: SessionState = SessionState.NotReady;
  private sessionId = "";
  private bindAddress = "";
  private portNumber = 0;
  private consent = false;
  private peerReady = false;
  private peerConsent = false;
  private peerReasons = "";
  private reasons: string[] = [];
  private localChecks: ReadinessCheck[] = [];
  private peerChecks: ReadinessCheck[] = [];
  private localReady = false;
  private stopAfterStart = false;
  private lastStatusPayload = "";
  private lastStatusNs = 0;
  private lastError = "";
  private take: TakeView = newTakeView();
  private takeOpen = false;
  private lastTakeId = 0;
  private armAckDeadline = 0;
  private startAckDeadline = 0;
  private scheduleDeadline = 0;
  private peerReportDeadline = 0;
  private stopAckDeadline = 0;
  private stopOwed = false;
  private reportQueue: Frame[] = [];
  private invalidEvents = 0;
  private refused = 0;
  private duplicates = 0;
  private hist: string[] = [];
  private finished = new Map<number, { status: TakeStatus; frames: number; file: string }>();
  private receiver: TakeReceiver | null = null;
  private sender: TakeSender | null = null;
  private deliveryConsent = false;
  private peerDeliveryConsent = false;
  private autoQueue: number[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private mode: "both" | "vocal" = "both";
  private offered: BackingOffer | null = null;
  private peerBackingHave = "";
  private incomingOffer: BackingOffer | null = null;
  private backingPlaying = false;
  private hooks: ControllerHooks;
  private singerHearing = false;
  private vocalBackingId = "";
  private previewStartNs = 0;

  constructor(config: ControllerConfig, private port: RecorderPort, private log: Logger = nullLogger) {
    this.role = config.role;
    this.hooks = config.hooks ?? {};
    this.clock = config.clock ?? systemClock;
    this.cfg = {
      role: config.role,
      timing: { ...DEFAULT_TIMING, ...config.timing },
      link: config.link ?? {},
      appVersion: config.appVersion,
      displayName: config.displayName,
      armToScheduleTimeoutMs: config.armToScheduleTimeoutMs ?? 5000,
      statusIntervalMs: config.statusIntervalMs ?? 2000,
      minOffsetSamples: config.minOffsetSamples ?? 3,
      testProtocolMajor: config.testProtocolMajor ?? 0,
      autoTransfer: config.autoTransfer ?? false,
      receivedRoot: config.receivedRoot ?? "",
      transferResumeWaitMs: config.transferResumeWaitMs ?? 60000,
      transferSender: config.transferSender ?? {},
    };
  }

  private now(): number { return this.clock.nowNs(); }

  /** Called after every poll() so a UI can push the new snapshot. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  startPolling(ms = 50): void {
    if (!this.pollTimer) this.pollTimer = setInterval(() => this.poll(), ms);
  }

  private history(line: string): void {
    this.hist.push(`${new Date().toISOString().slice(11, 23)}  ${line}`);
    if (this.hist.length > 300) this.hist.shift();
  }
  takeHistory(): string[] { return [...this.hist]; }

  private apply(event: SessionEvent, why: string): boolean {
    const next = sessionTransition(this.role, this.state, event);
    if (next === null) {
      this.invalidEvents++;
      this.log.log("warn", "session", "invalid_transition", why, { state: sessionStateName(this.state), event });
      return false;
    }
    if (next !== this.state) {
      this.log.log("info", "session", "state", why, { from: sessionStateName(this.state), to: sessionStateName(next), event });
      this.history(`state ${sessionStateName(this.state)} -> ${sessionStateName(next)} (${why})`);
    }
    this.state = next;
    if (this.state === SessionState.Completed) this.updateReadiness(); // Completed is short-lived
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  /** Producer: opens the control port. Returns "" or an error text. */
  async createSession(bindAddress: string, port: number): Promise<string> {
    if (this.role !== "producer") return "only the producer creates sessions";
    this.releaseFinishedLink();
    if (this.link) return "a session already exists";
    this.sessionId = makeSessionId();
    const link = ControlLink.server({
      bindAddress, port, sessionId: this.sessionId, producerName: this.cfg.displayName, appVersion: this.cfg.appVersion,
      maxTakeSeconds: this.cfg.timing.maxTakeSeconds, timings: { ...this.cfg.link, linkLostAfterMs: this.cfg.link.linkLostAfterMs }, clock: this.clock,
    });
    if (this.cfg.testProtocolMajor) link.testSetProtocolMajor(this.cfg.testProtocolMajor);
    const error = await link.start();
    if (error) {
      this.sessionId = "";
      this.log.log("error", "session", "create_failed", error);
      return error;
    }
    this.link = link;
    this.bindAddress = bindAddress;
    this.portNumber = port;
    this.linkState = LinkState.Listening;
    this.log.log("info", "session", "created", "session created", { session: this.sessionId, bind: bindAddress, port, pairing_code: "<redacted>" });
    this.history(`session ${this.sessionId} created on ${bindAddress}:${port}`);
    this.notify();
    return "";
  }

  newPairingCode(): string {
    if (!this.link || this.role !== "producer") return "";
    this.log.log("info", "session", "pairing_code_renewed", "new pairing code issued", { pairing_code: "<redacted>" });
    this.history("new pairing code issued");
    return this.link.newPairingCode();
  }

  /** Performer: connects and joins. Returns "" or an error text. */
  async join(host: string, port: number, code: string): Promise<string> {
    if (this.role !== "performer") return "only Performer Client joins sessions";
    this.releaseFinishedLink();
    if (this.link) return "already in a session";
    const link = ControlLink.client({
      hostAddress: host, port, pairingCode: code, performerName: this.cfg.displayName, appVersion: this.cfg.appVersion, timings: this.cfg.link, clock: this.clock,
    });
    if (this.cfg.testProtocolMajor) link.testSetProtocolMajor(this.cfg.testProtocolMajor);
    const error = await link.start();
    if (error) return error;
    this.link = link;
    this.bindAddress = host;
    this.portNumber = port;
    if (!this.sender) this.sender = new TakeSender({ ...this.cfg.transferSender, clock: this.clock }, this.log);
    this.linkState = LinkState.Connecting;
    this.lastError = "";
    this.log.log("info", "session", "join_started", "joining", { host, port, pairing_code: "<redacted>" });
    this.history(`joining ${host}:${port}`);
    this.notify();
    return "";
  }

  /** A link that has ended for good is released so the user can join or create again. Never while a local take is still running. */
  private releaseFinishedLink(): void {
    if (!this.link || this.linkState !== LinkState.Disconnected || this.link.state !== LinkState.Disconnected || isTakeRunning(this.state) || this.state === SessionState.Scheduled) return;
    void this.link.stop(ErrorCode.UserStop);
    this.link = null;
    this.peerReady = false;
    this.peerConsent = false;
    this.sessionId = "";
    this.reportQueue = [];
    this.stopTransfers();
  }

  setConsent(given: boolean): void {
    if (this.consent === given) return;
    this.consent = given;
    this.log.log("info", "session", given ? "consent_given" : "consent_withdrawn", given ? "local participant consented to recording" : "consent withdrawn");
    this.history(given ? "consent given" : "consent withdrawn");
    this.updateReadiness();
    this.sendStatus(true);
    this.notify();
  }

  /** Ends the session (SESSION_CLOSED); not allowed while recording. */
  async leave(): Promise<void> {
    if (!this.link) return;
    if (isTakeRunning(this.state) || this.state === SessionState.Scheduled) {
      this.lastError = "stop the take before leaving the session";
      return;
    }
    const link = this.link;
    this.link = null;
    this.stopTransfers();
    this.linkState = LinkState.Disconnected;
    this.apply(SessionEvent.LinkLost, "left the session");
    this.peerReady = false;
    this.peerConsent = false;
    this.sessionId = "";
    this.history("left the session");
    this.log.log("info", "session", "left", "session closed by this side");
    this.notify();
    await link.stop(ErrorCode.UserStop);
  }

  /** App closing. */
  async shutdown(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.stopTransfers();
    const link = this.link;
    this.link = null;
    if (link) await link.stop(ErrorCode.Shutdown);
    if (this.state !== SessionState.Closed) {
      const next = sessionTransition(this.role, this.state, SessionEvent.Shutdown);
      if (next !== null) this.state = next;
    }
  }

  // ---------------------------------------------------------------------------------------------
  private send(f: Frame): boolean {
    if (carriesSession(f.type) && this.sessionId) f.setStr(Tag.SessionId, this.sessionId);
    return !!this.link && this.link.send(f);
  }
  private sendOrQueue(f: Frame): void {
    if (!this.send(f)) this.reportQueue.push(f); // re-sent after reconnection
  }
  private reply(type: number, ref: number, take: number, accepted: boolean, code: number, text: string): void {
    const r = new Frame(type);
    r.refId = ref;
    r.setU32(Tag.TakeId, take).setU8(Tag.Accepted, accepted ? 1 : 0);
    if (!accepted) {
      r.setU16(Tag.ErrorCode, code).setStr(Tag.ErrorText, text);
      this.refused++;
    }
    this.send(r);
  }
  private refuse(f: Frame, code: number, text: string): void {
    this.log.log("warn", "session", "message_refused", text, { type: msgTypeName(f.type), code: errorCodeName(code), state: sessionStateName(this.state) });
    this.history(`refused ${msgTypeName(f.type)}: ${text}`);
  }

  private sendStatus(force: boolean): void {
    if (!this.link || this.linkState !== LinkState.Connected) return;
    const have = this.role === "performer" ? (this.hooks.backingHave?.() ?? "") : "";
    const payload = `${+this.localReady}${+this.consent}${+this.deliveryConsent}${this.state}${this.reasons.join("; ")}${encodeChecks(this.localChecks)}${have}`;
    const now = this.now();
    if (!force && payload === this.lastStatusPayload && now - this.lastStatusNs < msToNs(this.cfg.statusIntervalMs)) return;
    const f = new Frame(MsgType.ReadyStatus);
    f.setU8(Tag.Ready, this.localReady ? 1 : 0).setU8(Tag.Consent, this.consent ? 1 : 0).setU8(Tag.State, this.state);
    f.setStr(Tag.Reasons, this.reasons.join("; ")).setStr(Tag.ReadyChecks, encodeChecks(this.localChecks));
    if (this.role === "performer") {
      f.setU8(Tag.DeliveryConsent, this.deliveryConsent ? 1 : 0);
      if (have) f.setStr(Tag.BackingHave, have);
    }
    if (this.send(f)) {
      this.lastStatusPayload = payload;
      this.lastStatusNs = now;
    }
  }

  private updateReadiness(): void {
    const local: LocalReadiness = this.port.readiness();
    this.reasons = [...local.reasons];
    this.localChecks = [...local.checks];
    this.localChecks.push({ item: ReadyItem.Consent, ok: this.consent, mandatory: true, detail: this.consent ? "given" : "not given" });
    const up = !!this.link && this.linkState === LinkState.Connected;
    this.localChecks.push({ item: ReadyItem.Connected, ok: up, mandatory: true, detail: up ? "connected" : linkStateName(this.linkState) });
    const stats = this.link?.stats();
    if (this.role === "performer") {
      const n = stats?.offsetSamples ?? 0;
      this.localChecks.push({ item: ReadyItem.ClockOffset, ok: n >= this.cfg.minOffsetSamples, mandatory: true, detail: `${n} of ${this.cfg.minOffsetSamples} samples, +/- ${((stats?.thetaUncertaintyNs ?? 0) / 1e6).toFixed(3)} ms` });
    }
    if (this.role === "performer" && this.incomingOffer) {
      const have = this.hooks.backingHave?.() ?? "";
      const ok = have === this.incomingOffer.id;
      this.localChecks.push({ item: ReadyItem.Backing, ok, mandatory: true, detail: ok ? "received and verified" : "downloading" });
      if (!ok) this.reasons.push("the backing track has not arrived yet");
    }
    if (this.role === "producer" && this.mode === "vocal" && up) {
      const ok = !!this.offered && this.peerBackingHave === this.offered.id;
      this.localChecks.push({ item: ReadyItem.Backing, ok, mandatory: true, detail: ok ? "the singer has it" : this.offered ? "sending to the singer" : "being prepared" });
      if (!ok) this.reasons.push(this.offered ? "the backing track has not reached the singer yet" : "the backing track is still being prepared");
    }
    if (!this.consent) this.reasons.push("recording consent not given");
    // Vocal over a backing track: a take is recorded on the singer's own PC, so a copy of the previous take moving over a slow link must not hold up the next one.
    const vocalMode = this.mode === "vocal" || !!this.incomingOffer;
    const transferring = !vocalMode && !!(this.receiver?.anyActive() || this.sender?.busy);
    if (transferring) this.reasons.push(this.role === "producer" ? "a take transfer is running (Record is available when it ends)" : "sending a take to the producer");
    if (!this.link) {
      this.reasons.push(this.role === "producer" ? "no session created" : "not joined to a session");
    } else if (this.linkState !== LinkState.Connected) {
      this.reasons.push(this.role === "producer" ? "no performer connected" : "not connected to the producer");
    } else if (this.role === "producer") {
      if (!this.peerConsent) this.reasons.push("performer has not consented");
      if (!this.peerReady) this.reasons.push(`performer not ready${this.peerReasons ? `: ${this.peerReasons}` : ""}`);
    } else if ((stats?.offsetSamples ?? 0) < this.cfg.minOffsetSamples) {
      this.reasons.push("measuring clock offset to the producer");
    }
    // Readiness reported to the peer means "this side could record" (excluding the peer).
    this.localReady = local.ok && this.consent && !transferring && !!this.link && this.linkState === LinkState.Connected &&
      (this.role === "producer" || (stats?.offsetSamples ?? 0) >= this.cfg.minOffsetSamples);
    const ready = this.reasons.length === 0;
    if (this.state === SessionState.NotReady || this.state === SessionState.Ready || this.state === SessionState.Completed) {
      const before = this.state;
      this.apply(ready ? SessionEvent.ReadinessOk : SessionEvent.ReadinessLost, ready ? "all readiness conditions hold" : `not ready: ${this.reasons.join("; ")}`);
      if (before !== this.state) this.sendStatus(true);
    }
  }

  // ---------------------------------------------------------------------------------------------
  setStartLeadMs(v: number): void {
    this.cfg.timing.startLeadMs = Math.min(10000, Math.max(300, Math.trunc(v)));
  }
  setAutoStartLead(on: boolean): void {
    this.cfg.timing.autoStartLead = on;
  }

  // Provisional rule (ADR-019/ADR-022): margin + 2 RTT + 2 u + 200 ms, with the SMALLEST round trip of the offset window.
  minStartLeadMs(): number {
    const ls = this.link?.stats();
    const rtt = ls ? (ls.controlRttBestNs >= 0 ? ls.controlRttBestNs : ls.controlRttNs) : 0;
    const extraMs = (2 * Math.max(rtt, 0) + 2 * Math.max(ls?.thetaUncertaintyNs ?? 0, 0)) / 1e6;
    return this.cfg.timing.armAckMarginMs + 200 + Math.ceil(extraMs);
  }
  effectiveStartLeadMs(): number {
    if (!this.cfg.timing.autoStartLead || this.role !== "producer") return this.cfg.timing.startLeadMs;
    const needed = this.minStartLeadMs() + AUTO_START_LEAD_HEADROOM_MS;
    return Math.min(10000, Math.max(300, Math.max(needed, this.cfg.timing.startLeadMs)));
  }

  /** Producer: Record. Returns "" or why not. */
  startTake(opts: { offsetUs?: number } = {}): string {
    if (this.role !== "producer") return "only the producer starts takes";
    this.updateReadiness();
    if (this.state !== SessionState.Ready) return `not ready: ${this.reasons.join("; ")}`;
    const vocal = this.mode === "vocal";
    if (vocal && (!this.offered || this.peerBackingHave !== this.offered.id || (this.link?.joinInfo().protocolMinor ?? 0) < MINOR_BACKING)) return "the singer does not have the backing track yet";
    const lead = this.effectiveStartLeadMs();
    if (lead < this.minStartLeadMs()) return `start lead ${lead} ms is below the minimum ${this.minStartLeadMs()} ms for the measured link`;
    if (!this.apply(SessionEvent.UserRecord, "producer pressed Record")) return "Record is not allowed in this state";
    this.take = newTakeView();
    this.takeOpen = true;
    this.stopOwed = false;
    this.take.takeId = ++this.lastTakeId;
    this.stopAfterStart = false;
    this.take.startLeadMs = lead; // fixed for the whole take
    this.take.vocal = vocal;
    this.take.offsetUs = vocal ? Math.max(0, Math.round(opts.offsetUs ?? 0)) : 0;
    this.take.armSentNs = this.now();
    const f = new Frame(MsgType.Arm).setU32(Tag.TakeId, this.take.takeId).setU32(Tag.MaxTakeSeconds, this.cfg.timing.maxTakeSeconds);
    if (vocal) f.setU8(Tag.Mode, 1).setU64(Tag.OffsetUs, this.take.offsetUs).setStr(Tag.BackingId, this.offered!.id);
    this.take.armSent = this.send(f);
    this.armAckDeadline = this.now() + msToNs(2000);
    this.history(`take ${this.take.takeId}: ARM sent (waiting for the performer's ARM_ACK)`);
    this.log.log("info", "session", "arm_sent", "ARM sent", { take: this.take.takeId });
    this.notify();
    return "";
  }

  /** Producer: Stop. Before the start this CANCELS the take on both PCs; while stopping or finalising it is refused. */
  stopTake(): string {
    if (this.role !== "producer") return "only the producer stops session takes; use Stop & save";
    if (this.state === SessionState.Armed || this.state === SessionState.Scheduled) {
      if (this.take.startAtLocalNs !== 0 && this.take.startAtLocalNs - this.now() < msToNs(150)) {
        this.stopAfterStart = true;
        this.history(`take ${this.take.takeId}: Stop pressed just before the start; it stops right after`);
        return "";
      }
      this.cancelBeforeStart("producer pressed Stop before the start");
      return "";
    }
    if (this.state === SessionState.Stopping || this.state === SessionState.Finalising) return "the take is already stopping; wait until both files are finalised";
    if (this.state !== SessionState.Recording) return "no take is recording";
    const stopAt = this.now() + msToNs(this.cfg.timing.stopLeadMs);
    this.sendStopSchedule(stopAt);
    this.port.scheduleStop(stopAt, false);
    this.apply(SessionEvent.UserStop, "producer pressed Stop");
    this.history(`take ${this.take.takeId}: STOP_SCHEDULE sent${this.take.stopSent ? "" : " FAILED (no connection): the performer keeps recording; STOP is re-sent when it reconnects"}`);
    this.notify();
    return "";
  }

  /** Performer: Stop & save. */
  stopAndSave(): string {
    if (this.role !== "performer") return "use Stop";
    if (this.state !== SessionState.Recording) return "no take is recording";
    this.port.scheduleStop(0, false);
    this.take.stopCmdNs = this.now();
    this.take.stopAtLocalNs = this.take.stopCmdNs;
    this.apply(SessionEvent.UserStopAndSave, "performer pressed Stop & save");
    const f = new Frame(MsgType.LocalStop).setU32(Tag.TakeId, this.take.takeId).setStr(Tag.StopReason, "performer pressed Stop & save");
    this.sendOrQueue(f);
    this.history(`take ${this.take.takeId}: stopped by the performer`);
    this.notify();
    return "";
  }

  // ---------------------------------------------------------------------------------------------
  poll(): void {
    if (this.link) for (const e of this.link.pollEvents()) this.handleLinkEvent(e);
    for (const e of this.port.poll()) this.handlePortEvent(e);
    this.checkTimers();
    this.pollTransfers();
    this.updateReadiness();
    this.sendStatus(false);
    this.notify();
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private handleLinkEvent(e: LinkEvent): void {
    switch (e.kind) {
      case "state": {
        const old = this.linkState;
        this.linkState = e.state;
        this.log.log(e.state === LinkState.LinkLost ? "warn" : "info", "link", "state", e.text, { from: linkStateName(old), to: linkStateName(e.state) });
        this.history(`link ${linkStateName(e.state)}: ${e.text}`);
        if (old === LinkState.Connected && e.state !== LinkState.Connected) {
          this.peerReady = false;
          const beforeStart = this.state === SessionState.Armed || this.state === SessionState.Scheduled;
          if (this.state === SessionState.Scheduled) this.port.cancelTake(); // never start a take the other side cannot see
          this.apply(SessionEvent.LinkLost, "control link lost");
          if (beforeStart && this.takeOpen && !this.take.localStarted) {
            this.take.cancelled = true;
            this.take.cancelReason = "control link lost before the start";
            this.history(`take ${this.take.takeId}: cancelled, control link lost before the start`);
            this.logTakeTiming("cancelled");
          }
          if (this.state === SessionState.NotReady) this.takeOpen = this.takeOpen && this.take.localStarted;
        }
        if (this.role === "performer" && e.state === LinkState.Disconnected && this.state === SessionState.Recording) {
          // The session is over for good: nobody can send STOP any more, so stop and save the local take now.
          this.port.scheduleStop(this.now(), true);
          this.apply(SessionEvent.StopReceived, "session ended while recording");
          this.history(`take ${this.take.takeId}: session ended while recording; local take stopped and saved`);
        }
        break;
      }
      case "joined": {
        const info = this.link!.joinInfo();
        if (this.role === "performer") this.sessionId = info.sessionId;
        this.log.log("info", "link", e.resumed ? "rejoined" : "joined", e.text, { session: info.sessionId, peer: info.peerName, peer_address: info.peerAddress, peer_version: info.peerAppVersion });
        this.history(`${e.resumed ? "reconnected" : "connected"} (${info.peerName} at ${info.peerAddress})`);
        this.lastStatusPayload = "";
        this.sendStatus(true);
        if (this.role === "producer" && this.stopOwed && this.take.takeId !== 0 && !this.take.peerFinalised) {
          const sent = this.sendStopSchedule(this.now() + msToNs(this.cfg.timing.stopLeadMs));
          this.history(`take ${this.take.takeId}: STOP_SCHEDULE ${sent ? "re-sent after reconnecting (the performer's take ends later than the producer's)" : "still could not be sent"}`);
          this.log.log("warn", "session", "stop_resent", "STOP_SCHEDULE re-sent after reconnecting", { take: this.take.takeId, sent });
        }
        if (this.role === "producer" && this.offered) this.sendOffer();
        while (this.reportQueue.length) {
          if (!this.send(this.reportQueue[0]!)) break;
          this.reportQueue.shift();
        }
        break;
      }
      case "frame":
        this.handleFrame(e.frame);
        break;
      case "peer-closed":
        this.peerReady = false;
        this.peerConsent = false;
        this.history(e.text);
        this.log.log("info", "link", "peer_closed", e.text);
        break;
      case "join-rejected":
        this.lastError = e.text;
        this.history(`join refused: ${e.text}`);
        this.log.log("warn", "link", "join_rejected", e.text, { code: errorCodeName(e.code) });
        break;
      case "protocol-error":
        this.lastError = e.text;
        this.history(e.text);
        this.log.log("error", "link", "protocol_error", e.text);
        break;
      case "info":
        this.log.log("info", "link", "info", e.text);
        break;
    }
  }

  private handleFrame(f: Frame): void {
    if (f.type === MsgType.ReadyStatus) {
      this.peerReady = (f.u8(Tag.Ready) ?? 0) !== 0;
      this.peerConsent = (f.u8(Tag.Consent) ?? 0) !== 0;
      this.peerReasons = f.str(Tag.Reasons) ?? "";
      this.peerChecks = decodeChecks(f.str(Tag.ReadyChecks) ?? "");
      this.peerDeliveryConsent = (f.u8(Tag.DeliveryConsent) ?? 0) !== 0;
      this.peerBackingHave = f.str(Tag.BackingHave) ?? "";
      return;
    }
    if (carriesSession(f.type) && this.sessionId) {
      const sid = f.str(Tag.SessionId);
      if (sid !== undefined && sid !== this.sessionId) {
        this.refused++;
        this.log.log("warn", "session", "wrong_session", "command for another session refused", { type: msgTypeName(f.type), expected: this.sessionId, got: sid });
        this.history(`refused ${msgTypeName(f.type)} for another session (${sid})`);
        this.refuse(f, ErrorCode.UnknownTake, "session id mismatch");
        return;
      }
    }
    if (f.type === MsgType.Error) {
      const code = f.u16(Tag.ErrorCode) ?? 0;
      this.lastError = `${errorCodeName(code)}: ${f.str(Tag.ErrorText) ?? ""}`;
      this.history(`peer reported ${this.lastError}`);
      this.log.log("warn", "session", "peer_error", this.lastError);
      return;
    }
    if (this.role === "producer") this.producerFrame(f);
    else this.performerFrame(f);
  }

  private producerFrame(f: Frame): void {
    const take = f.u32(Tag.TakeId) ?? 0;
    const current = this.takeOpen && take === this.take.takeId;
    const tag = `take ${take}: `;
    const t = this.take;
    switch (f.type) {
      case MsgType.ArmAck: {
        if (!current || this.state !== SessionState.Armed || t.peerArmAck) {
          this.duplicates++;
          return this.refuse(f, ErrorCode.UnknownTake, "stale or duplicate ARM_ACK ignored");
        }
        if ((f.u8(Tag.Accepted) ?? 0) === 0) {
          const why = f.str(Tag.ErrorText) ?? "refused";
          this.history(`${tag}performer REFUSED ARM: ${why}`);
          this.lastError = `performer refused the take: ${why}`;
          this.apply(SessionEvent.TakeRefused, "performer refused ARM");
          this.takeOpen = false;
          return;
        }
        t.peerArmAck = true;
        t.armAckRxNs = this.now();
        this.apply(SessionEvent.ArmAckReceived, "performer accepted ARM");
        const startAt = this.now() + msToNs(t.startLeadMs);
        t.startAtLocalNs = startAt;
        const ls = this.link!.stats();
        t.thetaNs = ls.thetaNs;
        t.thetaUncNs = ls.thetaUncertaintyNs;
        t.offsetSamples = ls.offsetSamples;
        t.scheduleSentNs = this.now();
        t.scheduleSent = this.send(new Frame(MsgType.ScheduleStart).setU32(Tag.TakeId, t.takeId).setI64(Tag.StartAtNs, startAt));
        this.startAckDeadline = startAt - msToNs(this.cfg.timing.armAckMarginMs);
        this.history(`${tag}ARM_ACK received; SCHEDULE_START sent (start in ${t.startLeadMs} ms)`);
        return;
      }
      case MsgType.StartAck: {
        if (!current || this.state !== SessionState.Armed || !t.peerArmAck || t.peerStartAck) {
          this.duplicates++;
          return this.refuse(f, ErrorCode.UnknownTake, "stale or duplicate START_ACK ignored");
        }
        if ((f.u8(Tag.Accepted) ?? 0) === 0) {
          const why = f.str(Tag.ErrorText) ?? "refused";
          this.history(`${tag}performer REFUSED the start: ${why}`);
          this.lastError = `performer refused the start: ${why}`;
          this.apply(SessionEvent.TakeRefused, "performer refused SCHEDULE_START");
          this.takeOpen = false;
          return;
        }
        t.peerStartAck = true;
        t.startAckRxNs = this.now();
        t.peerPlannedStartNs = f.i64(Tag.PlannedLocalNs) ?? 0;
        const spec: PortTakeSpec = { takeId: t.takeId, sessionId: this.sessionId, role: "producer", maxTakeSeconds: this.cfg.timing.maxTakeSeconds, startAtNs: t.startAtLocalNs, ...(t.vocal ? { vocal: { offsetUs: t.offsetUs, backingId: this.offered?.id ?? "" } } : {}) };
        const error = this.port.scheduleTake(spec);
        if (error) {
          this.send(new Frame(MsgType.Cancel).setU32(Tag.TakeId, t.takeId).setU16(Tag.ErrorCode, ErrorCode.DiskWrite));
          this.lastError = `local recording could not be scheduled: ${error}`;
          this.history(`${tag}local schedule FAILED (${error}); CANCEL sent`);
          this.apply(SessionEvent.TakeRefused, "local schedule failed");
          this.takeOpen = false;
          return;
        }
        this.apply(SessionEvent.StartAckReceived, "performer confirmed the start time");
        this.history(`${tag}START_ACK received; both scheduled`);
        return;
      }
      case MsgType.TakeStarted:
        if (!current || t.peerStarted) {
          this.duplicates++;
          return;
        }
        t.peerStarted = true;
        t.peerStartedRxNs = this.now();
        t.peerFirstFrame = f.u64(Tag.FirstFrame) ?? 0;
        t.peerFirstSampleNs = f.i64(Tag.FirstSampleNs) ?? 0;
        t.peerLateFrames = f.u64(Tag.LateFrames) ?? 0;
        this.history(`${tag}performer CONFIRMED its recording started${t.peerLateFrames ? ` (late by ${t.peerLateFrames} frames)` : ""}`);
        this.computeStartOffset();
        return;
      case MsgType.StopAck:
        if (take === 0 || take !== t.takeId || t.peerStopAck) {
          this.duplicates++;
          return;
        }
        t.peerStopAck = (f.u8(Tag.Accepted) ?? 0) !== 0;
        t.stopAckRxNs = this.now();
        this.history(`${tag}${t.peerStopAck ? "STOP_ACK received" : `performer refused STOP: ${f.str(Tag.ErrorText) ?? ""}`}`);
        return;
      case MsgType.LocalStop:
        this.history(`${tag}performer stopped its own recording: ${f.str(Tag.StopReason) ?? ""}`);
        return;
      case MsgType.TakeFinalised:
        if (take !== t.takeId || t.peerFinalised) {
          this.duplicates++;
          return;
        }
        t.peerFinalised = true;
        t.peerFinalisedRxNs = this.now();
        this.stopOwed = false;
        t.peerStatus = (f.u8(Tag.Status) ?? 0) as TakeStatus;
        t.peerFrames = f.u64(Tag.Frames) ?? 0;
        t.peerLatencyUs = f.u32(Tag.LatencyUs) ?? 0;
        this.finished.set(take, { status: t.peerStatus, frames: t.peerFrames, file: "" });
        if (this.cfg.autoTransfer) this.autoQueue.push(take); // requested once this take has ended on both PCs
        this.history(`${tag}performer's take ${takeStatusName(t.peerStatus)}, ${t.peerFrames} frames`);
        this.maybeComplete();
        return;
      case MsgType.BackingAck:
        this.history((f.u8(Tag.Accepted) ?? 0) !== 0 ? "singer accepted the backing track and is downloading it" : `singer cannot take the backing track: ${f.str(Tag.ErrorText) ?? ""}`);
        return;
      case MsgType.PlayAck:
        this.singerHearing = (f.u8(Tag.Accepted) ?? 0) !== 0;
        this.history(this.singerHearing ? "singer is playing the backing track" : `singer cannot play the backing track: ${f.str(Tag.ErrorText) ?? ""}`);
        if (!this.singerHearing) this.lastError = `the singer cannot play the backing track: ${f.str(Tag.ErrorText) ?? ""}`;
        return;
      case MsgType.TransferAck:
        if ((f.u8(Tag.Accepted) ?? 0) !== 0) {
          this.history(`${tag}performer is sending its take (copy; its original stays on the performer's PC)`);
        } else {
          const code = f.u16(Tag.ErrorCode) ?? 0;
          const why = `performer refused: ${errorCodeName(code)}: ${f.str(Tag.ErrorText) ?? ""}`;
          this.history(`${tag}transfer ${why}`);
          this.receiver?.cancel(take, why);
          if (code === ErrorCode.Busy && this.cfg.autoTransfer) {
            // The singer is still sending an earlier take or recording the next one: ask again in a moment.
            this.history(`${tag}will ask again in a moment`);
            setTimeout(() => { if (this.link) this.autoQueue.push(take); }, 2000);
          }
        }
        return;
      default:
        this.refused++;
        this.refuse(f, ErrorCode.ProtocolMalformed, "message not valid for the producer");
    }
  }

  private performerFrame(f: Frame): void {
    const take = f.u32(Tag.TakeId) ?? 0;
    const now = this.now();
    const t = this.take;
    switch (f.type) {
      case MsgType.Arm: {
        if (take <= this.lastTakeId) {
          this.duplicates++;
          this.reply(MsgType.ArmAck, f.msgId, take, false, ErrorCode.TakeIdConflict, "take id already used (duplicate or delayed ARM)");
          return this.refuse(f, ErrorCode.TakeIdConflict, "duplicate or delayed ARM");
        }
        const vocalArm = f.u8(Tag.Mode) === 1;
        if (vocalArm) {
          const want = f.str(Tag.BackingId) ?? "";
          if (!want || (this.hooks.backingHave?.() ?? "") !== want) {
            this.reply(MsgType.ArmAck, f.msgId, take, false, ErrorCode.NotReady, "the backing track has not arrived on this PC");
            return this.refuse(f, ErrorCode.NotReady, "backing track not received");
          }
        }
        this.updateReadiness();
        if (sessionTransition("performer", this.state, SessionEvent.ArmReceived) === null) {
          const code = !this.consent ? ErrorCode.NoConsent : this.state === SessionState.NotReady ? ErrorCode.NotReady : ErrorCode.Busy;
          const text = this.state === SessionState.NotReady ? `not ready: ${this.reasons.join("; ")}` : `busy (${sessionStateName(this.state)})`;
          this.reply(MsgType.ArmAck, f.msgId, take, false, code, text);
          this.refuse(f, code, text);
          this.invalidEvents++;
          return;
        }
        this.apply(SessionEvent.ArmReceived, `producer armed take ${take}`);
        this.take = newTakeView();
        this.takeOpen = true;
        this.take.takeId = take;
        this.take.armRxNs = now;
        this.take.vocal = vocalArm;
        this.take.offsetUs = vocalArm ? (f.u64(Tag.OffsetUs) ?? 0) : 0;
        this.vocalBackingId = vocalArm ? (f.str(Tag.BackingId) ?? "") : "";
        this.lastTakeId = take;
        this.scheduleDeadline = now + msToNs(this.cfg.armToScheduleTimeoutMs);
        this.reply(MsgType.ArmAck, f.msgId, take, true, ErrorCode.Ok, "");
        this.history(`take ${take}: ARM accepted`);
        return;
      }
      case MsgType.ScheduleStart: {
        const current = this.takeOpen && take === t.takeId;
        if (current && t.peerStartAck) {
          // Duplicate SCHEDULE_START: answer again, never schedule a second recording.
          this.duplicates++;
          const r = new Frame(MsgType.StartAck);
          r.refId = f.msgId;
          r.setU32(Tag.TakeId, take).setU8(Tag.Accepted, 1).setI64(Tag.PlannedLocalNs, t.startAtLocalNs);
          this.send(r);
          return;
        }
        if (!current || this.state !== SessionState.Armed) {
          this.reply(MsgType.StartAck, f.msgId, take, false, ErrorCode.UnknownTake, "no armed take with this id");
          return this.refuse(f, ErrorCode.UnknownTake, "SCHEDULE_START for an unknown take");
        }
        t.scheduleRxNs = now;
        const ls = this.link!.stats();
        // theta = producer clock - performer clock, so the producer's time T is T - theta here.
        const startLocal = (f.i64(Tag.StartAtNs) ?? 0) - ls.thetaNs;
        if (ls.offsetSamples < this.cfg.minOffsetSamples) {
          this.reply(MsgType.StartAck, f.msgId, take, false, ErrorCode.NotReady, "clock offset not yet measured");
          this.apply(SessionEvent.TakeRefused, "no clock offset yet");
          this.takeOpen = false;
          return;
        }
        if (startLocal - now < msToNs(this.cfg.timing.armAckMarginMs)) {
          this.reply(MsgType.StartAck, f.msgId, take, false, ErrorCode.ArmTooLate, `start time already passed or less than ${this.cfg.timing.armAckMarginMs} ms away`);
          this.refuse(f, ErrorCode.ArmTooLate, "start too late");
          this.apply(SessionEvent.TakeRefused, "start time too late");
          this.takeOpen = false;
          return;
        }
        const spec: PortTakeSpec = { takeId: take, sessionId: this.sessionId, role: "performer", maxTakeSeconds: this.cfg.timing.maxTakeSeconds, startAtNs: startLocal, ...(t.vocal ? { vocal: { offsetUs: t.offsetUs, backingId: this.vocalBackingId } } : {}) };
        const error = this.port.scheduleTake(spec);
        if (error) {
          this.reply(MsgType.StartAck, f.msgId, take, false, ErrorCode.DiskWrite, error);
          this.refuse(f, ErrorCode.DiskWrite, `local schedule failed: ${error}`);
          this.apply(SessionEvent.TakeRefused, "local schedule failed");
          this.takeOpen = false;
          return;
        }
        this.apply(SessionEvent.ScheduleReceived, "start scheduled");
        t.peerStartAck = true; // here: "we acknowledged"
        t.startAtLocalNs = startLocal;
        t.thetaNs = ls.thetaNs;
        t.thetaUncNs = ls.thetaUncertaintyNs;
        t.offsetSamples = ls.offsetSamples;
        const r = new Frame(MsgType.StartAck);
        r.refId = f.msgId;
        r.setU32(Tag.TakeId, take).setU8(Tag.Accepted, 1).setI64(Tag.PlannedLocalNs, startLocal).setI64(Tag.ThetaNs, ls.thetaNs).setI64(Tag.UncertaintyNs, ls.thetaUncertaintyNs);
        this.send(r);
        t.startAckSentNs = this.now();
        this.history(`take ${take}: start scheduled in ${Math.trunc((startLocal - now) / 1e6)} ms (clock offset ${Math.trunc(ls.thetaNs / 1000)} us +/- ${Math.trunc(ls.thetaUncertaintyNs / 1000)} us)`);
        return;
      }
      case MsgType.Cancel: {
        if (this.takeOpen && take === t.takeId && (this.state === SessionState.Armed || this.state === SessionState.Scheduled)) {
          this.port.cancelTake();
          this.apply(SessionEvent.CancelReceived, `producer cancelled take ${take}`);
          this.takeOpen = false;
          t.cancelled = true;
          t.cancelReason = "cancelled by the producer";
          this.history(`take ${take}: cancelled by the producer`);
          this.logTakeTiming("cancelled");
        } else if (this.takeOpen && take === t.takeId && this.state === SessionState.Recording) {
          // The CANCEL crossed the start (Stop pressed at the last moment): keep what was recorded.
          this.port.scheduleStop(now, true);
          t.stopCmdNs = now;
          t.stopAtLocalNs = now;
          this.apply(SessionEvent.StopReceived, "CANCEL arrived after the local start");
          this.history(`take ${take}: CANCEL arrived after the local start; take stopped and saved`);
        } else {
          this.duplicates++;
        }
        return;
      }
      case MsgType.StopSchedule: {
        const current = this.takeOpen && take === t.takeId;
        if (current && (this.state === SessionState.Stopping || this.state === SessionState.Finalising || this.state === SessionState.Completed || t.stopSent)) {
          this.duplicates++;
          this.reply(MsgType.StopAck, f.msgId, take, true, ErrorCode.Ok, ""); // idempotent
          return;
        }
        if (!current || this.state !== SessionState.Recording) {
          this.reply(MsgType.StopAck, f.msgId, take, false, ErrorCode.UnknownTake, "no recording take with this id");
          return this.refuse(f, ErrorCode.UnknownTake, "STOP for an unknown take");
        }
        const stopLocal = (f.i64(Tag.StopAtNs) ?? 0) - this.link!.stats().thetaNs;
        this.port.scheduleStop(Math.max(stopLocal, now), true);
        t.stopCmdNs = now;
        t.stopAtLocalNs = Math.max(stopLocal, now);
        this.apply(SessionEvent.StopReceived, `producer stopped take ${take}`);
        t.stopSent = true; // here: "stop accepted"
        this.reply(MsgType.StopAck, f.msgId, take, true, ErrorCode.Ok, "");
        this.history(`take ${take}: stop scheduled by the producer`);
        return;
      }
      case MsgType.BackingOffer: {
        const offer: BackingOffer = { id: f.str(Tag.BackingId) ?? "", port: f.u16(Tag.BackingPort) ?? 0, token: f.str(Tag.BackingToken) ?? "", bytes: f.u64(Tag.BackingBytes) ?? 0 };
        if (!/^[0-9a-f]{64}$/.test(offer.id) || !/^[0-9a-f]{32}$/.test(offer.token) || !offer.port || !offer.bytes || !this.link) {
          const r = new Frame(MsgType.BackingAck).setU8(Tag.Accepted, 0).setStr(Tag.ErrorText, "malformed backing track offer");
          r.refId = f.msgId;
          this.send(r);
          return this.refuse(f, ErrorCode.ProtocolMalformed, "malformed backing track offer");
        }
        const same = this.incomingOffer?.id === offer.id;
        this.incomingOffer = offer;
        const r = new Frame(MsgType.BackingAck).setU8(Tag.Accepted, 1);
        r.refId = f.msgId;
        this.send(r);
        this.history(same ? "producer re-announced the backing track" : `producer announced a backing track (${(offer.bytes / 1048576).toFixed(1)} MB)`);
        this.hooks.onBackingOffer?.({ ...offer, host: this.link.joinInfo().peerAddress });
        return;
      }
      case MsgType.PlayBacking: {
        const id = f.str(Tag.BackingId) ?? "";
        const no = (text: string) => {
          const r = new Frame(MsgType.PlayAck).setU8(Tag.Accepted, 0).setStr(Tag.ErrorText, text);
          r.refId = f.msgId;
          this.send(r);
          this.refuse(f, ErrorCode.NotReady, text);
        };
        if (isTakeRunning(this.state) || this.state === SessionState.Armed || this.state === SessionState.Scheduled) return no("a take is being recorded");
        if (!id || (this.hooks.backingHave?.() ?? "") !== id) return no("the backing track has not arrived on this PC");
        if ((this.link?.stats().offsetSamples ?? 0) < this.cfg.minOffsetSamples) return no("the clock offset has not been measured yet");
        const startLocal = (f.i64(Tag.StartAtNs) ?? 0) - this.link!.stats().thetaNs;
        if (startLocal - now < msToNs(this.cfg.timing.armAckMarginMs)) return no("the start time is too close");
        const why = this.hooks.onPlayBacking?.(startLocal, f.u64(Tag.OffsetUs) ?? 0) ?? "playing the backing track is not available";
        if (why) return no(why);
        this.backingPlaying = true;
        const r = new Frame(MsgType.PlayAck).setU8(Tag.Accepted, 1);
        r.refId = f.msgId;
        this.send(r);
        this.history(`playing the backing track from ${((f.u64(Tag.OffsetUs) ?? 0) / 1e6).toFixed(2)} s in ${Math.trunc((startLocal - now) / 1e6)} ms`);
        return;
      }
      case MsgType.StopBacking:
        this.backingPlaying = false;
        this.hooks.onStopBacking?.();
        this.history("the producer stopped the backing track");
        return;
      case MsgType.TransferRequest:
        return this.performerTransferRequest(f);
      default:
        this.refused++;
        this.refuse(f, ErrorCode.ProtocolMalformed, "message not valid for the performer");
    }
  }

  private handlePortEvent(e: PortEvent): void {
    if (!this.takeOpen || e.takeId !== this.take.takeId) {
      this.log.log("warn", "session", "stale_recorder_event", "recorder event for another take", { take: e.takeId });
      return;
    }
    const t = this.take;
    const tag = `take ${e.takeId}: `;
    if (e.kind === "started") {
      t.localStarted = true;
      t.localFirstSampleNs = e.firstSampleNs;
      t.localLateFrames = e.lateFrames;
      t.localStartedSeenNs = this.now();
      t.localFirstFrame = e.firstFrame;
      t.devicePeriodFrames = e.devicePeriodFrames;
      t.devicePeriods = e.devicePeriods;
      this.apply(SessionEvent.LocalTakeStarted, "local recording started");
      this.history(`${tag}LOCAL recording started${e.lateFrames ? ` (late by ${e.lateFrames} frames)` : ""}`);
      if (this.role === "performer") {
        const f = new Frame(MsgType.TakeStarted).setU32(Tag.TakeId, e.takeId).setU64(Tag.FirstFrame, e.firstFrame).setI64(Tag.FirstSampleNs, e.firstSampleNs).setU64(Tag.LateFrames, e.lateFrames);
        this.sendOrQueue(f);
      }
      this.computeStartOffset();
      if (this.stopAfterStart && this.role === "producer") {
        this.stopAfterStart = false;
        this.stopTake();
      }
      return;
    }
    // finalised (or cancelled)
    if (e.status === TakeStatus.Cancelled) {
      this.history(`${tag}local take cancelled (no audio file)`);
      return;
    }
    if (this.state === SessionState.Scheduled) {
      // The recorder gave up before the take ever started (e.g. the microphone never delivered audio): nothing was recorded here.
      this.history(`${tag}local recorder failed before the start: ${e.stopReason}${e.error ? `: ${e.error}` : ""}`);
      this.lastError = `local recording did not start: ${e.stopReason}`;
      if (this.role === "producer") this.send(new Frame(MsgType.Cancel).setU32(Tag.TakeId, t.takeId).setU16(Tag.ErrorCode, ErrorCode.Device));
      else this.sendOrQueue(new Frame(MsgType.TakeFinalised).setU32(Tag.TakeId, t.takeId).setU8(Tag.Status, e.status).setU64(Tag.Frames, 0).setStr(Tag.StopReason, e.stopReason));
      t.cancelled = true;
      t.cancelReason = e.stopReason;
      this.apply(SessionEvent.TakeRefused, "local recorder failed before the start");
      this.takeOpen = false;
      this.logTakeTiming("cancelled");
      return;
    }
    t.localFinalised = true;
    t.localFinalisedNs = this.now();
    t.localStatus = e.status;
    t.localFrames = e.frames;
    t.localFile = e.file;
    t.localError = e.error;
    if (this.state === SessionState.Recording) {
      this.apply(SessionEvent.LocalFault, `local take ended early: ${e.stopReason}`);
      if (this.role === "producer") {
        // Make the performer stop too, so both takes cover the same span.
        this.sendStopSchedule(this.now() + msToNs(this.cfg.timing.stopLeadMs));
      } else {
        this.sendOrQueue(new Frame(MsgType.LocalStop).setU32(Tag.TakeId, t.takeId).setStr(Tag.StopReason, e.stopReason + (e.error ? `: ${e.error}` : "")));
      }
    }
    this.apply(SessionEvent.LocalFinalised, `local take ${takeStatusName(e.status)}`);
    this.history(`${tag}LOCAL take ${takeStatusName(e.status)}${e.finalised ? " (finalised)" : " (NOT finalised)"}, ${e.frames} frames${e.error ? `, ${e.error}` : ""}`);
    if (this.role === "performer" && e.finalised) this.finished.set(e.takeId, { status: e.status, frames: e.frames, file: e.file }); // candidate for transfer
    if (this.role === "performer") {
      const f = new Frame(MsgType.TakeFinalised).setU32(Tag.TakeId, e.takeId).setU8(Tag.Status, e.status).setU64(Tag.Frames, e.frames).setStr(Tag.StopReason, e.stopReason);
      if (t.vocal) f.setU32(Tag.LatencyUs, e.latencyUs);
      this.sendOrQueue(f);
      this.takeOpen = false;
      this.logTakeTiming(takeStatusName(e.status));
    } else {
      this.maybeComplete();
    }
  }

  /** Producer: tell the performer to stop at stopAt (this PC's clock). If there is no connection the stop is owed and re-sent when it reconnects. */
  private sendStopSchedule(stopAt: number): boolean {
    const f = new Frame(MsgType.StopSchedule).setU32(Tag.TakeId, this.take.takeId).setI64(Tag.StopAtNs, stopAt);
    this.take.stopCmdNs = this.now();
    this.take.stopAtLocalNs = stopAt;
    this.take.stopSent = this.send(f);
    this.stopOwed = !this.take.stopSent;
    this.stopAckDeadline = this.now() + msToNs(2000);
    this.peerReportDeadline = stopAt + msToNs(this.cfg.timing.finaliseReportWaitMs);
    return this.take.stopSent;
  }

  private maybeComplete(): void {
    if (this.role !== "producer" || this.state !== SessionState.Finalising || !this.take.localFinalised) return;
    if (this.take.peerFinalised || this.take.peerReportTimedOut) {
      this.apply(SessionEvent.TakeComplete, this.take.peerFinalised ? "both takes reported" : "performer report timed out");
      this.takeOpen = false;
      this.logTakeTiming(this.take.peerFinalised ? "complete" : "performer report timed out");
    }
  }

  private computeStartOffset(): void {
    const t = this.take;
    if (this.role !== "producer" || !t.localStarted || !t.peerStarted || !this.link) return;
    const ls = this.link.stats(); // theta = performer - producer (producer is requester)
    const delta = t.peerFirstSampleNs - ls.thetaNs - t.localFirstSampleNs;
    t.hasStartOffset = true;
    t.startOffsetMs = delta / 1e6;
    t.startOffsetUncMs = ls.thetaUncertaintyNs / 1e6;
    const text = `take ${t.takeId}: estimated recording-start offset (performer - producer) ${t.startOffsetMs.toFixed(3)} ms +/- ${t.startOffsetUncMs.toFixed(3)} ms (clock-offset uncertainty only; device input latency not included)`;
    this.history(text);
    this.log.log("info", "session", "start_offset_estimate", text);
  }

  private checkTimers(): void {
    const now = this.now();
    const t = this.take;
    if (this.role === "producer" && this.takeOpen) {
      if (this.state === SessionState.Armed && !t.peerArmAck && now > this.armAckDeadline) {
        this.send(new Frame(MsgType.Cancel).setU32(Tag.TakeId, t.takeId).setU16(Tag.ErrorCode, ErrorCode.Timeout));
        this.lastError = "performer did not confirm ARM in time";
        this.history(`take ${t.takeId}: no ARM_ACK in time; CANCEL sent`);
        this.apply(SessionEvent.TakeRefused, "ARM_ACK timeout");
        this.takeOpen = false;
      } else if (this.state === SessionState.Armed && t.peerArmAck && !t.peerStartAck && now > this.startAckDeadline) {
        this.send(new Frame(MsgType.Cancel).setU32(Tag.TakeId, t.takeId).setU16(Tag.ErrorCode, ErrorCode.Timeout));
        this.lastError = "performer did not confirm the start time in time";
        this.history(`take ${t.takeId}: no START_ACK before the start; CANCEL sent`);
        this.apply(SessionEvent.TakeRefused, "START_ACK timeout");
        this.takeOpen = false;
      } else if (this.state === SessionState.Finalising && !t.peerFinalised && now > this.peerReportDeadline && !t.peerReportTimedOut) {
        t.peerReportTimedOut = true;
        this.history(`take ${t.takeId}: no report from the performer: its take status is UNKNOWN`);
        this.maybeComplete();
      } else if (this.state === SessionState.Stopping && t.stopSent && !t.peerStopAck && now > this.stopAckDeadline && this.stopAckDeadline !== 0) {
        this.history(`take ${t.takeId}: no STOP_ACK yet (performer may not have stopped)`);
        this.stopAckDeadline = 0;
      }
    }
    if (this.role === "performer" && this.takeOpen && this.state === SessionState.Armed && now > this.scheduleDeadline) {
      this.history(`take ${t.takeId}: no SCHEDULE_START after ARM; disarmed`);
      this.apply(SessionEvent.ArmExpired, "no schedule after ARM");
      this.takeOpen = false;
    }
  }

  private cancelBeforeStart(why: string): void {
    this.send(new Frame(MsgType.Cancel).setU32(Tag.TakeId, this.take.takeId).setU16(Tag.ErrorCode, ErrorCode.Cancelled));
    this.port.cancelTake();
    this.take.cancelled = true;
    this.take.cancelReason = why;
    this.history(`take ${this.take.takeId}: ${why}; CANCEL sent, nothing recorded`);
    this.apply(SessionEvent.TakeRefused, why);
    this.takeOpen = false;
    this.logTakeTiming("cancelled");
  }

  /** One "take_timing" record per take, on this PC's monotonic clock (ADR-019). */
  private logTakeTiming(outcome: string): void {
    const t = this.take;
    const producer = this.role === "producer";
    const f: Record<string, string | number | boolean> = {
      take: t.takeId, session: this.sessionId, role: this.role, outcome, start_lead_ms: t.startLeadMs, start_at_local_ns: t.startAtLocalNs,
      local_first_sample_ns: t.localFirstSampleNs, local_first_frame: t.localFirstFrame, local_late_frames: t.localLateFrames,
      first_sample_minus_scheduled_ms: msBetween(t.startAtLocalNs, t.localFirstSampleNs), local_start_seen_ns: t.localStartedSeenNs, stop_cmd_ns: t.stopCmdNs,
      stop_at_local_ns: t.stopAtLocalNs, local_finalised_ns: t.localFinalisedNs, local_status: t.localFinalised ? takeStatusName(t.localStatus) : "none",
      local_frames: t.localFrames, theta_ns: t.thetaNs, theta_uncertainty_ns: t.thetaUncNs, offset_samples: t.offsetSamples,
    };
    if (producer) {
      Object.assign(f, {
        arm_sent_ns: t.armSentNs, arm_ack_rx_ns: t.armAckRxNs, schedule_sent_ns: t.scheduleSentNs, start_ack_rx_ns: t.startAckRxNs,
        arm_to_ack_ms: msBetween(t.armSentNs, t.armAckRxNs), schedule_to_ack_ms: msBetween(t.scheduleSentNs, t.startAckRxNs),
        ack_margin_before_start_ms: msBetween(t.startAckRxNs, t.startAtLocalNs), peer_planned_start_ns: t.peerPlannedStartNs, peer_first_sample_ns: t.peerFirstSampleNs,
        peer_late_frames: t.peerLateFrames, peer_status: t.peerFinalised ? takeStatusName(t.peerStatus) : "unknown", peer_frames: t.peerFrames,
        start_offset_estimate_ms: t.hasStartOffset ? t.startOffsetMs.toFixed(3) : "n/a", start_offset_uncertainty_ms: t.hasStartOffset ? t.startOffsetUncMs.toFixed(3) : "n/a",
      });
    } else {
      Object.assign(f, { arm_rx_ns: t.armRxNs, schedule_rx_ns: t.scheduleRxNs, start_ack_sent_ns: t.startAckSentNs, schedule_rx_to_start_ms: msBetween(t.scheduleRxNs, t.startAtLocalNs) });
    }
    if (t.cancelled) f.cancel_reason = t.cancelReason;
    this.log.log("info", "session", "take_timing", "take timing record (monotonic ns of this PC)", f);
    this.history(`take ${t.takeId} timing: first sample ${msBetween(t.startAtLocalNs, t.localFirstSampleNs)} ms after the scheduled time (${t.localLateFrames} late frames), ${t.localFrames} frames, ${outcome}`);
  }

  // ---------------------------------------------------------------------------------------------
  // Take transfer (Stage 11): the control link carries only the request and its answer; the file moves on its own TCP connection.

  setAutoTransfer(on: boolean): void { this.cfg.autoTransfer = on; }

  // ---- vocal over a backing track ----

  /** Producer: "vocal": only the singer is recorded, over the backing track; "both": each PC records its own microphone (the original behaviour). */
  setMode(mode: "both" | "vocal"): void {
    if (this.role === "producer") this.mode = mode;
  }
  get currentMode(): "both" | "vocal" { return this.mode; }

  private sendOffer(): boolean {
    const o = this.offered;
    if (!o || !this.link || this.linkState !== LinkState.Connected || (this.link.joinInfo().protocolMinor ?? 0) < MINOR_BACKING) return false;
    const f = new Frame(MsgType.BackingOffer).setStr(Tag.BackingId, o.id).setU16(Tag.BackingPort, o.port).setStr(Tag.BackingToken, o.token).setU64(Tag.BackingBytes, o.bytes);
    return this.send(f);
  }

  /** Producer: announce a rendered backing track the singer should download (the token is never logged). */
  offerBacking(o: BackingOffer): boolean {
    if (this.role !== "producer") return false;
    this.offered = o;
    this.log.log("info", "backing", "offered", "backing track offered", { id: o.id, bytes: o.bytes, token: "<redacted>" });
    const sent = this.sendOffer();
    if (sent) this.history(`backing track announced to the singer (${(o.bytes / 1048576).toFixed(1)} MB)`);
    return sent;
  }
  withdrawBacking(): void { this.offered = null; }
  get peerHasBacking(): boolean { return !!this.offered && this.peerBackingHave === this.offered.id; }
  get peerSupportsBacking(): boolean { return (this.link?.joinInfo().protocolMinor ?? 0) >= MINOR_BACKING; }

  /**
   * Producer: let the singer hear the backing track from `offsetUs` (the producer's Play button). The singer starts at `startAtNs` on this PC's
   * clock; the caller starts the producer's own playback at the same moment. Returns the start time, or why not.
   */
  playBacking(offsetUs: number): { error: string; startAtNs: number } {
    if (this.role !== "producer") return { error: "only the producer plays the backing track", startAtNs: 0 };
    if (!this.link || this.linkState !== LinkState.Connected) return { error: "the singer is not connected", startAtNs: 0 };
    if (!this.peerSupportsBacking) return { error: "the singer's app is older and cannot play a backing track", startAtNs: 0 };
    if (!this.peerHasBacking) return { error: "the singer does not have the backing track yet", startAtNs: 0 };
    if (isTakeRunning(this.state) || this.state === SessionState.Armed || this.state === SessionState.Scheduled) return { error: "a take is running", startAtNs: 0 };
    const startAt = this.now() + msToNs(this.effectiveStartLeadMs());
    const f = new Frame(MsgType.PlayBacking).setI64(Tag.StartAtNs, startAt).setU64(Tag.OffsetUs, Math.max(0, Math.round(offsetUs))).setStr(Tag.BackingId, this.offered!.id);
    if (!this.send(f)) return { error: "the singer could not be reached", startAtNs: 0 };
    this.previewStartNs = startAt;
    this.backingPlaying = true;
    return { error: "", startAtNs: startAt };
  }
  stopBacking(): void {
    if (this.role !== "producer" || !this.backingPlaying) return;
    this.backingPlaying = false;
    this.singerHearing = false;
    this.send(new Frame(MsgType.StopBacking));
  }
  get singerIsHearing(): boolean { return this.singerHearing; }

  setDeliveryConsent(given: boolean): void {
    if (this.deliveryConsent === given) return;
    this.deliveryConsent = given;
    this.history(given ? "allowed the producer to receive copies of this PC's takes" : "no longer allows copies of this PC's takes to be sent");
    this.log.log("info", "transfer", given ? "delivery_consent_given" : "delivery_consent_withdrawn", given ? "performer allows take copies to be sent" : "performer withdrew permission to send take copies");
    this.sendStatus(true);
    this.notify();
  }

  private async ensureReceiver(): Promise<string> {
    if (this.receiver?.running) return "";
    const r = new TakeReceiver({ bindAddress: this.bindAddress, port: this.portNumber + 2, sessionId: this.sessionId, resumeWaitMs: this.cfg.transferResumeWaitMs, clock: this.clock }, this.log);
    const error = await r.start();
    if (error) return `cannot open the take-transfer port ${this.portNumber + 2}: ${error}`;
    this.receiver = r;
    return "";
  }

  /** Producer: ask the performer for a verified copy of its finalised take. Returns "" or why not. */
  async requestTransfer(takeId: number): Promise<string> {
    if (this.role !== "producer") return "only the producer requests take copies";
    if (!this.link || this.linkState !== LinkState.Connected) return "the performer is not connected";
    const info = this.link.joinInfo();
    if (info.protocolMinor < 2) return `the performer's app does not support take transfer (control protocol 1.${info.protocolMinor}; 1.2 needed)`;
    if (isTakeRunning(this.state) || this.state === SessionState.Armed || this.state === SessionState.Scheduled) return "a take is being recorded; request the copy after it";
    const fin = this.finished.get(takeId);
    if (!fin) return `take ${takeId} has not been reported finalised by the performer`;
    let dir = this.port.sessionFolder();
    if (dir) dir = path.join(dir, "from_performer");
    else if (this.cfg.receivedRoot) dir = path.join(this.cfg.receivedRoot, this.sessionId, "from_performer");
    else return "no folder for received takes (record a take on this PC first)";
    const err = await this.ensureReceiver();
    if (err) return err;
    const receiver = this.receiver!;
    receiver.setAllowedPeer(info.peerAddress);
    const exp = receiver.expect(takeId, fin.frames, dir);
    if ("error" in exp) return exp.error;
    const f = new Frame(MsgType.TransferRequest).setU32(Tag.TakeId, takeId).setU16(Tag.TransferPort, receiver.port).setStr(Tag.TransferToken, exp.token); // never logged
    if (!this.send(f)) {
      receiver.cancel(takeId, "the request could not be sent (control link down)");
      return "the request could not be sent";
    }
    this.history(`take ${takeId}: copy requested from the performer (QUEUED; the original stays on the performer's PC)`);
    this.log.log("info", "transfer", "requested", "take copy requested", { take: takeId, port: receiver.port, expected_frames: fin.frames, token: "<redacted>" });
    return "";
  }

  cancelTransfer(takeId: number): void {
    if (!this.receiver) return;
    this.receiver.cancel(takeId, "cancelled by the producer");
    this.history(`take ${takeId}: transfer cancelled by the producer`);
  }

  private performerTransferRequest(f: Frame): void {
    const take = f.u32(Tag.TakeId) ?? 0;
    const xport = f.u16(Tag.TransferPort) ?? 0;
    const token = f.str(Tag.TransferToken) ?? "";
    const no = (code: number, text: string) => {
      this.reply(MsgType.TransferAck, f.msgId, take, false, code, text);
      this.refuse(f, code, text);
    };
    if (!this.deliveryConsent) return no(ErrorCode.TransferRefused, "the performer has not allowed copies of its takes to be sent");
    if (isTakeRunning(this.state) || this.state === SessionState.Armed || this.state === SessionState.Scheduled) return no(ErrorCode.Busy, "recording in progress; ask again after the take");
    const fin = this.finished.get(take);
    if (!fin || !fin.file) return no(ErrorCode.UnknownTake, "no finalised take with this id on the performer's PC");
    if (!/^[0-9a-f]{32}$/.test(token) || xport === 0 || !this.link) return no(ErrorCode.ProtocolMalformed, "malformed transfer request");
    if (!this.sender) this.sender = new TakeSender({ ...this.cfg.transferSender, clock: this.clock }, this.log);
    const error = this.sender.start({ host: this.link.joinInfo().peerAddress, port: xport, sessionId: this.sessionId, token, takeId: take, file: fin.file, takeStatus: fin.status });
    if (error) return no(ErrorCode.Busy, error);
    this.reply(MsgType.TransferAck, f.msgId, take, true, ErrorCode.Ok, "");
    this.history(`take ${take}: producer asked for a copy; sending it (the original stays here, opened read-only)`);
    this.log.log("info", "transfer", "send_started", "sending a copy of the take", { take, port: xport, token: "<redacted>" });
  }

  private pollTransfers(): void {
    for (const l of [...(this.receiver?.takeHistory() ?? []), ...(this.sender?.takeHistory() ?? [])]) {
      this.hist.push(l);
      if (this.hist.length > 300) this.hist.shift();
    }
    if (this.role === "producer" && this.autoQueue.length && !isTakeRunning(this.state) && this.state !== SessionState.Armed && this.state !== SessionState.Scheduled &&
        this.linkState === LinkState.Connected && !this.receiver?.anyActive()) {
      const take = this.autoQueue.shift()!;
      void this.requestTransfer(take).then((error) => {
        if (error) this.history(`take ${take}: automatic copy not requested: ${error}`);
      });
    }
  }

  private stopTransfers(): void {
    void this.sender?.stop();
    this.sender = null;
    this.receiver?.stop();
    this.receiver = null;
    this.autoQueue = [];
  }

  // ---------------------------------------------------------------------------------------------
  get linkInstance(): ControlLink | null { return this.link; }
  get transferReceiver(): TakeReceiver | null { return this.receiver; }
  get transferSender(): TakeSender | null { return this.sender; }
  get joinInfo(): JoinInfo | null { return this.link?.joinInfo() ?? null; }
  get currentSessionId(): string { return this.sessionId; }
  get listenAddress(): string { return this.bindAddress; }
  get controlPort(): number { return this.portNumber; }

  snapshot(): ControllerSnapshot {
    const info = this.link?.joinInfo();
    const transfers = this.receiver ? this.receiver.transfers() : this.sender ? this.sender.transfers() : [];
    return {
      role: this.role,
      link: this.linkState,
      session: this.state,
      notReadyReasons: [...this.reasons],
      sessionId: this.sessionId,
      pairingCode: this.link && this.role === "producer" ? this.link.pairingCode : "",
      bindAddress: this.bindAddress,
      port: this.portNumber,
      peerName: info?.peerName ?? "",
      peerAddress: info?.peerAddress ?? "",
      localConsent: this.consent,
      peerReady: this.peerReady,
      peerConsent: this.peerConsent,
      peerReasons: this.peerReasons,
      localChecks: [...this.localChecks],
      peerChecks: [...this.peerChecks],
      startLeadMs: this.cfg.timing.startLeadMs,
      minStartLeadMs: this.role === "producer" ? this.minStartLeadMs() : 0,
      effectiveStartLeadMs: this.role === "producer" ? this.effectiveStartLeadMs() : 0,
      autoStartLead: this.cfg.timing.autoStartLead,
      linkStats: this.link?.stats() ?? { framesSent: 0, framesReceived: 0, staleFramesDropped: 0, protocolErrors: 0, heartbeatsReceived: 0, connections: 0, reconnectAttempts: 0, failedJoins: 0, controlRttNs: -1, controlRttBestNs: -1, thetaNs: 0, thetaUncertaintyNs: -1, offsetSamples: 0 },
      take: { ...this.take },
      lastError: this.lastError,
      invalidEvents: this.invalidEvents,
      refusedMessages: this.refused,
      duplicateMessages: this.duplicates,
      recorderDescription: this.port.description(),
      transfers,
      deliveryConsent: this.deliveryConsent,
      peerDeliveryConsent: this.peerDeliveryConsent,
      autoTransfer: this.cfg.autoTransfer,
      protocolMinor: info?.protocolMinor ?? 0,
      transferPort: this.receiver?.port ?? 0,
      mode: this.mode,
      backing: this.role === "producer"
        ? { offeredId: this.offered?.id ?? "", haveId: this.peerBackingHave, bytes: this.offered?.bytes ?? 0, playing: this.backingPlaying && this.singerHearing }
        : { offeredId: this.incomingOffer?.id ?? "", haveId: this.hooks.backingHave?.() ?? "", bytes: this.incomingOffer?.bytes ?? 0, playing: this.backingPlaying },
    };
  }
}
