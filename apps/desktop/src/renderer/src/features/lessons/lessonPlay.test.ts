import { describe, expect, it } from "vitest";
import { createProject, createTrack, type Project } from "@daw/shared";
import { lessonSoloOps } from "./lessonPlay";
import { lessonView } from "./studio/checks";

const withTracks = (ids: string[]): Project => {
  const p = createProject("p");
  const tracks = { ...p.tracks };
  for (const id of ids) tracks[id] = createTrack(id, id, "synth", "#fff", `${id}-c`);
  return { ...p, tracks, trackOrder: [...p.trackOrder, ...ids] };
};

describe("lesson Play hears only the lesson", () => {
  it("solos the lesson tracks, never the learner's own", () => {
    const p = withTracks(["lesson-k-a", "lesson-song-piano", "lesson-practice"]);
    const ops = lessonSoloOps(p);
    expect(ops.map((o) => (o as { trackId: string }).trackId)).toEqual(["lesson-k-a", "lesson-song-piano", "lesson-practice"]);
    expect(ops.every((o) => o.type === "updateTrack" && o.changes.solo === true)).toBe(true);
  });
  it("does nothing when only lesson tracks or only the learner's tracks are there, or they are soloed already", () => {
    expect(lessonSoloOps(createProject("p"))).toEqual([]);
    const only = withTracks(["lesson-k-a"]);
    expect(lessonSoloOps({ ...only, trackOrder: ["lesson-k-a"] })).toEqual([]);
    const p = withTracks(["lesson-k-a"]);
    expect(lessonSoloOps({ ...p, tracks: { ...p.tracks, "lesson-k-a": { ...p.tracks["lesson-k-a"]!, solo: true } } })).toEqual([]);
  });
  it("checks ignore that solo: a lesson track added while playing still counts", () => {
    const p = withTracks(["lesson-k-a", "lesson-k-b"]);
    const soloed = { ...p, tracks: { ...p.tracks, "lesson-k-a": { ...p.tracks["lesson-k-a"]!, solo: true } } };
    expect(Object.values(lessonView(soloed).tracks).some((t) => t.solo)).toBe(false);
  });
});
