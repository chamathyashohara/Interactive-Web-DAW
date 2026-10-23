import { describe, expect, it } from "vitest";
import { applyOp, createProject, createTrack, type Op, type OpBody, type Project } from "@daw/shared";
import { whySilent } from "./audibility";

let n = 0;
const apply = (p: Project, bodies: OpBody[]) =>
  bodies.reduce((acc, b) => {
    const r = applyOp(acc, { opId: `o${++n}`, clientId: "t", ...b } as Op);
    if (!r.ok) throw new Error(r.reason);
    return r.project;
  }, p);
const base = () => apply(createProject("p"), [{ type: "addTrack", track: createTrack("lesson-practice", "Lesson: Practice", "synth", "#22d3ee", "lesson-practice-clip") }]);

describe("whySilent", () => {
  it("is null for an audible track or an unknown one", () => {
    expect(whySilent(base(), "lesson-practice")).toBeNull();
    expect(whySilent(base(), "nope")).toBeNull();
  });

  it("finds a muted lesson track and its fix makes it audible", () => {
    const p = apply(base(), [{ type: "updateTrack", trackId: "lesson-practice", changes: { mute: true } }]);
    const s = whySilent(p, "lesson-practice")!;
    expect(s.reason).toBe("muted");
    expect(whySilent(apply(p, s.fix), "lesson-practice")).toBeNull();
  });

  it("finds a solo on another track and clears every solo", () => {
    const p = apply(base(), [{ type: "updateTrack", trackId: "track-1", changes: { solo: true } }]);
    const s = whySilent(p, "lesson-practice")!;
    expect(s.reason).toBe("soloElsewhere");
    expect(s.message).toContain("Synth");
    expect(whySilent(apply(p, s.fix), "lesson-practice")).toBeNull();
  });

  it("is fine when the lesson track itself is soloed", () => {
    expect(whySilent(apply(base(), [{ type: "updateTrack", trackId: "lesson-practice", changes: { solo: true } }]), "lesson-practice")).toBeNull();
  });

  it("finds a zero fader on the track or the master", () => {
    const t = apply(base(), [{ type: "updateTrack", trackId: "lesson-practice", changes: { volume: 0 } }]);
    expect(whySilent(t, "lesson-practice")!.reason).toBe("trackVolume");
    expect(whySilent(apply(t, whySilent(t, "lesson-practice")!.fix), "lesson-practice")).toBeNull();
    const m = apply(base(), [{ type: "setMasterVolume", volume: 0 }]);
    expect(whySilent(m, "lesson-practice")!.reason).toBe("masterVolume");
    expect(whySilent(apply(m, whySilent(m, "lesson-practice")!.fix), "lesson-practice")).toBeNull();
  });
});
