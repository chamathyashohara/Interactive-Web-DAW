import { describe, expect, it } from "vitest";
import { applyOp, createProject, createTrack, type Op, type Project } from "@daw/shared";
import { SlotAllocator, toEngineSnapshot } from "./snapshot";

const run = (p: Project, body: object): Project => {
  const r = applyOp(p, { opId: `pl${Math.random()}`, clientId: "c", ...body } as Op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const pluginTrack = (p: Project) => toEngineSnapshot(p, new SlotAllocator()).tracks.find((t) => t.instrument === "plugin");

describe("plugin tracks in the snapshot", () => {
  it("sends the plugin path (and state) to the engine on a plugin track", () => {
    let p = run(createProject("p"), { type: "addTrack", track: createTrack("tp", "Plugin", "plugin", "#a78bfa", "cp") });
    p = run(p, { type: "setPlugin", trackId: "tp", plugin: { id: "C:/VST3/Diva.vst3", name: "Diva", state: "QUJD" } });
    const et = pluginTrack(p)!;
    expect(et.instrument).toBe("plugin");
    expect(et.pluginPath).toBe("C:/VST3/Diva.vst3");
    expect(et.pluginState).toBe("QUJD");
  });
  it("omits the path when no plugin is chosen", () => {
    const p = run(createProject("p"), { type: "addTrack", track: createTrack("tp", "Plugin", "plugin", "#a78bfa", "cp") });
    const et = pluginTrack(p)!;
    expect(et.instrument).toBe("plugin");
    expect(et.pluginPath).toBeUndefined();
  });
  it("leaves existing tracks untouched (no plugin fields on a synth track)", () => {
    const et = toEngineSnapshot(createProject("p"), new SlotAllocator()).tracks[0]!;
    expect(et.pluginPath).toBeUndefined();
    expect(et.pluginState).toBeUndefined();
  });
});

describe("synth preset in the snapshot", () => {
  it("sends the preset params for a synth track (default when none chosen)", () => {
    const p = createProject("p");
    const et = toEngineSnapshot(p, new SlotAllocator()).tracks[0]!;
    expect(et.instrument).toBe("synth");
    expect(et.synth).toMatchObject({ model: 0, attackSec: 0.004, releaseSec: 0.18 }); // default classic
    const piano = run(p, { type: "setSynthPreset", trackId: "track-1", preset: "keys" });
    expect(toEngineSnapshot(piano, new SlotAllocator()).tracks[0]!.synth!.model).toBe(1);
    const pad = run(p, { type: "setSynthPreset", trackId: "track-1", preset: "pad" });
    expect(toEngineSnapshot(pad, new SlotAllocator()).tracks[0]!.synth!.attackSec).toBeGreaterThan(0.2);
  });
});
