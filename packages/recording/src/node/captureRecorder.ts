/**
 * The real recorder behind the session controller. The microphone is captured in the renderer (Web Audio) and streamed here block by block
 * with a running frame index; this class decides, from the shared clock, which sample is the first of a take and which the last, and writes
 * those samples to a 32-bit float WAV on this PC's disk (the "master" of the dual-path design). Nothing here depends on the network.
 *
 * Layout (same as the C++ recorder): <root>/<YYYYMMDD-HHMMSS>_<session>/take<NN>_<role>_<session>.wav, written as .wav.partial until the
 * take is finalised, then renamed without replacing anything, with a take<NN>_...wav.json record beside it.
 */
import fs from "node:fs";
import path from "node:path";
import { CaptureClock } from "../captureClock";
import { TakeStatus, type Role } from "../errors";
import { type LocalReadiness, type ReadinessCheck, ReadyItem } from "../session";
import { buildWavHeader, maxWavFrames } from "../wav";
import { type Clock, systemClock } from "./clock";
import { type Logger, nullLogger } from "./log";
import { type PortEvent, type PortTakeSpec, type RecorderPort, blankEvent } from "./recorderPort";

export interface CaptureState {
  /** the microphone is open in the renderer */
  open: boolean;
  deviceName: string;
  sampleRate: number;
  channels: number;
  /** the renderer reported that the device failed or was unplugged */
  failed: string;
}

export interface CaptureRecorderOptions {
  recordingsRoot: string;
  clock?: Clock;
  logger?: Logger;
  /** capture blocks must keep arriving at least this often while "healthy" */
  stallMs?: number;
  /** extra margin on the disk-space check */
  minFreeBytes?: number;
}

type Phase = "idle" | "scheduled" | "recording" | "stopping";

interface Active {
  spec: PortTakeSpec;
  phase: Phase;
  finalPath: string;
  partialPath: string;
  fd: number | null;
  frames: number;
  firstFrame: number;
  firstSampleNs: number;
  lateFrames: number;
  /** last frame (exclusive) to keep, or null until a stop is scheduled */
  endFrame: number | null;
  stopAtNs: number;
  stopNow: boolean;
  remoteStop: boolean;
  stopReason: string;
  startedNs: number;
  lastWriteError: string;
  /** vocal over backing: the exact capture frame the take begins on (the same frame the backing track starts playing on) */
  forcedStartFrame: number | null;
  vocal: boolean;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const compactUtc = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

export class CaptureRecorderPort implements RecorderPort {
  private clock: Clock;
  private log: Logger;
  readonly captureClock = new CaptureClock();
  private state: CaptureState = { open: false, deviceName: "", sampleRate: 48000, channels: 1, failed: "" };
  private lastBlockNs = 0;
  private nextFrame = -1;
  private root: string;
  private sessionDir = "";
  private sessionIdForDir = "";
  private active: Active | null = null;
  private events: PortEvent[] = [];
  private peak = 0;
  private blocks = 0;
  private latencyUs = 0;
  /** vocal take scheduled: tell the window which capture frame to start the backing track on */
  onVocalSchedule: ((o: { takeId: number; startFrame: number; offsetUs: number; backingId: string }) => void) | null = null;
  /** vocal take over (finished, failed or cancelled): stop the backing track */
  onVocalEnd: ((takeId: number) => void) | null = null;

  constructor(private opts: CaptureRecorderOptions) {
    this.clock = opts.clock ?? systemClock;
    this.log = opts.logger ?? nullLogger;
    this.root = opts.recordingsRoot;
  }

  setRecordingsRoot(root: string): void { this.root = root; }
  /** The speaker-to-microphone round trip (microseconds) the next vocal takes are made with. */
  setLatencyUs(us: number): void { this.latencyUs = Math.max(0, Math.round(us)); }
  /** The capture frame a time on the shared clock corresponds to (needs microphone blocks to have arrived). */
  frameAtNs(ns: number): number | null {
    return this.captureClock.hasMapping ? Math.ceil(this.captureClock.frameAt(ns)) : null;
  }
  /** The capture frame of the newest block's end: nothing at or before it can still be started on. */
  get latestFrame(): number { return this.nextFrame; }
  get recordingsRoot(): string { return this.root; }
  get captureState(): CaptureState { return { ...this.state }; }
  get level(): number { return this.peak; }
  get blocksReceived(): number { return this.blocks; }

  /** The renderer opened or closed the microphone. */
  setCaptureState(s: Partial<CaptureState>): void {
    const was = this.state.open;
    this.state = { ...this.state, ...s };
    if (s.sampleRate) this.captureClock.rateHz = s.sampleRate;
    if (s.open === false || (s.failed && s.failed !== "")) {
      if (was || s.failed) this.captureClock.reset();
      this.nextFrame = -1;
    }
    if (s.open === false && this.active && (this.active.phase === "recording" || this.active.phase === "stopping")) {
      this.finalise(TakeStatus.IncompleteDevice, "the microphone was closed during the take", s.failed ?? "microphone closed");
    }
    if (s.failed && this.active && (this.active.phase === "recording" || this.active.phase === "stopping")) {
      this.finalise(TakeStatus.IncompleteDevice, "device failure", s.failed);
    }
  }

  // ---- RecorderPort ----

  readiness(): LocalReadiness {
    const now = this.clock.nowNs();
    const stallNs = (this.opts.stallMs ?? 1000) * 1e6;
    const healthy = this.state.open && this.lastBlockNs !== 0 && now - this.lastBlockNs < stallNs && !this.state.failed;
    const maxBytes = 1800 * this.state.sampleRate * this.state.channels * 4;
    const checks: ReadinessCheck[] = [];
    const reasons: string[] = [];
    const add = (item: ReadyItem, ok: boolean, detail: string, reason: string) => {
      checks.push({ item, ok, mandatory: true, detail });
      if (!ok) reasons.push(reason);
    };
    add(ReadyItem.InputDevice, this.state.open, this.state.open ? this.state.deviceName || "microphone open" : this.state.failed || "turn the microphone on", "microphone is not on");
    add(ReadyItem.EngineHealthy, healthy, healthy ? `${this.state.sampleRate} Hz, ${this.state.channels} ch` : "no audio arriving", "no audio is arriving from the microphone");
    let folderOk = false;
    let folderDetail = "";
    try {
      fs.mkdirSync(this.root, { recursive: true });
      const probe = path.join(this.root, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, "x");
      fs.rmSync(probe, { force: true });
      folderOk = true;
      folderDetail = this.root;
    } catch (e) {
      folderDetail = (e as Error).message;
    }
    add(ReadyItem.FolderWritable, folderOk, folderDetail, "the recordings folder is not writable");
    let diskOk = true;
    let diskDetail = "";
    try {
      const s = fs.statfsSync(this.root);
      const free = s.bavail * s.bsize;
      const need = maxBytes + (this.opts.minFreeBytes ?? 1 << 20);
      diskOk = free >= need;
      diskDetail = `${Math.round(free / 1048576)} MB free, ${Math.round(need / 1048576)} MB needed`;
    } catch {
      diskDetail = "free space unknown";
    }
    add(ReadyItem.DiskSpace, diskOk, diskDetail, "not enough free disk space for the longest take");
    const idle = !this.active;
    add(ReadyItem.NoActiveRecording, idle, idle ? "idle" : "a take is open", "another recording is active");
    return { ok: reasons.length === 0, reasons, checks };
  }

  scheduleTake(spec: PortTakeSpec): string {
    if (this.active) return "a take is already open on this PC";
    if (!this.state.open) return "the microphone is not on";
    let forced: number | null = null;
    if (spec.vocal) {
      forced = this.frameAtNs(spec.startAtNs);
      if (forced === null || this.nextFrame < 0) return "the microphone has not delivered any audio yet";
      if (forced < this.nextFrame + Math.round(this.state.sampleRate * 0.05)) return "the start time is too close to start the backing track in sync";
    }
    if (!this.sessionDir || this.sessionIdForDir !== spec.sessionId) {
      this.sessionDir = path.join(this.root, `${compactUtc(Date.now())}_${spec.sessionId}`);
      this.sessionIdForDir = spec.sessionId;
    }
    const stem = `take${pad(spec.takeId)}_${spec.role}_${spec.sessionId}`;
    const finalPath = path.join(this.sessionDir, `${stem}.wav`);
    const partialPath = `${finalPath}.partial`;
    try {
      fs.mkdirSync(this.sessionDir, { recursive: true });
      if (fs.existsSync(finalPath) || fs.existsSync(partialPath)) return `take file already exists, refusing to overwrite: ${finalPath}`;
      const fd = fs.openSync(partialPath, "wx");
      fs.writeSync(fd, buildWavHeader({ sampleRate: this.state.sampleRate, channels: this.state.channels }, 0));
      this.active = {
        spec, phase: "scheduled", finalPath, partialPath, fd, frames: 0, firstFrame: 0, firstSampleNs: 0, lateFrames: 0, endFrame: null, stopAtNs: 0, stopNow: false,
        remoteStop: false, stopReason: "", startedNs: 0, lastWriteError: "", forcedStartFrame: forced, vocal: !!spec.vocal,
      };
    } catch (e) {
      return (e as Error).message;
    }
    this.log.log("info", "recorder", "scheduled", "take scheduled", { take: spec.takeId, file: finalPath });
    if (spec.vocal && forced !== null) this.onVocalSchedule?.({ takeId: spec.takeId, startFrame: forced, offsetUs: spec.vocal.offsetUs, backingId: spec.vocal.backingId });
    return "";
  }

  scheduleStop(stopAtNs: number, remote: boolean): void {
    const a = this.active;
    if (!a || (a.phase !== "recording" && a.phase !== "scheduled")) return;
    a.phase = a.phase === "recording" ? "stopping" : a.phase;
    a.remoteStop = remote;
    if (stopAtNs === 0) a.stopNow = true;
    else a.stopAtNs = stopAtNs;
    a.stopReason = remote ? "stopped by the producer" : "stopped on this PC";
  }

  cancelTake(): void {
    const a = this.active;
    if (!a || a.phase !== "scheduled") return;
    this.discard(a, "cancelled before the start");
    this.active = null;
    if (a.vocal) this.onVocalEnd?.(a.spec.takeId);
    const e = blankEvent("finalised", a.spec.takeId);
    e.status = TakeStatus.Cancelled;
    e.stopReason = "cancelled";
    e.eventNs = this.clock.nowNs();
    this.events.push(e);
  }

  /** The app is closing: keep what a running take has so far (complete_shutdown), drop one that never started. */
  closeForShutdown(): void {
    const a = this.active;
    if (!a) return;
    if (a.phase === "scheduled") {
      this.cancelTake();
      return;
    }
    this.finalise(TakeStatus.CompleteShutdown, "the app was closing", "");
  }

  poll(): PortEvent[] {
    const a = this.active;
    const now = this.clock.nowNs();
    if (a) {
      const stallNs = (this.opts.stallMs ?? 1000) * 1e6;
      if ((a.phase === "recording" || a.phase === "stopping") && this.lastBlockNs !== 0 && now - this.lastBlockNs > stallNs * 2) {
        this.finalise(TakeStatus.IncompleteDevice, "microphone stalled", "no audio arrived for 2 s");
      } else if (a.phase === "stopping" && a.stopAtNs !== 0 && this.lastBlockNs !== 0 && now - this.lastBlockNs > 500e6 && now > a.stopAtNs) {
        // stop time passed and no more audio is coming: close with what we have
        this.finalise(TakeStatus.Complete, a.stopReason, "");
      } else if (a.phase === "scheduled" && now > a.spec.startAtNs + 5e9) {
        // The start time passed long ago and no audio ever arrived.
        this.finalise(TakeStatus.IncompleteDevice, "microphone never delivered audio", "no audio arrived after the scheduled start");
      }
    }
    const out = this.events;
    this.events = [];
    return out;
  }

  description(): string {
    return this.state.open ? `microphone "${this.state.deviceName || "default"}" at ${this.state.sampleRate} Hz` : "microphone off";
  }
  sessionFolder(): string { return this.sessionDir; }

  // ---- capture input ----

  /** One block of microphone audio. `frame` is the index of its first frame since capture started; samples are interleaved float32. */
  onCapture(frame: number, samples: Float32Array): void {
    const ch = this.state.channels;
    const n = Math.floor(samples.length / ch);
    if (n === 0) return;
    const arrival = this.clock.nowNs();
    this.blocks++;
    this.lastBlockNs = arrival;
    if (this.nextFrame >= 0 && frame !== this.nextFrame) {
      this.log.log("warn", "recorder", "capture_gap", "capture frames are not contiguous", { expected: this.nextFrame, got: frame });
    }
    this.nextFrame = frame + n;
    this.captureClock.onBlock(frame, arrival);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]!);
      if (v > peak) peak = v;
    }
    this.peak = Math.max(peak, this.peak * 0.9);
    const a = this.active;
    if (!a) return;
    const blockEnd = frame + n;
    if (a.phase === "scheduled") {
      const targetFrame = a.forcedStartFrame ?? Math.ceil(this.captureClock.frameAt(a.spec.startAtNs));
      if (targetFrame >= blockEnd) return; // the start is in a later block
      const first = Math.max(targetFrame, frame);
      a.firstFrame = first;
      a.lateFrames = Math.max(0, frame - targetFrame);
      a.firstSampleNs = Math.round(this.captureClock.timeOfFrame(first));
      a.startedNs = arrival;
      a.phase = "recording";
      const e = blankEvent("started", a.spec.takeId);
      e.eventNs = arrival;
      e.firstFrame = first;
      e.firstSampleNs = a.firstSampleNs;
      e.lateFrames = a.lateFrames;
      e.devicePeriodFrames = n;
      e.devicePeriods = 1;
      this.events.push(e);
      this.write(a, samples.subarray((first - frame) * ch), first);
      this.checkEnd(a, blockEnd);
      return;
    }
    if (a.phase === "recording" || a.phase === "stopping") {
      this.write(a, samples, frame);
      this.checkEnd(a, blockEnd);
    }
  }

  private write(a: Active, samples: Float32Array, frame: number): void {
    if (a.fd === null) return;
    const ch = this.state.channels;
    let n = Math.floor(samples.length / ch);
    // honour an exact stop frame inside this block
    if (a.endFrame !== null) n = Math.max(0, Math.min(n, a.endFrame - frame));
    if (n === 0) return;
    if (a.frames + n > maxWavFrames({ sampleRate: this.state.sampleRate, channels: ch })) {
      this.finalise(TakeStatus.IncompleteDisk, "WAV size limit (4 GiB) reached", "WAV size limit (4 GiB) reached");
      return;
    }
    try {
      const view = new Uint8Array(samples.buffer, samples.byteOffset, n * ch * 4);
      fs.writeSync(a.fd, view);
      a.frames += n;
    } catch (e) {
      a.lastWriteError = (e as Error).message;
      this.finalise(TakeStatus.IncompleteDisk, "disk write failed", a.lastWriteError);
    }
  }

  /** After a block was written: decide whether the take ends inside or at the end of this block. */
  private checkEnd(a: Active, blockEnd: number): void {
    if (this.active !== a || a.fd === null) return;
    const maxFrames = a.spec.maxTakeSeconds * this.state.sampleRate;
    if (a.frames >= maxFrames) {
      return void this.finalise(TakeStatus.Complete, "safety limit reached", "");
    }
    if (a.phase !== "stopping") return;
    if (a.stopNow) {
      a.endFrame = blockEnd;
    } else if (a.stopAtNs !== 0) {
      const stopFrame = Math.ceil(this.captureClock.frameAt(a.stopAtNs));
      if (stopFrame > blockEnd) return;
      a.endFrame = Math.min(stopFrame, blockEnd);
      // the block was already written in full; cut the file back to the exact stop frame
      const keep = Math.max(0, Math.min(a.frames, a.endFrame - a.firstFrame));
      if (keep < a.frames) {
        a.frames = keep;
        try { fs.ftruncateSync(a.fd, 58 + keep * this.state.channels * 4); } catch { /* the header patch below fixes the count */ }
      }
    } else {
      return;
    }
    this.finalise(TakeStatus.Complete, a.stopReason, "");
  }

  private discard(a: Active, why: string): void {
    if (a.fd !== null) {
      try { fs.closeSync(a.fd); } catch { /* closing a file that was never used */ }
      a.fd = null;
    }
    try { fs.rmSync(a.partialPath, { force: true }); } catch { /* best effort */ }
    this.log.log("info", "recorder", "discarded", why, { take: a.spec.takeId });
  }

  private finalise(status: TakeStatus, stopReason: string, error: string): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    const e = blankEvent("finalised", a.spec.takeId);
    e.eventNs = this.clock.nowNs();
    e.status = status;
    e.frames = a.frames;
    e.sampleRate = this.state.sampleRate;
    e.stopReason = stopReason;
    e.error = error;
    e.latencyUs = a.vocal ? this.latencyUs : 0;
    if (a.vocal) this.onVocalEnd?.(a.spec.takeId);
    if (a.fd === null || a.phase === "scheduled" && a.frames === 0 && status !== TakeStatus.Complete) {
      // nothing was ever written: no file is kept
      this.discard(a, stopReason);
      e.file = "";
      e.finalised = false;
      e.status = status === TakeStatus.Complete ? TakeStatus.Cancelled : status;
      this.events.push(e);
      return;
    }
    const complete = status === TakeStatus.Complete || status === TakeStatus.CompleteShutdown;
    try {
      fs.writeSync(a.fd, buildWavHeader({ sampleRate: this.state.sampleRate, channels: this.state.channels }, a.frames), 0, 58, 0);
      fs.fsyncSync(a.fd);
      fs.closeSync(a.fd);
      a.fd = null;
      if (complete || a.frames > 0) {
        // rename without replacing: link + unlink refuses to overwrite an existing file
        fs.linkSync(a.partialPath, a.finalPath);
        fs.unlinkSync(a.partialPath);
        e.file = a.finalPath;
        e.finalised = true;
      } else {
        e.file = a.partialPath;
      }
    } catch (err) {
      e.file = a.partialPath;
      e.finalised = false;
      e.error = e.error || (err as Error).message;
      e.status = TakeStatus.IncompleteDisk;
    }
    if (a.fd !== null) {
      try { fs.closeSync(a.fd); } catch { /* ignore */ }
    }
    if (e.finalised) {
      try {
        fs.writeFileSync(`${a.finalPath}.json`, JSON.stringify({
          session_id: a.spec.sessionId, take_id: a.spec.takeId, role: a.spec.role as Role, status: e.status, frames: a.frames, sample_rate: this.state.sampleRate,
          channels: this.state.channels, duration_s: Number((a.frames / this.state.sampleRate).toFixed(3)), device: this.state.deviceName, first_frame: a.firstFrame,
          late_frames: a.lateFrames, scheduled_start_ns: a.spec.startAtNs, first_sample_ns: a.firstSampleNs, stop_reason: stopReason, error, format: "IEEE float 32-bit WAV",
          clock_note: "times are this PC's monotonic clock (nanoseconds since the app started); device input latency is not included",
          written_utc: new Date().toISOString(),
        }, null, 2));
      } catch { /* the WAV is the product; the record is a bonus */ }
    }
    this.log.log(e.finalised ? "info" : "warn", "recorder", "finalised", stopReason, { take: a.spec.takeId, frames: a.frames, status: e.status, file: e.file });
    this.events.push(e);
  }
}
