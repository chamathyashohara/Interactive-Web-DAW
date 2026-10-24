import { describe, expect, it } from "vitest";
import { applyOp, createProject, stamp, TICKS_PER_BAR, type Project } from "@daw/shared";
import { buildSeedProject } from "../src/shared/seed";

/** A host project that differs from a fresh default in every field the seed has to carry over. */
function hostProject(): Project {
  let p: Project = createProject("host-1", "My song");
  const steps = [
    stamp({ type: "setSongLength", bars: 32 }, "s1", "t"),
    stamp({ type: "setKey", key: { tonic: 2, mode: "minor" } }, "s2", "t"),
    stamp({ type: "setLoop", loop: { startTick: TICKS_PER_BAR, endTick: 3 * TICKS_PER_BAR } }, "s3", "t"),
    stamp({ type: "setMarkers", markers: [{ id: "m1", tick: 0, name: "Intro" }, { id: "m2", tick: 8 * TICKS_PER_BAR, name: "Drop" }] }, "s4", "t"),
    stamp({ type: "setTempo", bpm: 91 }, "s5", "t"),
  ];
  for (const op of steps) {
    const r = applyOp(p, op);
    if (!r.ok) throw new Error(r.reason);
    p = r.project;
  }
  return p;
}

describe("buildSeedProject: the host's whole song reaches the session", () => {
  it("keeps song length, key, loop, markers, tempo and name", () => {
    const host = hostProject();
    const r = buildSeedProject(host, "session-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.songBars).toBe(32);
    expect(r.project.key).toEqual({ tonic: 2, mode: "minor" });
    expect(r.project.loop).toEqual(host.loop);
    expect(r.project.markers?.map((m) => m.name)).toEqual(["Intro", "Drop"]);
    expect(r.project.tempo).toBe(91);
    expect(r.project.name).toBe("My song");
  });

  it("accepts a clip that runs past the default song length (the length is set before the tracks)", () => {
    const host = hostProject();
    const track = host.tracks[host.trackOrder[0]!]!;
    const clipId = Object.keys(track.clips)[0]!;
    const longTrack = { ...track, clips: { [clipId]: { ...track.clips[clipId]!, startTick: 20 * TICKS_PER_BAR } } };
    const r = buildSeedProject({ ...host, tracks: { [track.id]: longTrack } }, "session-1");
    expect(r.ok).toBe(true);
  });

  it("still gives a fresh default project when there is no seed", () => {
    const r = buildSeedProject(undefined, "session-2");
    expect(r.ok && r.project.songBars === createProject("x").songBars).toBe(true);
  });

  it("refuses a nonsense song length instead of ignoring it", () => {
    const r = buildSeedProject({ ...hostProject(), songBars: 0 }, "session-1");
    expect(r.ok).toBe(false);
  });
});
