import { describe, expect, it } from "vitest";
import { applyOp, createProject, createTrack, invertOp, MAX_PLUGIN_STATE, type Op, type PluginRef, type Project } from "../src";

let n = 0;
const apply = (p: Project, op: Record<string, unknown>) => applyOp(p, { ...op, opId: `pl${++n}`, clientId: "t" } as unknown as Op);
const ok = (p: Project, op: Record<string, unknown>): Project => {
  const r = apply(p, op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
/** A project with one plugin track ("track-p") and the default synth track. */
const withPluginTrack = (): Project => ok(createProject("p"), { type: "addTrack", track: createTrack("track-p", "Plugin", "plugin", "#a78bfa", "clip-p") });
const diva: PluginRef = { id: "C:\\Program Files\\Common Files\\VST3\\Diva(x64).vst3", name: "Diva" };

describe("plugin tracks", () => {
  it("a plugin track can be created, with no plugin chosen yet", () => {
    const p = withPluginTrack();
    expect(p.tracks["track-p"]!.instrument).toBe("plugin");
    expect(p.tracks["track-p"]!.plugin).toBeUndefined();
  });
  it("setPlugin puts a plugin on the track, and null takes it off", () => {
    let p = ok(withPluginTrack(), { type: "setPlugin", trackId: "track-p", plugin: diva });
    expect(p.tracks["track-p"]!.plugin).toEqual(diva);
    p = ok(p, { type: "setPlugin", trackId: "track-p", plugin: null });
    expect("plugin" in p.tracks["track-p"]!).toBe(false);
  });
  it("keeps the plugin's saved state when given, drops it when absent", () => {
    const p = ok(withPluginTrack(), { type: "setPlugin", trackId: "track-p", plugin: { ...diva, state: "QUJD" } });
    expect(p.tracks["track-p"]!.plugin!.state).toBe("QUJD");
  });
  it("refuses a plugin on a non-plugin track", () => {
    expect(apply(createProject("p"), { type: "setPlugin", trackId: "track-1", plugin: diva }).ok).toBe(false);
    expect(apply(withPluginTrack(), { type: "setPlugin", trackId: "nope", plugin: diva }).ok).toBe(false);
  });
  it("refuses a malformed plugin (no path, no name, or an over-long state)", () => {
    const base = withPluginTrack();
    expect(apply(base, { type: "setPlugin", trackId: "track-p", plugin: { id: "", name: "X" } }).ok).toBe(false);
    expect(apply(base, { type: "setPlugin", trackId: "track-p", plugin: { id: "x", name: "" } }).ok).toBe(false);
    expect(apply(base, { type: "setPlugin", trackId: "track-p", plugin: { id: "x", name: "X", state: "a".repeat(MAX_PLUGIN_STATE + 1) } }).ok).toBe(false);
    expect(apply(base, { type: "setPlugin", trackId: "track-p", plugin: 42 as never }).ok).toBe(false);
  });
  it("rejects a plugin track created with a malformed plugin", () => {
    const r = apply(createProject("p"), { type: "addTrack", track: { ...createTrack("tp", "P", "plugin", "#fff", "c"), plugin: { id: "x" } } });
    expect(r.ok).toBe(false);
  });
  it("undoes to the previous plugin (or none)", () => {
    const start = withPluginTrack();
    const set: Op = { type: "setPlugin", trackId: "track-p", plugin: diva, opId: "s1", clientId: "t" };
    const afterSet = applyOp(start, set);
    if (!afterSet.ok) throw new Error("x");
    const undone = applyOp(afterSet.project, invertOp(start, set, "s2")!);
    expect(undone.ok && "plugin" in undone.project.tracks["track-p"]!).toBe(false);

    const serum: PluginRef = { id: "C:\\VST3\\Serum.vst3", name: "Serum" };
    const change: Op = { type: "setPlugin", trackId: "track-p", plugin: serum, opId: "s3", clientId: "t" };
    const afterChange = applyOp(afterSet.project, change);
    if (!afterChange.ok) throw new Error("x");
    const back = applyOp(afterChange.project, invertOp(afterSet.project, change, "s4")!);
    expect(back.ok && back.project.tracks["track-p"]!.plugin).toEqual(diva);
  });
});
