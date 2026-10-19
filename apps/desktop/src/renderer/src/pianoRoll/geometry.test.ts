import { describe, expect, it } from "vitest";
import { PPQ } from "@daw/shared";
import { clamp, DEFAULT_ROW_H, pitchToY, pxToTick, snapTick, tickToPx, yToPitch, PITCH_MAX, PITCH_MIN } from "./geometry";

describe("snapTick", () => {
  it("snaps to the grid when enabled", () => {
    expect(snapTick(250, 240, true)).toBe(240);
    expect(snapTick(370, 240, true)).toBe(480);
    expect(snapTick(479, 240, true, "floor")).toBe(240);
  });
  it("leaves free positions (integers) when disabled", () => {
    expect(snapTick(251.6, 240, false)).toBe(252);
    expect(snapTick(-5, 240, false)).toBe(0);
  });
});

describe("zoom independence", () => {
  it("tick -> px -> tick round trips at any zoom without changing the stored tick", () => {
    for (const zoom of [40, 80, 120, 333, 640]) {
      for (const tick of [0, 240, 960, 7777, 15359]) {
        expect(Math.round(pxToTick(tickToPx(tick, zoom), zoom))).toBe(tick);
      }
    }
    expect(tickToPx(PPQ, 100)).toBe(100);
  });
});

describe("pitch rows", () => {
  it("maps pitch <-> y and clamps to the visible range at any vertical zoom", () => {
    for (const rowH of [12, DEFAULT_ROW_H, 32]) {
      for (const pitch of [PITCH_MIN, 60, PITCH_MAX]) {
        expect(yToPitch(pitchToY(pitch, rowH) + rowH / 2, rowH)).toBe(pitch);
      }
      expect(yToPitch(-100, rowH)).toBe(PITCH_MAX);
      expect(yToPitch(99999, rowH)).toBe(PITCH_MIN);
    }
    expect(clamp(5, 0, 3)).toBe(3);
  });
});
