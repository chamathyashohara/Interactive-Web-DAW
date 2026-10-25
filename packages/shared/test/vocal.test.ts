import { describe, expect, it } from "vitest";
import { MAX_TRACKS, PPQ, TICKS_PER_BAR, applyOp, createProject, planVocalClip, secondsToTicks, ticksToSeconds, vocalTakeOps, type OpBody, type Project } from "../src";

let n = 0;
function run(project: Project, ops: OpBody[]): Project {
  let p = project;
  for (const b of ops) {
    const r = applyOp(p, { ...b, opId: `v${n++}`, clientId: "t" } as never);
    if (!r.ok) throw new Error(r.reason);
    p = r.project;
  }
  return p;
}
const ids = (i: number) => ({ trackId: `track-v${i}`, clipId: `clip-v${i}`, noteId: `note-v${i}` });

describe("where a recorded vocal goes", () => {
  it("trims the silence before the singer could hear the music (the speaker-to-microphone round trip)", () => {
    const p = planVocalClip({ startTick: TICKS_PER_BAR * 2, tempo: 120, durationSec: 10, latencySec: 0.08, lateSec: 0 });
    expect(p.trimSec).toBeCloseTo(0.08, 9);
    expect(p.startTick).toBe(TICKS_PER_BAR * 2);
    expect(ticksToSeconds(p.lengthTicks, 120)).toBeGreaterThanOrEqual(10 - 0.08 - 0.01);
  });

  it("starts the clip later instead when the recording began late (more late than latency)", () => {
    const p = planVocalClip({ startTick: 0, tempo: 120, durationSec: 5, latencySec: 0.02, lateSec: 0.05 });
    expect(p.trimSec).toBe(0);
    expect(p.startTick).toBe(Math.round(secondsToTicks(0.03, 120)));
  });

  it("is exact: a vocal answering the music with a delay of L lands on the music it answers", () => {
    // The music has an event at song time m (seconds after the start position). The singer reacts the same instant they hear it, but
    // what they hear is delayed by the round trip L, so the event is in the file at m + L. After placement it must be back at m.
    for (const L of [0, 0.011, 0.0463, 0.2]) {
      for (const tempo of [90, 120, 133]) {
        const start = 960 * 7;
        const m = 3.25;
        const plan = planVocalClip({ startTick: start, tempo, durationSec: 12, latencySec: L, lateSec: 0 });
        const fileTime = m + L; // seconds into the file
        const timeline = ticksToSeconds(plan.startTick, tempo) + (fileTime - plan.trimSec); // seconds on the timeline
        expect(timeline).toBeCloseTo(ticksToSeconds(start, tempo) + m, 3);
      }
    }
  });

  it("builds a valid track + clip that the project accepts, longer than the 32-bar drop limit, and lengthens the song", () => {
    const p0 = createProject("p");
    const r = vocalTakeOps(p0, { id: "imported/abc", name: "take" }, { startTick: TICKS_PER_BAR, tempo: p0.tempo, durationSec: 150, latencySec: 0.05, lateSec: 0 }, 1, ids(1), "#22d3ee");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = run(p0, r.ops);
    const track = p.tracks["track-v1"]!;
    expect(track.name).toBe("Vocal take 1");
    const clip = Object.values(track.clips)[0]!;
    expect(clip.audio?.startSec).toBeCloseTo(0.05, 9);
    expect(clip.lengthTicks).toBeGreaterThan(32 * TICKS_PER_BAR);
    expect(p.songBars).toBeGreaterThanOrEqual(Math.ceil((clip.startTick + clip.lengthTicks) / TICKS_PER_BAR));
  });

  it("a second take never touches the first: it gets its own track", () => {
    let p = createProject("p");
    for (const i of [1, 2, 3]) {
      const r = vocalTakeOps(p, { id: `imported/t${i}`, name: `take ${i}` }, { startTick: 0, tempo: p.tempo, durationSec: 8, latencySec: 0.03, lateSec: 0 }, i, ids(i), "#a78bfa");
      expect(r.ok).toBe(true);
      if (r.ok) p = run(p, r.ops);
    }
    expect(Object.values(p.tracks).filter((t) => t.name.startsWith("Vocal take")).map((t) => t.name).sort()).toEqual(["Vocal take 1", "Vocal take 2", "Vocal take 3"]);
    expect(p.tracks["track-v1"]!.sample!.id).toBe("imported/t1");
  });

  it("refuses with a clear message when the song is full of tracks, and when the take cannot fit", () => {
    let p = createProject("p");
    for (let i = 1; p.trackOrder.length < MAX_TRACKS; i++) {
      const r = vocalTakeOps(p, { id: `imported/t${i}`, name: "t" }, { startTick: 0, tempo: p.tempo, durationSec: 2, latencySec: 0, lateSec: 0 }, i, ids(i), "#ffffff");
      if (r.ok) p = run(p, r.ops);
    }
    const full = vocalTakeOps(p, { id: "imported/x", name: "x" }, { startTick: 0, tempo: 120, durationSec: 2, latencySec: 0, lateSec: 0 }, 99, ids(99), "#ffffff");
    expect(full.ok).toBe(false);
    const p0 = createProject("q");
    const huge = vocalTakeOps(p0, { id: "imported/y", name: "y" }, { startTick: 0, tempo: 120, durationSec: 3600, latencySec: 0, lateSec: 0 }, 1, ids(1), "#ffffff");
    expect(huge.ok).toBe(false);
    expect(PPQ).toBe(960);
  });
});
