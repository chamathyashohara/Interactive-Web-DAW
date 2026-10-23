import { describe, expect, it } from "vitest";
import { PPQ, TICKS_PER_BAR, type Clip, type Note } from "@daw/shared";
import { clipEvents, clipSeconds, pitchToHz } from "./audio";

const note = (id: string, pitch: number, startTick: number, durationTicks: number, extra: Partial<Note> = {}): Note => ({ id, pitch, startTick, durationTicks, velocity: 127, ...extra });
const clipOf = (...notes: Note[]): Clip => ({ id: "c", startTick: 0, lengthTicks: 2 * TICKS_PER_BAR, notes: Object.fromEntries(notes.map((n) => [n.id, n])) });

describe("lesson audio preview scheduling", () => {
  it("converts ticks to seconds at the project tempo (120 BPM: one beat = 0.5 s)", () => {
    const [e] = clipEvents(clipOf(note("a", 60, PPQ, 2 * PPQ)), 120);
    expect(e).toEqual({ time: 0.5, duration: 1, pitch: 60, gain: 1 });
  });

  it("follows tempo changes", () => {
    expect(clipEvents(clipOf(note("a", 60, PPQ, PPQ)), 60)[0]!.time).toBe(1);
    expect(clipSeconds(clipOf(), 120)).toBe(4); // 2 bars of 4 beats at 120 BPM
  });

  it("skips muted notes, orders by start, and scales gain by velocity", () => {
    const events = clipEvents(clipOf(note("b", 64, PPQ, PPQ, { velocity: 64 }), note("m", 70, 0, PPQ, { muted: true }), note("a", 60, 0, PPQ)), 120);
    expect(events.map((e) => e.pitch)).toEqual([60, 64]);
    expect(events[1]!.gain).toBeCloseTo(64 / 127);
  });

  it("maps MIDI pitch to frequency (A4 = 440 Hz, C4 = 261.63 Hz)", () => {
    expect(pitchToHz(69)).toBe(440);
    expect(pitchToHz(60)).toBeCloseTo(261.63, 2);
  });
});
