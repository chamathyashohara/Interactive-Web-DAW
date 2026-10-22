import { describe, expect, it } from "vitest";
import { applyOp, createProject, createTrack, type Op, type Project } from "@daw/shared";
import { SlotAllocator, toEngineSnapshot } from "./snapshot";

let n = 0;
const run = (p: Project, body: object): Project => {
  const r = applyOp(p, { opId: `a${++n}`, clientId: "c", ...body } as Op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

describe("clip audio settings in the snapshot", () => {
  it("turns dB, ticks and the sound's own start point into the engine's linear gain and seconds, following the tempo fit", () => {
    const t = createTrack("tl", "Loop", "sample", "#34d399", "cl");
    t.sample = { id: "x", name: "x", gate: true, bpm: 90, fit: true };
    t.clips = {
      cl: {
        id: "cl",
        startTick: 3840,
        lengthTicks: 3840,
        notes: { n1: { id: "n1", pitch: 60, startTick: 0, durationTicks: 3840, velocity: 100 } },
        audio: { gainDb: -6, fadeInTicks: 960, fadeOutTicks: 480, startSec: 1.2 },
      },
    };
    const p = run(createProject("p"), { type: "addTrack", track: t }); // 120 BPM, so the 90 BPM loop is stretched by 120/90
    const note = toEngineSnapshot(p, new SlotAllocator(), () => "C:/x.wav").tracks.find((x) => x.instrument === "sample")!.notes[0]!;
    expect(note.startTick).toBe(3840);
    expect(note.gain).toBeCloseTo(10 ** (-6 / 20), 6);
    expect(note.fadeInSec).toBeCloseTo(0.5, 6); // 960 ticks at 120 BPM
    expect(note.fadeOutSec).toBeCloseTo(0.25, 6);
    expect(note.offsetSec).toBeCloseTo(1.2 / (120 / 90), 6); // the stretched sound is shorter, so its start point moves earlier
    expect(note.cut).toBe(true); // a fade out cuts the sound at the clip end
  });

  it("leaves notes of clips without settings, and of non-sample tracks, untouched", () => {
    const p = run(createProject("p"), { type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "n", pitch: 60, startTick: 0, durationTicks: 480, velocity: 100 } });
    const note = toEngineSnapshot(p, new SlotAllocator()).tracks[0]!.notes[0]!;
    expect(Object.keys(note).sort()).toEqual(["durationTicks", "pitch", "startTick", "velocity"]);
  });
});
