/**
 * Maps the capture frame counter to the main process's monotonic clock.
 *
 * The microphone is captured in the renderer's audio thread and its blocks reach the main process with a variable delay, so the
 * arrival time of a block is "true time + queueing delay (>= 0)". The smallest value of (arrival - frame / rate) over a recent
 * window is the best estimate of the fixed part, so the mapping is anchored there: the jitter of individual blocks is filtered out
 * and only the constant latency of the path (the same on every PC running this code) remains. Like the C++ recorder's estimate,
 * it does not include the sound card's own input latency.
 */
export class CaptureClock {
  private mins: { at: number; offset: number }[] = [];
  private last: { frame: number; arrivalNs: number } | null = null;
  private current: number | null = null;
  rateHz = 48000;

  constructor(private windowNs = 2_000_000_000) {}

  get hasMapping(): boolean { return this.current !== null; }

  /** `frame` is the index of the first frame of the block that has just arrived. */
  onBlock(frame: number, arrivalNs: number): void {
    if (this.last && frame < this.last.frame) this.reset(); // the capture restarted
    const offset = arrivalNs - (frame / this.rateHz) * 1e9;
    this.last = { frame, arrivalNs };
    // monotonic deque of minima over the window
    while (this.mins.length && this.mins[this.mins.length - 1]!.offset >= offset) this.mins.pop();
    this.mins.push({ at: arrivalNs, offset });
    while (this.mins.length && arrivalNs - this.mins[0]!.at > this.windowNs) this.mins.shift();
    this.current = this.mins[0]!.offset;
  }

  reset(): void {
    this.mins = [];
    this.last = null;
    this.current = null;
  }

  /** Estimated clock time of a frame (can be fractional). */
  timeOfFrame(frame: number): number {
    return (this.current ?? 0) + (frame / this.rateHz) * 1e9;
  }

  /** Estimated frame index at a clock time. */
  frameAt(ns: number): number {
    return ((ns - (this.current ?? 0)) / 1e9) * this.rateHz;
  }
}
