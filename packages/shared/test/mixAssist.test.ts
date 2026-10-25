import { describe, expect, it } from "vitest";
import {
  MixAnalyzer,
  analyzeMix,
  applyOp,
  createProject,
  createTrack,
  faderToDb,
  invertOp,
  linearToDb,
  planFaderChange,
  projectHash,
  restoreIsClean,
  stamp,
  type MixSnapshot,
  type OpBody,
  type Project,
} from "../src";

const apply = (project: Project, body: OpBody): Project => {
  const r = applyOp(project, stamp(body, `op-${Math.random()}`, "t"));
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const applyAll = (project: Project, bodies: OpBody[]) => bodies.reduce(apply, project);

/** A project with a kick, a bass and a pad. */
function mixProject(volumes: Record<string, number> = {}): Project {
  let p = createProject("p");
  p = apply(p, { type: "updateTrack", trackId: "track-1", changes: { name: "Kick", volume: volumes["track-1"] ?? 80 } });
  p = apply(p, { type: "addTrack", track: { ...createTrack("bass", "Bass", "synth", "#22c55e", "c2"), volume: volumes["bass"] ?? 80 } });
  p = apply(p, { type: "addTrack", track: { ...createTrack("pad", "Pad", "synth", "#3b82f6", "c3"), volume: volumes["pad"] ?? 80 } });
  return p;
}
const db = (x: number) => 10 ** (x / 20);
function snapshot(p: Project, o: { master?: number; over?: number; soft?: number; channels?: Record<string, number | null>; seconds?: number }): MixSnapshot {
  const channels: MixSnapshot["channels"] = {};
  for (const id of p.trackOrder) {
    const peakDb = o.channels?.[id];
    channels[id] = { trackId: id, peak: peakDb == null ? 0 : db(peakDb), rms: peakDb == null ? 0 : db(peakDb - 9), seconds: peakDb == null ? 0 : 4, volume: p.tracks[id]!.volume };
  }
  return {
    source: "live",
    pass: 1,
    stale: false,
    playing: false,
    seconds: o.seconds ?? 4,
    master: { prePeak: db(o.master ?? -20), truePeak: null, outPeak: Math.min(1, db(o.master ?? -20)), softClipSeconds: o.soft ?? 0, overSeconds: o.over ?? 0, volume: p.masterVolume },
    channels,
  };
}

describe("fader steps", () => {
  it("knows the fader curve: 100 is 0 dB and every halving is -12 dB", () => {
    expect(faderToDb(100)).toBeCloseTo(0, 6);
    expect(faderToDb(50)).toBeCloseTo(-12.04, 2);
    expect(faderToDb(0)).toBe(-Infinity);
    expect(linearToDb(0.5)).toBeCloseTo(-6.02, 2);
  });
  it("plans a change close to the wanted dB and reports what the step really does", () => {
    const plan = planFaderChange(80, -4)!;
    expect(plan.toVolume).toBeLessThan(80);
    expect(Math.abs(plan.actualDb - -4)).toBeLessThan(0.3);
    expect(plan.actualDb).toBeCloseTo(faderToDb(plan.toVolume) - faderToDb(80), 9);
  });
  it("never produces a no-op, a fader past its ends, or a change in the wrong direction", () => {
    expect(planFaderChange(100, 3)).toBeNull(); // the fader stops at 0 dB
    expect(planFaderChange(1, -6)).toBeNull();
    expect(planFaderChange(80, 0)).toBeNull();
    expect(planFaderChange(80, -0.01)!.toVolume).toBe(79);
    expect(planFaderChange(60, 3)!.toVolume).toBeGreaterThan(60);
  });
});

describe("mixer analysis: channels", () => {
  it("needs some playback before it says anything", () => {
    const p = mixProject();
    expect(analyzeMix(p, null).status).toBe("no-data");
    expect(analyzeMix(p, snapshot(p, { seconds: 0.1, channels: { "track-1": -4 } })).findings).toEqual([]);
  });

  it("1. a channel below its target is fine: no finding, nothing to fix", () => {
    const p = mixProject();
    const r = analyzeMix(p, snapshot(p, { master: -12, channels: { "track-1": -14 } }));
    expect(r.channels.find((c) => c.trackId === "track-1")!.state).toBe("ok");
    expect(r.findings).toEqual([]);
  });

  it("2. a channel above its target gets a fix; the spec's example: -4 dBFS against -8 asks for about 4 dB less", () => {
    const p = mixProject();
    const r = analyzeMix(p, snapshot(p, { master: -7, channels: { "track-1": -4 } }));
    const f = r.findings.find((x) => x.trackId === "track-1")!;
    expect(f.severity).toBe("target");
    expect(f.detected).toContain("-4.0 dBFS");
    expect(f.detected).toContain("-8.0 dBFS");
    const s = f.suggestions[0]!;
    expect(s.ops).toHaveLength(1);
    const after = applyAll(p, s.ops);
    const dbChange = faderToDb(after.tracks["track-1"]!.volume) - faderToDb(80);
    expect(dbChange).toBeLessThan(-3.5);
    expect(dbChange).toBeGreaterThan(-4.5);
    // only this fader moved: everything else in the project is untouched
    expect(after.tracks["bass"]).toEqual(p.tracks["bass"]);
    expect({ ...after.tracks["track-1"]!, volume: 0 }).toEqual({ ...p.tracks["track-1"]!, volume: 0 });
    expect(after.masterVolume).toBe(p.masterVolume);
    // the explanation covers what / which channel / what changes / why / what to listen for
    expect(f.headline).toContain("Kick");
    expect(f.change).toContain("Kick fader");
    expect(f.why.length).toBeGreaterThan(40);
    expect(f.listen).toContain("rest of the mix");
  });

  it("restores the original settings exactly, and can tell when the faders were moved since", () => {
    const p = mixProject();
    const s = analyzeMix(p, snapshot(p, { master: -7, channels: { "track-1": -4 } })).findings.find((x) => x.trackId === "track-1")!.suggestions[0]!;
    const applied = applyAll(p, s.ops);
    expect(restoreIsClean(applied, s.ops)).toBe(true);
    const back = applyAll(applied, s.restore);
    expect(projectHash(back)).toBe(projectHash(p));
    expect(restoreIsClean(apply(applied, { type: "updateTrack", trackId: "track-1", changes: { volume: 10 } }), s.ops)).toBe(false);
  });

  it("a fix is also undoable through the ordinary history inverses", () => {
    const p = mixProject();
    const s = analyzeMix(p, snapshot(p, { master: -7, channels: { "track-1": -4 } })).findings.find((x) => x.trackId === "track-1")!.suggestions[0]!;
    const op = stamp(s.ops[0]!, "fix", "t");
    const inverse = invertOp(p, op, "inv")!;
    const applied = applyOp(p, op);
    expect(applied.ok && applyOp(applied.project, inverse).ok && projectHash((applyOp(applied.project, inverse) as { project: Project }).project)).toBe(projectHash(p));
  });

  it("a channel at full scale is a technical problem even if its target is loose", () => {
    const p = apply(mixProject(), { type: "setMixReference", reference: { masterPeakDb: -6, channelPeakDb: -1, safetyDb: -1.9 } });
    const r = analyzeMix(p, snapshot(p, { master: -3, channels: { bass: 0.4 } }));
    const f = r.findings.find((x) => x.trackId === "bass")!;
    expect(f.severity).toBe("problem");
    expect(f.headline).toContain("full scale");
  });

  it("5. silent channels are reported as silent and never given a made-up level or a finding", () => {
    const p = mixProject();
    const r = analyzeMix(p, snapshot(p, { master: -6, channels: { "track-1": -8, bass: null, pad: null } }));
    for (const id of ["bass", "pad"]) {
      const c = r.channels.find((x) => x.trackId === id)!;
      expect(c.state).toBe("silent");
      expect(c.peakDb).toBe(-Infinity);
    }
    expect(r.findings.filter((f) => f.trackId === "bass" || f.trackId === "pad")).toEqual([]);
    const all = analyzeMix(p, snapshot(p, { master: -200, channels: {} }));
    expect(all.status).toBe("silent");
    expect(all.master).toBeNull();
  });

  it("7. changing a configured target changes the result (per channel and for all)", () => {
    const p = mixProject();
    const snap = snapshot(p, { master: -9, channels: { "track-1": -6 } });
    expect(analyzeMix(p, snap).findings.some((f) => f.trackId === "track-1")).toBe(true); // -6 is over the default -8
    const loose = apply(p, { type: "setMixReference", reference: { masterPeakDb: -6, channelPeakDb: -4, safetyDb: -1.9 } });
    expect(analyzeMix(loose, snapshot(loose, { master: -9, channels: { "track-1": -6 } })).findings.some((f) => f.trackId === "track-1")).toBe(false);
    const own = apply(p, { type: "setMixReference", reference: { masterPeakDb: -6, channelPeakDb: -8, safetyDb: -1.9, channels: { "track-1": -5 } } });
    expect(analyzeMix(own, snapshot(own, { master: -9, channels: { "track-1": -6 } })).findings.some((f) => f.trackId === "track-1")).toBe(false);
    expect(analyzeMix(own, snapshot(own, { master: -9, channels: { bass: -6 } })).findings.some((f) => f.trackId === "bass")).toBe(true); // others keep the default
  });

  it("mentions a very quiet channel only as a note, and only when the master has room", () => {
    const p = mixProject({ pad: 50 });
    const quiet = analyzeMix(p, snapshot(p, { master: -14, channels: { pad: -30 } })).findings.find((f) => f.trackId === "pad")!;
    expect(quiet.severity).toBe("note");
    expect(quiet.suggestions[0]!.label).toContain("Raise");
    const hot = analyzeMix(p, snapshot(p, { master: -1, channels: { pad: -30, bass: -5 } }));
    expect(hot.findings.some((f) => f.trackId === "pad")).toBe(false);
  });
});

describe("mixer analysis: the master", () => {
  it("3. a master that clips is a problem; the text names contributors and offers a choice, and nothing changes by itself", () => {
    const p = mixProject();
    const r = analyzeMix(p, snapshot(p, { master: 1.2, over: 0.02, soft: 0.05, channels: { "track-1": -2, bass: -3, pad: -20 } }));
    expect(r.master!.state).toBe("clipping");
    expect(r.master!.headroomDb).toBeLessThan(0);
    const f = r.findings.find((x) => x.scope === "master")!;
    expect(f.severity).toBe("problem");
    expect(f.detected).toContain("clipping");
    expect(f.detected).toContain("Several channels may be contributing");
    expect(f.detected).toContain("Kick");
    expect(f.detected).not.toContain("Pad");
    expect(f.limits).toContain("will not always solve");
    expect(p.masterVolume).toBe(80); // analysing alone never touches the project
  });

  it("4. several contributing channels: one option lowers only those channels, and every other fader stays", () => {
    const p = mixProject();
    const r = analyzeMix(p, snapshot(p, { master: 1.2, over: 0.02, channels: { "track-1": -2, bass: -3, pad: -20 } }));
    const f = r.findings.find((x) => x.scope === "master")!;
    const share = f.suggestions.find((s) => s.id === "contributors")!;
    expect(share.ops).toHaveLength(2);
    const after = applyAll(p, share.ops);
    expect(after.tracks["pad"]!.volume).toBe(80);
    expect(after.masterVolume).toBe(80);
    expect(after.tracks["track-1"]!.volume).toBeLessThan(80);
    expect(after.tracks["bass"]!.volume).toBeLessThan(80);
    expect(share.predicted).not.toBe("exactly"); // channel peaks may not line up: no promise
    expect(projectHash(applyAll(after, share.restore))).toBe(projectHash(p));
  });

  it("the master option is exact: lowering the master fader by X dB lowers the pre-clip peak by X dB", () => {
    const p = mixProject();
    const r = analyzeMix(p, snapshot(p, { master: 1.2, over: 0.02, channels: { "track-1": -2 } }));
    const quick = r.findings.find((x) => x.scope === "master")!.suggestions.find((s) => s.id === "fader-master")!;
    expect(quick.predicted).toBe("exactly");
    const after = applyAll(p, quick.ops);
    const dropDb = faderToDb(after.masterVolume) - faderToDb(p.masterVolume);
    const targetDrop = -6 - 1.2;
    expect(Math.abs(dropDb - targetDrop)).toBeLessThan(0.7);
  });

  it("above the target but under the warning level is a target note, not a clipping alarm", () => {
    const p = mixProject();
    const r = analyzeMix(p, snapshot(p, { master: -4, channels: { "track-1": -9 } }));
    expect(r.master!.state).toBe("above-target");
    const f = r.findings.find((x) => x.scope === "master")!;
    expect(f.severity).toBe("target");
    expect(f.detected).toContain("not a mastering requirement");
    expect(r.perspective).toContain("does not make a mix balanced");
  });

  it("a master under its target has headroom and no finding", () => {
    const p = mixProject();
    const r = analyzeMix(p, snapshot(p, { master: -9, channels: { "track-1": -10 } }));
    expect(r.master!.state).toBe("ok");
    expect(r.master!.headroomDb).toBeCloseTo(9, 5);
    expect(r.findings).toEqual([]);
  });

  it("the warning level is configurable", () => {
    const base = mixProject();
    const strict = apply(base, { type: "setMixReference", reference: { masterPeakDb: -6, channelPeakDb: -8, safetyDb: -4 } });
    expect(analyzeMix(strict, snapshot(strict, { master: -3, channels: { "track-1": -10 } })).master!.state).toBe("above-warning");
    expect(analyzeMix(base, snapshot(base, { master: -3, channels: { "track-1": -10 } })).master!.state).toBe("above-target");
  });
});

describe("mix reference levels in the project", () => {
  it("are validated, stored, undone and cleared like any other edit", () => {
    const p = createProject("p");
    expect(applyOp(p, stamp({ type: "setMixReference", reference: { masterPeakDb: 3, channelPeakDb: -8, safetyDb: -2 } }, "a", "t")).ok).toBe(false);
    expect(applyOp(p, stamp({ type: "setMixReference", reference: { masterPeakDb: -6, channelPeakDb: NaN, safetyDb: -2 } }, "b", "t")).ok).toBe(false);
    expect(applyOp(p, stamp({ type: "setMixReference", reference: { masterPeakDb: -6, channelPeakDb: -8, safetyDb: -2, channels: { x: 5 } } }, "c", "t")).ok).toBe(false);
    const set = apply(p, { type: "setMixReference", reference: { masterPeakDb: -5.04, channelPeakDb: -9, safetyDb: -2, channels: { "track-1": -7 } } });
    expect(set.mixReference).toEqual({ masterPeakDb: -5, channelPeakDb: -9, safetyDb: -2, channels: { "track-1": -7 } });
    const op = stamp({ type: "setMixReference", reference: null }, "d", "t");
    const inverse = invertOp(set, op, "inv")!;
    const cleared = (applyOp(set, op) as { project: Project }).project;
    expect(cleared.mixReference).toBeUndefined();
    expect(((applyOp(cleared, inverse) as { project: Project }).project).mixReference).toEqual(set.mixReference);
  });
  it("an old project without any is simply on the defaults", () => {
    const p = mixProject();
    expect(p.mixReference).toBeUndefined();
    expect(analyzeMix(p, snapshot(p, { master: -9, channels: { "track-1": -10 } })).reference).toEqual({ masterPeakDb: -6, channelPeakDb: -8, safetyDb: -1.9 });
  });
});

describe("the analyzer", () => {
  const ctx = (p: Project) => ({ project: p, sampleRate: 48000, bufferSize: 480, trackOf: (slot: number) => p.trackOrder[slot] });
  const status = (o: Partial<Parameters<MixAnalyzer["feed"]>[0]> & { callbacks: number }) => ({ playing: true, masterL: 0, masterR: 0, ...o });

  it("builds peak, RMS and time from the engine's numbers", () => {
    const p = mixProject();
    const a = new MixAnalyzer();
    a.feed(status({ callbacks: 0, bus: [0.5, 0, 0], sumSq: [0, 0, 0], frames: [0, 0, 0] }), ctx(p));
    // 100 callbacks of 480 frames = 1 s; the kick sounded for 48000 frames with RMS 0.25
    a.feed(status({ callbacks: 100, prePeak: 0.5, bus: [0.5, 0, 0], sumSq: [2 * 48000 * 0.25 * 0.25, 0, 0], frames: [48000, 0, 0] }), ctx(p));
    const snap = a.snapshot(p);
    expect(snap.seconds).toBeCloseTo(1, 6);
    expect(snap.channels["track-1"]!.peak).toBe(0.5);
    expect(snap.channels["track-1"]!.rms).toBeCloseTo(0.25, 6);
    expect(snap.channels["track-1"]!.seconds).toBeCloseTo(1, 6);
    expect(snap.channels["bass"]!.peak).toBe(0);
    expect(snap.master.prePeak).toBe(0.5);
  });

  it("keeps the highest peak, and starts again when playback starts", () => {
    const p = mixProject();
    const a = new MixAnalyzer();
    a.feed(status({ callbacks: 0, bus: [0.3], sumSq: [0], frames: [0] }), ctx(p));
    a.feed(status({ callbacks: 10, prePeak: 0.9, bus: [0.7], sumSq: [1], frames: [100] }), ctx(p));
    a.feed(status({ callbacks: 20, prePeak: 0.4, bus: [0.2], sumSq: [1], frames: [100] }), ctx(p));
    expect(a.snapshot(p).channels["track-1"]!.peak).toBe(0.7);
    expect(a.snapshot(p).master.prePeak).toBe(0.9);
    a.feed({ playing: false, callbacks: 30, masterL: 0, masterR: 0 }, ctx(p));
    expect(a.snapshot(p).channels["track-1"]!.peak).toBe(0.7); // the result stays after stopping
    const pass = a.snapshot(p).pass;
    a.feed(status({ callbacks: 40, bus: [0.1], sumSq: [0], frames: [10] }), ctx(p));
    expect(a.snapshot(p).pass).toBe(pass + 1);
    expect(a.snapshot(p).channels["track-1"]!.peak).toBe(0.1);
  });

  it("does not count anything while stopped (previewing a note is not part of the song)", () => {
    const p = mixProject();
    const a = new MixAnalyzer();
    a.feed({ playing: false, callbacks: 5, masterL: 1, masterR: 1, prePeak: 2, bus: [0.9], sumSq: [5], frames: [10] }, ctx(p));
    expect(a.snapshot(p).master.prePeak).toBe(0);
    expect(a.snapshot(p).channels["track-1"]!.peak).toBe(0);
  });

  it("forgets a channel's old numbers when its fader moves (an old peak says nothing about the new gain)", () => {
    const p = mixProject();
    const a = new MixAnalyzer();
    a.feed(status({ callbacks: 0, bus: [0.8, 0.5], sumSq: [0, 0], frames: [0, 0] }), ctx(p));
    a.feed(status({ callbacks: 5, bus: [0.8, 0.5], sumSq: [1, 1], frames: [100, 100] }), ctx(p));
    const moved = apply(p, { type: "updateTrack", trackId: "track-1", changes: { volume: 60 } });
    a.feed(status({ callbacks: 10, bus: [0.0, 0.5], sumSq: [0, 1], frames: [0, 100] }), ctx(moved));
    const snap = a.snapshot(moved);
    expect(snap.channels["track-1"]!.peak).toBe(0);
    expect(snap.channels["bass"]!.peak).toBe(0.5); // untouched channels keep theirs
    expect(a.snapshot(moved).master.prePeak).toBe(0); // the master is their sum: its old peak is out of date too
    expect(a.snapshot(moved).stale).toBe(true);
    const masterMoved = apply(moved, { type: "setMasterVolume", volume: 50 });
    a.feed(status({ callbacks: 15, prePeak: 0.2, bus: [0, 0], sumSq: [0, 0], frames: [0, 0] }), ctx(masterMoved));
    expect(a.snapshot(masterMoved).master.prePeak).toBe(0.2);
  });

  it("says the measurement is out of date after a change, until the song is played again", () => {
    const p = mixProject();
    const a = new MixAnalyzer();
    a.feed(status({ callbacks: 0, bus: [0.8], sumSq: [0], frames: [0] }), ctx(p));
    a.feed(status({ callbacks: 100, prePeak: 0.9, bus: [0.8], sumSq: [1], frames: [48000] }), ctx(p));
    expect(a.snapshot(p).stale).toBe(false);
    const moved = apply(p, { type: "updateTrack", trackId: "track-1", changes: { volume: 60 } });
    a.feed({ playing: false, callbacks: 101, masterL: 0, masterR: 0 }, ctx(moved));
    const snap = a.snapshot(moved);
    expect(snap.stale).toBe(true);
    expect(analyzeMix(moved, snap).status).toBe("stale");
    expect(analyzeMix(moved, snap).findings).toEqual([]);
    a.feed(status({ callbacks: 102, bus: [0.1], sumSq: [0], frames: [10] }), ctx(moved));
    expect(a.snapshot(moved).stale).toBe(false); // a new playback measures the new mix
  });

  it("loads a whole-song result, keeps it until the mix changes, and adds the true peak", () => {
    const p = mixProject();
    const a = new MixAnalyzer();
    a.feed({ playing: false, callbacks: 0, masterL: 0, masterR: 0 }, ctx(p));
    a.loadWholeSong({ sampleRate: 48000, totalFrames: 4 * 48000, prePeak: 0.5, truePeak: 0.6, outPeak: 0.5, softClips: 0, overs: 0, bus: [0.5, 0.2], sumSq: [2 * 48000 * 0.01, 0], frames: [48000, 48000] }, ctx(p));
    a.feed({ playing: false, callbacks: 1, masterL: 0, masterR: 0 }, ctx(p));
    const snap = a.snapshot(p);
    expect(snap.source).toBe("song");
    expect(snap.seconds).toBeCloseTo(4, 6);
    expect(snap.master.truePeak).toBe(0.6);
    expect(snap.channels["track-1"]!.peak).toBe(0.5);
    expect(snap.channels["track-1"]!.rms).toBeCloseTo(0.1, 6);
    const r = analyzeMix(p, snap);
    expect(r.master!.truePeakDb).toBeCloseTo(linearToDb(0.6), 6);
    expect(r.master!.prePeakDb).toBeCloseTo(linearToDb(0.5), 6);
    const moved = apply(p, { type: "setMasterVolume", volume: 70 });
    a.feed({ playing: false, callbacks: 2, masterL: 0, masterR: 0 }, ctx(moved));
    expect(a.snapshot(moved).stale).toBe(true);
    expect(a.snapshot(moved).master.truePeak).toBeNull();
  });

  it("counts soft-clip and over time from the engine's sample counts", () => {
    const p = mixProject();
    const a = new MixAnalyzer();
    a.feed(status({ callbacks: 0 }), ctx(p));
    a.feed(status({ callbacks: 10, prePeak: 1.3, softClips: 4800, overs: 2400 }), ctx(p));
    const m = a.snapshot(p).master;
    expect(m.softClipSeconds).toBeCloseTo(0.1, 6);
    expect(m.overSeconds).toBeCloseTo(0.05, 6);
  });
});
