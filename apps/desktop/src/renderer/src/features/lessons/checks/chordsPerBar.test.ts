import { describe, expect, it } from "vitest";
import { TICKS_PER_BAR, type Clip, type Note } from "@daw/shared";
import { chords1 } from "../content/chords-1";
import type { ChordTarget } from "../types";
import { checkChordsPerBar } from "./chordsPerBar";

const BAR = TICKS_PER_BAR;
const TARGET: ChordTarget[] = [
  { name: "C major", notes: ["C", "E", "G"] },
  { name: "G major", notes: ["G", "B", "D"] },
  { name: "A minor", notes: ["A", "C", "E"] },
  { name: "F major", notes: ["F", "A", "C"] },
];

let n = 0;
const note = (pitch: number, startTick: number, durationTicks = BAR, extra: Partial<Note> = {}): Note => ({ id: `n${++n}`, pitch, startTick, durationTicks, velocity: 96, ...extra });
const chord = (bar: number, ...pitches: number[]) => pitches.map((p) => note(p, bar * BAR));
const clipOf = (...notes: Note[]): Clip => ({ id: "c", startTick: 0, lengthTicks: 4 * BAR, notes: Object.fromEntries(notes.map((x) => [x.id, x])) });

// Root-position answer: C4-E4-G4, G3-B3-D4, A3-C4-E4, F3-A3-C4.
const correct = () => [...chord(0, 60, 64, 67), ...chord(1, 55, 59, 62), ...chord(2, 57, 60, 64), ...chord(3, 53, 57, 60)];

describe("chordsPerBar", () => {
  it("passes the correct progression", () => {
    const r = checkChordsPerBar(clipOf(...correct()), TARGET);
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
    expect(r.items.every((i) => i.ok)).toBe(true);
    expect(r.feedback).toContain("All 4 chords");
  });

  it("accepts inversions", () => {
    // G major as B3-D4-G4, F major as A3-C4-F4.
    const notes = [...chord(0, 60, 64, 67), ...chord(1, 59, 62, 67), ...chord(2, 57, 60, 64), ...chord(3, 57, 60, 65)];
    expect(checkChordsPerBar(clipOf(...notes), TARGET).pass).toBe(true);
  });

  it("accepts octave doublings", () => {
    const notes = [...correct(), note(43, BAR), note(67, BAR)]; // extra G2 and G4 in bar 2
    expect(checkChordsPerBar(clipOf(...notes), TARGET).pass).toBe(true);
  });

  it("names the first empty bar and its chord when only bar 1 is done (the starting state)", () => {
    const r = checkChordsPerBar(clipOf(...chord(0, 60, 64, 67)), TARGET);
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0.25);
    expect(r.feedback).toBe("Bar 2 should be G major (G, B and D). It is still empty.");
  });

  it("suggests the one change when a single note is wrong", () => {
    const notes = [...chord(0, 60, 64, 67), ...chord(1, 55, 59, 62), ...chord(2, 57, 60, 65), ...chord(3, 53, 57, 60)]; // F instead of E
    const r = checkChordsPerBar(clipOf(...notes), TARGET);
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0.75);
    expect(r.feedback).toBe("Bar 3 should be A minor (A, C and E). You have A, C and F: change F to E.");
    expect(r.items.map((i) => i.ok)).toEqual([true, true, false, true]);
  });

  it("reports a missing note", () => {
    const notes = [...chord(0, 60, 64, 67), ...chord(1, 55, 59), ...chord(2, 57, 60, 64), ...chord(3, 53, 57, 60)];
    expect(checkChordsPerBar(clipOf(...notes), TARGET).feedback).toBe("Bar 2 should be G major (G, B and D). You have G and B: D is missing.");
  });

  it("rejects an extra pitch class", () => {
    const notes = [...correct(), note(65, BAR)]; // F added to G major
    const r = checkChordsPerBar(clipOf(...notes), TARGET);
    expect(r.pass).toBe(false);
    expect(r.feedback).toBe("Bar 2 should be G major (G, B and D). You have G, B, D and F: F doesn't belong in this chord.");
  });

  it("ignores muted notes", () => {
    const notes = [...correct(), note(65, BAR, BAR, { muted: true })];
    expect(checkChordsPerBar(clipOf(...notes), TARGET).pass).toBe(true);
  });

  it("fails an empty clip with score 0", () => {
    const r = checkChordsPerBar(clipOf(), TARGET);
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
    expect(r.feedback).toContain("Bar 1 should be C major");
  });

  it("counts a chord placed slightly off the beat (snap off) and short chords", () => {
    const notes = [...chord(0, 60, 64, 67), ...[55, 59, 62].map((p) => note(p, BAR + 50, 480)), ...[57, 60, 64].map((p) => note(p, 2 * BAR - 100, 960)), ...chord(3, 53, 57, 60)];
    expect(checkChordsPerBar(clipOf(...notes), TARGET).pass).toBe(true);
  });

  it("hears a chord held over from the previous bar", () => {
    // C major held for two bars: bar 2 hears C-E-G plus whatever starts there.
    const notes = [note(60, 0, 2 * BAR), note(64, 0, 2 * BAR), note(67, 0, 2 * BAR), ...chord(1, 55, 59, 62)];
    const r = checkChordsPerBar(clipOf(...notes), TARGET);
    expect(r.items[1]!.ok).toBe(false);
    expect(r.feedback).toContain("C and E don't belong");
  });

  it("does not count a note that only overlaps the bar line by a few ticks", () => {
    const notes = [...[60, 64, 67].map((p) => note(p, 0, BAR + 20)), ...chord(1, 55, 59, 62), ...chord(2, 57, 60, 64), ...chord(3, 53, 57, 60)];
    expect(checkChordsPerBar(clipOf(...notes), TARGET).pass).toBe(true);
  });

  it("is what lesson 1 uses", () => {
    const step = chords1.steps.find((s) => s.kind === "exercise");
    expect(step?.kind === "exercise" && step.exercise.check).toEqual({ kind: "chordsPerBar", chords: TARGET });
  });
});
