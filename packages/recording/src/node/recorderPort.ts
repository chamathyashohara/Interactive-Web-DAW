/**
 * What the session controller needs from "the thing that records locally". Two implementations:
 *  - CaptureRecorderPort (captureRecorder.ts): the real recorder, fed by the microphone capture the renderer streams in;
 *  - TestRecorderPort (here): simulates start/stop timing and writes nothing, for tests of the session logic.
 * All calls happen on the controller's thread.
 */
import type { Role } from "../errors";
import { TakeStatus } from "../errors";
import type { LocalReadiness } from "../session";
import { ReadyItem } from "../session";
import { type Clock, systemClock } from "./clock";

export interface PortTakeSpec {
  takeId: number;
  sessionId: string;
  role: Role;
  maxTakeSeconds: number;
  /** local monotonic time of the first sample */
  startAtNs: number;
  /** vocal over a backing track: the singer plays the backing from `offsetUs` into the song while recording */
  vocal?: { offsetUs: number; backingId: string };
}

export interface PortEvent {
  kind: "started" | "finalised";
  takeId: number;
  /** local monotonic time the controller saw the event */
  eventNs: number;
  // started
  firstFrame: number;
  devicePeriodFrames: number;
  devicePeriods: number;
  firstSampleNs: number;
  lateFrames: number;
  // finalised
  status: TakeStatus;
  finalised: boolean;
  frames: number;
  sampleRate: number;
  stopReason: string;
  error: string;
  /** full path of the WAV (or .partial) */
  file: string;
  /** vocal takes: the speaker-to-microphone round trip the recording was made with, microseconds */
  latencyUs: number;
}

export const blankEvent = (kind: PortEvent["kind"], takeId: number): PortEvent => ({
  kind, takeId, eventNs: 0, firstFrame: 0, devicePeriodFrames: 0, devicePeriods: 0, firstSampleNs: 0, lateFrames: 0,
  status: TakeStatus.Complete, finalised: false, frames: 0, sampleRate: 0, stopReason: "", error: "", file: "", latencyUs: 0,
});

export interface RecorderPort {
  readiness(): LocalReadiness;
  /** Returns "" when scheduled, otherwise the reason it could not be. */
  scheduleTake(spec: PortTakeSpec): string;
  /** stopAtNs = 0: stop now. `remote` = the producer asked for it. */
  scheduleStop(stopAtNs: number, remote: boolean): void;
  /** Only before the take started. */
  cancelTake(): void;
  poll(): PortEvent[];
  description(): string;
  /** Folder of the current session's takes on this PC (empty if none yet). */
  sessionFolder(): string;
}

/** No audio: "starts" when its clock reaches the scheduled time, counts frames at a nominal 48 kHz, "finalises" on stop. */
export class TestRecorderPort implements RecorderPort {
  protected ready = true;
  protected notReadyReason = "";
  private failNext = "";
  private fault = false;
  protected active = false;
  private started = false;
  private stopping = false;
  private remoteStop = false;
  protected spec: PortTakeSpec | null = null;
  private stopAtNs = 0;
  protected events: PortEvent[] = [];
  private startedAtNs = 0;
  /** TEST ONLY: returns the path of a file the test wrote for a finalised take. */
  reportFile: ((takeId: number, frames: number) => string) | null = null;

  constructor(protected clock: Clock = systemClock) {}

  setReady(ready: boolean, reason = "test: not ready"): void {
    this.ready = ready;
    this.notReadyReason = reason;
  }
  failNextSchedule(error: string): void { this.failNext = error; }
  simulateFault(): void { this.fault = true; }

  readiness(): LocalReadiness {
    const checks = [
      { item: ReadyItem.InputDevice, ok: this.ready, mandatory: true, detail: this.ready ? "test recorder" : this.notReadyReason },
      { item: ReadyItem.EngineHealthy, ok: this.ready, mandatory: true, detail: "" },
      { item: ReadyItem.NoActiveRecording, ok: !this.active, mandatory: true, detail: "" },
    ];
    const reasons: string[] = [];
    if (!this.ready) reasons.push(this.notReadyReason);
    return { ok: this.ready && !this.active, reasons, checks };
  }

  scheduleTake(spec: PortTakeSpec): string {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = "";
      return e;
    }
    if (this.active) return "a take is already open";
    this.spec = spec;
    this.active = true;
    this.started = false;
    this.stopping = false;
    this.stopAtNs = 0;
    return "";
  }
  scheduleStop(stopAtNs: number, remote: boolean): void {
    if (!this.active) return;
    this.stopping = true;
    this.remoteStop = remote;
    this.stopAtNs = stopAtNs;
  }
  cancelTake(): void {
    if (this.active && !this.started) this.active = false;
  }

  poll(): PortEvent[] {
    const now = this.clock.nowNs();
    if (this.active && this.spec) {
      if (!this.started && now >= this.spec.startAtNs) {
        this.started = true;
        this.startedAtNs = this.spec.startAtNs;
        const e = blankEvent("started", this.spec.takeId);
        e.eventNs = now;
        e.firstSampleNs = this.spec.startAtNs;
        e.lateFrames = 0;
        this.events.push(e);
      }
      const faulted = this.started && this.fault;
      if (this.started && (faulted || (this.stopping && now >= this.stopAtNs))) {
        const e = blankEvent("finalised", this.spec.takeId);
        const endNs = faulted ? now : Math.max(this.stopAtNs, this.startedAtNs);
        e.eventNs = now;
        e.status = faulted ? TakeStatus.IncompleteDevice : TakeStatus.Complete;
        e.finalised = true;
        e.frames = Math.max(0, Math.round(((endNs - this.startedAtNs) / 1e9) * 48000));
        e.sampleRate = 48000;
        e.stopReason = faulted ? "simulated device fault" : this.remoteStop ? "stopped by the producer" : "stopped";
        e.file = this.reportFile ? this.reportFile(this.spec.takeId, e.frames) : "";
        this.events.push(e);
        this.active = false;
        this.fault = false;
      }
    }
    const out = this.events;
    this.events = [];
    return out;
  }

  description(): string { return "TEST RECORDER (no audio, nothing is written)"; }
  sessionFolder(): string { return ""; }
}
