import { describe, expect, it } from "vitest";
import { migrateProject, PPQ, TICKS_PER_BAR } from "@daw/shared";
import { parseMidi } from "./parseMidi";
import { midiToProject } from "./midiToProject";

// ---- tiny Standard MIDI File builder (for the tests) ----
const vlq = (n: number): number[] => {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
};
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const str = (s: string) => [...s].map((ch) => ch.charCodeAt(0));

/** Builds a format-1 MIDI file. division ticks/quarter; each track is a list of {delta, bytes}. */
function midiFile(division: number, trackEvents: { delta: number; bytes: number[] }[][]): Uint8Array {
  const header = [...str("MThd"), ...u32(6), ...u16(1), ...u16(trackEvents.length), ...u16(division)];
  const out = [...header];
  for (const events of trackEvents) {
    const body: number[] = [];
    for (const e of events) body.push(...vlq(e.delta), ...e.bytes);
    body.push(...vlq(0), 0xff, 0x2f, 0x00); // end of track
    out.push(...str("MTrk"), ...u32(body.length), ...body);
  }
  return new Uint8Array(out);
}
const tempoMeta = (bpm: number) => {
  const us = Math.round(60_000_000 / bpm);
  return { delta: 0, bytes: [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255] };
};
const nameMeta = (name: string) => ({ delta: 0, bytes: [0xff, 0x03, name.length, ...str(name)] });
const noteOn = (delta: number, ch: number, pitch: number, vel: number) => ({ delta, bytes: [0x90 | ch, pitch, vel] });
const noteOff = (delta: number, ch: number, pitch: number) => ({ delta, bytes: [0x80 | ch, pitch, 0] });

describe("parseMidi", () => {
  it("reads notes and scales the file's division to our PPQ", () => {
    // division 480: a quarter note = 480 file ticks; our PPQ is 960, so times double.
    const file = midiFile(480, [[tempoMeta(140), nameMeta("Lead"), noteOn(0, 0, 60, 100), noteOff(480, 0, 60), noteOn(0, 0, 64, 80), noteOff(480, 0, 64)]]);
    const p = parseMidi(file);
    expect(p.tempoBpm).toBe(140);
    expect(p.tracks).toHaveLength(1);
    expect(p.tracks[0]!.name).toBe("Lead");
    expect(p.tracks[0]!.notes.map((n) => [n.pitch, n.startTick, n.durationTicks])).toEqual([
      [60, 0, PPQ],
      [64, PPQ, PPQ],
    ]);
  });
  it("pairs note-off and note-on-with-velocity-0, and keeps the channel", () => {
    const file = midiFile(960, [[noteOn(0, 9, 36, 120), { delta: 240, bytes: [0x90 | 9, 36, 0] }]]); // note-on vel 0 = off
    const n = parseMidi(file).tracks[0]!.notes;
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ pitch: 36, durationTicks: 240, channel: 9 });
  });
  it("handles running status (repeated note-ons without a new status byte)", () => {
    const file = midiFile(960, [[{ delta: 0, bytes: [0x90, 60, 100] }, { delta: 960, bytes: [60, 0] }, { delta: 0, bytes: [62, 100] }, { delta: 960, bytes: [62, 0] }]]);
    expect(parseMidi(file).tracks[0]!.notes.map((n) => n.pitch)).toEqual([60, 62]);
  });
  it("rejects bytes that are not a MIDI file", () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a MIDI file/);
  });
});

describe("midiToProject", () => {
  let n = 0;
  const build = (file: Uint8Array) => midiToProject(parseMidi(file), `p${++n}`, "Imported");

  it("makes a valid project: a track per MIDI track, tempo, and a long-enough song", () => {
    const file = midiFile(960, [
      [tempoMeta(128), nameMeta("Bass"), noteOn(0, 0, 40, 100), noteOff(TICKS_PER_BAR * 2, 0, 40)],
      [nameMeta("Kit"), noteOn(0, 9, 36, 120), noteOff(240, 9, 36)],
    ]);
    const p = build(file);
    expect(p.trackOrder.every((id) => p.tracks[id])).toBe(true); // well-formed
    expect(migrateProject(p)).toBeTruthy(); // round-trips through the loader without changing shape
    expect(p.tempo).toBe(128);
    expect(p.trackOrder).toHaveLength(2);
    const [t0, t1] = p.trackOrder.map((id) => p.tracks[id]!);
    expect(t0!.name).toBe("Bass");
    expect(t0!.instrument).toBe("synth");
    expect(t1!.name).toBe("Kit");
    expect(t1!.instrument).toBe("drums"); // all notes on channel 9
    expect(p.songBars).toBe(2);
    expect(Object.values(t0!.clips)[0]!.lengthTicks).toBe(2 * TICKS_PER_BAR);
    expect(Object.values(t0!.clips)[0]!.notes && Object.keys(Object.values(t0!.clips)[0]!.notes)).toHaveLength(1);
  });
  it("names unnamed synth tracks and keeps every note's pitch/time/velocity", () => {
    const file = midiFile(960, [[noteOn(0, 0, 67, 90), noteOff(480, 0, 67)]]);
    const p = build(file);
    const t = p.tracks[p.trackOrder[0]!]!;
    expect(t.name).toBe("Synth 1");
    const note = Object.values(Object.values(t.clips)[0]!.notes)[0]!;
    expect(note).toMatchObject({ pitch: 67, startTick: 0, durationTicks: 480, velocity: 90 });
  });
  it("refuses a MIDI file that has no notes", () => {
    expect(() => build(midiFile(960, [[tempoMeta(120)]]))).toThrow(/no notes/);
  });
});
