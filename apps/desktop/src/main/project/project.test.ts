import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProject, createTrack, projectHash, type OpBody } from "@daw/shared";
import { LocalStore } from "./localStore";
import { ProjectService } from "./projectService";

const dirs: string[] = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "daw-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const addNote = (id: string, pitch = 60, startTick = 0): OpBody => ({
  type: "addNote",
  trackId: "track-1",
  clipId: "clip-1",
  note: { id, pitch, startTick, durationTicks: 240, velocity: 90 },
});
const notes = (svc: ProjectService) => svc.current.tracks["track-1"]!.clips["clip-1"]!.notes;

describe("recovery", () => {
  it("restores journalled edits after an unclean exit (no close/snapshot)", () => {
    const dir = tmpDir();
    const a = new ProjectService(new LocalStore(dir));
    a.dispatch(addNote("n1", 60));
    a.dispatch(addNote("n2", 64, 240));
    a.dispatch({ type: "setTempo", bpm: 133 });
    const hash = projectHash(a.current);
    // simulate kill: never call close()

    const b = new ProjectService(new LocalStore(dir));
    expect(Object.keys(notes(b)).sort()).toEqual(["n1", "n2"]);
    expect(b.current.tempo).toBe(133);
    expect(projectHash(b.current)).toBe(hash);
  });

  it("ignores a torn final journal line and keeps earlier edits", () => {
    const dir = tmpDir();
    const a = new ProjectService(new LocalStore(dir));
    a.dispatch(addNote("n1"));
    fs.appendFileSync(path.join(dir, "journal.ndjson"), '{"seq":2,"op":{"opId":"x","clientId":"c","type":"addN');

    const b = new ProjectService(new LocalStore(dir));
    expect(Object.keys(notes(b))).toEqual(["n1"]);
    b.dispatch(addNote("n2", 62, 480)); // appends cleanly after the truncated tail
    const c = new ProjectService(new LocalStore(dir));
    expect(Object.keys(notes(c)).sort()).toEqual(["n1", "n2"]);
  });

  it("snapshots after many ops and still recovers exactly", () => {
    const dir = tmpDir();
    const a = new ProjectService(new LocalStore(dir));
    for (let i = 0; i < 250; i++) a.dispatch(addNote(`n${i}`, 40 + (i % 40), (i % 60) * 240 % (4 * 3840 - 240)));
    expect(fs.existsSync(path.join(dir, "snapshot.json"))).toBe(true);
    const hash = projectHash(a.current);
    const b = new ProjectService(new LocalStore(dir));
    expect(projectHash(b.current)).toBe(hash);
    expect(Object.keys(notes(b))).toHaveLength(250);
  });

  it("recovers from a corrupt snapshot using whatever the journal holds", () => {
    const dir = tmpDir();
    const a = new ProjectService(new LocalStore(dir));
    a.dispatch(addNote("n1"));
    fs.writeFileSync(path.join(dir, "snapshot.json"), "{not json");
    const b = new ProjectService(new LocalStore(dir));
    expect(Object.keys(notes(b))).toEqual(["n1"]);
  });
});

describe("undo/redo", () => {
  it("undoes and redoes add, move and tempo", () => {
    const svc = new ProjectService(new LocalStore(tmpDir()));
    svc.dispatch(addNote("n1", 60, 0));
    svc.dispatch({ type: "updateNote", trackId: "track-1", clipId: "clip-1", noteId: "n1", changes: { pitch: 65, startTick: 480 } });
    expect(notes(svc)["n1"]!.pitch).toBe(65);

    svc.undo();
    expect(notes(svc)["n1"]!.pitch).toBe(60);
    expect(notes(svc)["n1"]!.startTick).toBe(0);
    svc.undo();
    expect(Object.keys(notes(svc))).toHaveLength(0);
    svc.redo();
    expect(notes(svc)["n1"]).toBeDefined();
    svc.redo();
    expect(notes(svc)["n1"]!.pitch).toBe(65);
    expect(svc.canRedo).toBe(false);
  });

  it("merges rapid grouped edits (tempo spinner) into a single undo step", () => {
    let t = 0;
    const svc = new ProjectService(new LocalStore(tmpDir()), "c", "default", () => (t += 100));
    svc.dispatch({ type: "setTempo", bpm: 121 }, "tempo");
    svc.dispatch({ type: "setTempo", bpm: 122 }, "tempo");
    svc.dispatch({ type: "setTempo", bpm: 123 }, "tempo");
    expect(svc.current.tempo).toBe(123);
    svc.undo();
    expect(svc.current.tempo).toBe(120);
    expect(svc.canUndo).toBe(false);
  });

  it("undo persists too: recovery after undo reflects the undone state", () => {
    const dir = tmpDir();
    const a = new ProjectService(new LocalStore(dir));
    a.dispatch(addNote("n1"));
    a.undo();
    const b = new ProjectService(new LocalStore(dir));
    expect(Object.keys(notes(b))).toHaveLength(0);
  });
});

describe("batches (multi-note edits as one undo step)", () => {
  const trackNotes = (svc: ProjectService) => Object.keys(notes(svc)).sort();

  it("applies a batch as one undo step", () => {
    const svc = new ProjectService(new LocalStore(tmpDir()));
    svc.dispatchBatch([addNote("a", 60, 0), addNote("b", 62, 240), addNote("c", 64, 480)]);
    expect(trackNotes(svc)).toEqual(["a", "b", "c"]);
    svc.undo();
    expect(trackNotes(svc)).toEqual([]);
    expect(svc.canUndo).toBe(false);
    svc.redo();
    expect(trackNotes(svc)).toEqual(["a", "b", "c"]);
  });

  it("is all-or-nothing: one invalid op rejects the whole batch and changes nothing", () => {
    const dir = tmpDir();
    const svc = new ProjectService(new LocalStore(dir));
    svc.dispatch(addNote("keep", 60, 0));
    const result = svc.dispatchBatch([addNote("x", 62, 240), addNote("bad", 200, 480), addNote("y", 64, 720)]);
    expect(result.ok).toBe(false);
    expect(trackNotes(svc)).toEqual(["keep"]);
    // nothing partial reached the journal either
    const again = new ProjectService(new LocalStore(dir));
    expect(Object.keys(notes(again))).toEqual(["keep"]);
  });

  it("restores ordering inside a batch on undo (add then update of the same note)", () => {
    const svc = new ProjectService(new LocalStore(tmpDir()));
    svc.dispatchBatch([
      addNote("n", 60, 0),
      { type: "updateNote", trackId: "track-1", clipId: "clip-1", noteId: "n", changes: { pitch: 72 } },
    ]);
    expect(notes(svc)["n"]!.pitch).toBe(72);
    svc.undo();
    expect(trackNotes(svc)).toEqual([]);
    svc.redo();
    expect(notes(svc)["n"]!.pitch).toBe(72);
  });
});

describe("multi-track recovery", () => {
  it("restores added/deleted/reordered tracks, mixer settings and muted notes after an unclean exit", () => {
    const dir = tmpDir();
    const a = new ProjectService(new LocalStore(dir));
    const t2 = createTrack("t2", "Drums", "drums", "#f472b6", "t2-clip");
    const t3 = createTrack("t3", "Bass", "synth", "#a3e635", "t3-clip");
    a.dispatch({ type: "addTrack", track: t2 });
    a.dispatch({ type: "addTrack", track: t3, index: 0 });
    a.dispatch({ type: "updateTrack", trackId: "t2", changes: { volume: 41, pan: -20, mute: true, name: "Kit" } });
    a.dispatch({ type: "setMasterVolume", volume: 66 });
    a.dispatch({ type: "addNote", trackId: "t2", clipId: "t2-clip", note: { id: "k", pitch: 36, startTick: 0, durationTicks: 120, velocity: 100, muted: true } });
    a.dispatch({ type: "deleteTrack", trackId: "t3" });
    a.undo(); // brings t3 back at index 0
    const hash = projectHash(a.current);

    const b = new ProjectService(new LocalStore(dir)); // no close() on a => simulated kill
    expect(b.current.trackOrder).toEqual(["t3", "track-1", "t2"]);
    expect(b.current.tracks["t2"]).toMatchObject({ name: "Kit", volume: 41, pan: -20, mute: true });
    expect(b.current.masterVolume).toBe(66);
    expect(b.current.tracks["t2"]!.clips["t2-clip"]!.notes["k"]!.muted).toBe(true);
    expect(projectHash(b.current)).toBe(hash);
  });

  it("opens a project saved by M1 (no mixer fields) and fills in defaults", () => {
    const dir = tmpDir();
    const old = createProject("p") as unknown as Record<string, any>;
    delete old.masterVolume;
    for (const k of ["color", "volume", "pan", "mute", "solo"]) delete old.tracks["track-1"][k];
    fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify({ seq: 0, project: old }));
    const svc = new ProjectService(new LocalStore(dir));
    expect(svc.current.masterVolume).toBe(80);
    expect(svc.current.tracks["track-1"]).toMatchObject({ volume: 80, pan: 0, mute: false, solo: false });
    expect(svc.dispatch({ type: "updateTrack", trackId: "track-1", changes: { volume: 50 } }).ok).toBe(true);
  });
});

describe("a plugin reporting its own saved settings", () => {
  const withPlugin = (dir: string) => {
    const svc = new ProjectService(new LocalStore(dir));
    svc.dispatchBatch([
      { type: "addTrack", track: createTrack("track-p", "Diva", "plugin", "#ff8800", "clip-p") },
      { type: "setPlugin", trackId: "track-p", plugin: { id: "C:/VST3/Diva.vst3", name: "Diva" } },
    ]);
    return svc;
  };

  it("is saved and published, but is not an undo step", () => {
    const svc = withPlugin(tmpDir());
    svc.dispatch(addNote("n1")); // placeholder edit on the default track so there is something after the plugin track
    let published = 0;
    svc.subscribe(() => published++);
    const r = svc.dispatchSilent({ type: "setPlugin", trackId: "track-p", plugin: { id: "C:/VST3/Diva.vst3", name: "Diva", state: "QUJD" } });
    expect(r.ok).toBe(true);
    expect(published).toBe(1);
    expect(svc.current.tracks["track-p"]!.plugin?.state).toBe("QUJD");
    svc.undo(); // takes back the note, not the plugin settings
    expect(Object.keys(notes(svc))).toEqual([]);
    expect(svc.current.tracks["track-p"]!.plugin?.state).toBe("QUJD");
  });

  it("survives an unclean exit, and a rejected state changes nothing", () => {
    const dir = tmpDir();
    const a = withPlugin(dir);
    a.dispatchSilent({ type: "setPlugin", trackId: "track-p", plugin: { id: "C:/VST3/Diva.vst3", name: "Diva", state: "QUJD" } });
    const bad = a.dispatchSilent({ type: "setPlugin", trackId: "track-p", plugin: { id: "", name: "Diva", state: "x" } });
    expect(bad.ok).toBe(false);
    const b = new ProjectService(new LocalStore(dir));
    expect(b.current.tracks["track-p"]!.plugin).toEqual({ id: "C:/VST3/Diva.vst3", name: "Diva", state: "QUJD" });
  });
});
