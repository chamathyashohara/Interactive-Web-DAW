import { describe, expect, it } from "vitest";
import { findOnset, robustLatencyFrames } from "./latency";

describe("latency measurement", () => {
  it("finds the first sample that is clearly louder than the room", () => {
    const x = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) x[i] = (Math.sin(i * 7) * 0.004); // room noise
    x[612] = 0.5;
    expect(findOnset(x, 0.004)).toBe(612);
  });

  it("ignores noise that is only a little above the measured floor, and finds nothing in silence", () => {
    const x = new Float32Array(500).fill(0.01);
    expect(findOnset(x, 0.01)).toBe(-1);
    expect(findOnset(new Float32Array(500), 0)).toBe(-1);
  });

  it("takes the agreeing measurements and refuses ones that scatter", () => {
    const rate = 48000;
    expect(robustLatencyFrames([2200, 2210, 2195, 2205, 9000], rate)).toBe(Math.round((2200 + 2210 + 2195 + 2205) / 4));
    expect(robustLatencyFrames([1000, 5000, 9000, 13000], rate)).toBeNull();
    expect(robustLatencyFrames([2200, 2201], rate)).toBeNull();
  });
});
