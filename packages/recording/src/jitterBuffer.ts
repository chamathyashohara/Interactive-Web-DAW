/** Playout jitter buffer (PROTOCOL_OVERVIEW §3.3, §13): 64 slots, serial-number arithmetic, catch-up, drift skip and resync. Ported from jitter_buffer.cpp. */

export interface JbPacket {
  seq: number;
  mediaIndex: number;
  arrivalNs: number;
  data: Uint8Array;
}

export interface JitterStats {
  accepted: number;
  late: number;
  duplicates: number;
  tooEarlyResets: number;
  played: number;
  lost: number;
  underruns: number;
  rebuffers: number;
  driftSkips: number;
  catchupFrames: number;
  resyncs: number;
  resets: number;
}

export type JbInsert = "accepted" | "late" | "duplicate" | "too-early-reset";
export type JbPull = { kind: "packet"; packet: JbPacket } | { kind: "lost" } | { kind: "underrun" } | { kind: "filling" };

const SLOTS = 64;
const RESYNC_LATE = 3;
const diff = (a: number, b: number): number => (a - b) | 0;
const clampTarget = (n: number): number => Math.max(1, Math.min(SLOTS / 2, Math.trunc(n)));

export class JitterBuffer {
  static readonly SLOTS = SLOTS;
  private slots: (JbPacket | null)[] = new Array(SLOTS).fill(null);
  private target: number;
  private pendingTarget: number;
  private stallLimit: number;
  private driftPulls: number;
  private isPlaying = false;
  private nextSeq = 0;
  private heldCount = 0;
  private consecutiveUnderruns = 0;
  private consecutiveLate = 0;
  private overTargetPulls = 0;
  readonly stats: JitterStats = { accepted: 0, late: 0, duplicates: 0, tooEarlyResets: 0, played: 0, lost: 0, underruns: 0, rebuffers: 0, driftSkips: 0, catchupFrames: 0, resyncs: 0, resets: 0 };

  constructor(targetFrames = 3, stallLimit = 20, driftPulls = 100) {
    this.target = this.pendingTarget = clampTarget(targetFrames);
    this.stallLimit = Math.max(1, stallLimit);
    this.driftPulls = Math.max(1, driftPulls);
  }

  get playing(): boolean { return this.isPlaying; }
  get held(): number { return this.heldCount; }
  get targetFrames(): number { return this.target; }

  setTarget(frames: number): void {
    this.pendingTarget = clampTarget(frames);
    if (!this.isPlaying) this.target = this.pendingTarget;
  }

  private clear(): void {
    this.slots.fill(null);
    this.heldCount = 0;
    this.isPlaying = false;
    this.consecutiveUnderruns = 0;
    this.consecutiveLate = 0;
    this.overTargetPulls = 0;
    this.target = this.pendingTarget;
  }

  /** Drops everything and goes back to filling (end of stream, new stream). */
  reset(): void {
    this.clear();
    this.stats.resets++;
  }

  private store(p: JbPacket): void {
    this.slots[p.seq % SLOTS] = p;
    this.heldCount++;
    this.stats.accepted++;
  }

  private lowestHeld(): number | null {
    let found: number | null = null;
    for (const s of this.slots) if (s && (found === null || diff(s.seq, found) < 0)) found = s.seq;
    return found;
  }

  insert(p: JbPacket): JbInsert {
    const idx = p.seq % SLOTS;
    const slot = this.slots[idx];
    if (this.isPlaying) {
      const d = diff(p.seq, this.nextSeq);
      if (d < 0) {
        this.stats.late++;
        if (++this.consecutiveLate >= RESYNC_LATE) {
          this.clear();
          this.stats.resyncs++;
          this.store(p);
          if (this.heldCount >= this.target) {
            this.nextSeq = this.lowestHeld()!;
            this.isPlaying = true;
          }
        }
        return "late";
      }
      this.consecutiveLate = 0;
      if (d >= SLOTS) {
        this.clear();
        this.stats.tooEarlyResets++;
        this.store(p);
        return "too-early-reset";
      }
      if (slot && slot.seq === p.seq) {
        this.stats.duplicates++;
        return "duplicate";
      }
      if (slot) this.heldCount--;
      this.store(p);
      return "accepted";
    }
    if (slot && slot.seq === p.seq) {
      this.stats.duplicates++;
      return "duplicate";
    }
    const low = this.lowestHeld();
    if (low !== null) {
      let high = low;
      for (const s of this.slots) if (s && diff(s.seq, high) > 0) high = s.seq;
      const newLow = diff(p.seq, low) < 0 ? p.seq : low;
      const newHigh = diff(p.seq, high) > 0 ? p.seq : high;
      if (diff(newHigh, newLow) >= SLOTS) {
        this.clear();
        this.stats.tooEarlyResets++;
        this.store(p);
        return "too-early-reset";
      }
    }
    if (slot) this.heldCount--;
    this.store(p);
    if (this.heldCount >= this.target) {
      this.nextSeq = this.lowestHeld()!;
      this.isPlaying = true;
      this.consecutiveUnderruns = 0;
      this.overTargetPulls = 0;
    }
    return "accepted";
  }

  pull(): JbPull {
    if (!this.isPlaying) return { kind: "filling" };
    const excessLimit = this.target + (this.target > 8 ? this.target : 8);
    if (this.heldCount > excessLimit) {
      while (this.heldCount > this.target) {
        const old = this.slots[this.nextSeq % SLOTS];
        if (old && old.seq === this.nextSeq) {
          this.slots[this.nextSeq % SLOTS] = null;
          this.heldCount--;
          this.stats.catchupFrames++;
        }
        this.nextSeq = (this.nextSeq + 1) >>> 0;
      }
      this.overTargetPulls = 0;
    }
    if (this.heldCount > this.target + 2) {
      if (++this.overTargetPulls >= this.driftPulls) {
        this.overTargetPulls = 0;
        const skip = this.slots[this.nextSeq % SLOTS];
        if (skip && skip.seq === this.nextSeq) {
          this.slots[this.nextSeq % SLOTS] = null;
          this.heldCount--;
        }
        this.nextSeq = (this.nextSeq + 1) >>> 0;
        this.stats.driftSkips++;
      }
    } else {
      this.overTargetPulls = 0;
    }
    const idx = this.nextSeq % SLOTS;
    const slot = this.slots[idx];
    const wanted = this.nextSeq;
    this.nextSeq = (this.nextSeq + 1) >>> 0;
    if (slot && slot.seq === wanted) {
      this.slots[idx] = null;
      this.heldCount--;
      this.consecutiveUnderruns = 0;
      this.stats.played++;
      return { kind: "packet", packet: slot };
    }
    if (this.heldCount > 0) {
      this.consecutiveUnderruns = 0;
      this.stats.lost++;
      return { kind: "lost" };
    }
    this.stats.underruns++;
    if (++this.consecutiveUnderruns >= this.stallLimit) {
      this.clear();
      this.stats.rebuffers++;
    }
    return { kind: "underrun" };
  }
}

/** RFC 3550 inter-arrival jitter plus loss/reorder bookkeeping for one incoming stream (arrival_stats.cpp). */
export class ArrivalStats {
  received = 0;
  duplicates = 0;
  reordered = 0;
  private baseSeq = -1;
  private maxSeq = 0;
  private jitterNs = 0;
  private lastTransit: number | null = null;
  private seen = new Set<number>();

  /** `rateHz` converts media_index (samples) to time for the transit estimate. */
  onPacket(seq: number, mediaIndex: number, arrivalNs: number, rateHz = 48000): boolean {
    if (this.seen.has(seq)) {
      this.duplicates++;
      return false;
    }
    this.seen.add(seq);
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value as number);
    if (this.baseSeq < 0) {
      this.baseSeq = seq;
      this.maxSeq = seq;
    } else if (diff(seq, this.maxSeq) > 0) {
      this.maxSeq = seq;
    } else {
      this.reordered++;
    }
    this.received++;
    const transit = arrivalNs - (mediaIndex / rateHz) * 1e9;
    if (this.lastTransit !== null) {
      const d = Math.abs(transit - this.lastTransit);
      this.jitterNs += (d - this.jitterNs) / 16;
    }
    this.lastTransit = transit;
    return true;
  }

  get lostEstimate(): number {
    if (this.baseSeq < 0) return 0;
    const expected = diff(this.maxSeq, this.baseSeq) + 1;
    return Math.max(0, expected - this.received);
  }
  get jitterUs(): number { return Math.round(this.jitterNs / 1000); }
  reset(): void {
    this.baseSeq = -1;
    this.lastTransit = null;
    this.seen.clear();
  }
}
