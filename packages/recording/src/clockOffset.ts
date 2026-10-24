/**
 * Four-timestamp clock-offset estimator (PROTOCOL_OVERVIEW §3.4): delta = (t4-t1) - (t3-t2), theta = ((t2-t1) + (t3-t4)) / 2.
 * The reported offset is the sample with the smallest delta in the window; uncertainty = delta_min / 2.
 */
export class ClockOffsetEstimator {
  private samples: { theta: number; delta: number }[] = [];
  private lastDelta = -1;
  rejected = 0;

  constructor(private window = 16, private maxDeltaNs = 1_000_000_000) {}

  addSample(t1: number, t2: number, t3: number, t4: number): boolean {
    const delta = t4 - t1 - (t3 - t2);
    if (t4 < t1 || t3 < t2 || delta < 0 || delta > this.maxDeltaNs) {
      this.rejected++;
      return false;
    }
    this.samples.push({ theta: Math.trunc((t2 - t1 + (t3 - t4)) / 2), delta });
    if (this.samples.length > this.window) this.samples.shift();
    this.lastDelta = delta;
    return true;
  }

  get hasEstimate(): boolean { return this.samples.length > 0; }
  get sampleCount(): number { return this.samples.length; }
  get lastDeltaNs(): number { return this.lastDelta; }

  private best() {
    let best = this.samples[0];
    for (const s of this.samples) if (best && s.delta < best.delta) best = s;
    return best;
  }
  /** responder clock - requester clock; 0 until there is a sample. */
  get thetaNs(): number { return this.best()?.theta ?? 0; }
  get bestDeltaNs(): number { return this.best()?.delta ?? -1; }
  get uncertaintyNs(): number { const d = this.bestDeltaNs; return d < 0 ? -1 : Math.trunc(d / 2); }
  reset(): void { this.samples = []; this.lastDelta = -1; }
}
