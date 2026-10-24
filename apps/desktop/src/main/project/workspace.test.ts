import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProject, type OpBody } from "@daw/shared";
import { LocalStore } from "./localStore";
import { ProjectService } from "./projectService";
import { Workspace } from "./workspace";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "daw-ws-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

let t = 1000;
const clock = () => (t += 1000);
const addNote = (id: string): OpBody => ({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id, pitch: 60, startTick: 0, durationTicks: 240, velocity: 90 } });

describe("workspace: many named projects", () => {
  it("starts empty and creates named projects, newest first", () => {
    const ws = new Workspace(tmp(), clock);
    expect(ws.list()).toEqual([]);
    const a = ws.create("Song A");
    const b = ws.create("Song B");
    expect(ws.list().map((p) => p.name)).toEqual(["Song B", "Song A"]); // most recent first
    expect(a.id).not.toBe(b.id);
    expect(ws.exists(a.id)).toBe(true);
  });
  it("blanks and over-long names fall back / are trimmed", () => {
    const ws = new Workspace(tmp(), clock);
    expect(ws.create("   ").name).toBe("Untitled project");
    expect(ws.create("x".repeat(200)).name.length).toBe(80);
  });
  it("gives a usable LocalStore per project, with independent content", () => {
    const root = tmp();
    const ws = new Workspace(root, clock);
    const a = ws.create("A");
    const b = ws.create("B");
    const sa = new ProjectService(ws.storeFor(a.id));
    sa.dispatch(addNote("na"));
    sa.close();
    const sb = new ProjectService(ws.storeFor(b.id));
    expect(Object.keys(sb.current.tracks["track-1"]!.clips["clip-1"]!.notes)).toEqual([]); // B is untouched by edits to A
    sb.close();
    // reopening A recovers its edit and its name
    const again = new ProjectService(ws.storeFor(a.id));
    expect(Object.keys(again.current.tracks["track-1"]!.clips["clip-1"]!.notes)).toEqual(["na"]);
    expect(again.current.name).toBe("A");
    again.close();
  });
  it("tracks the recently opened order via touch", () => {
    const ws = new Workspace(tmp(), clock);
    const a = ws.create("A");
    const b = ws.create("B");
    ws.create("C");
    ws.touch(a.id);
    expect(ws.list().map((p) => p.name)).toEqual(["A", "C", "B"]);
    expect(ws.lastOpenedId()).toBe(a.id);
    ws.touch(b.id);
    expect(ws.lastOpenedId()).toBe(b.id);
  });
  it("renames a project and its stored model name", () => {
    const ws = new Workspace(tmp(), clock);
    const a = ws.create("Old");
    new ProjectService(ws.storeFor(a.id)).close(); // make sure a snapshot exists
    ws.rename(a.id, "New Name");
    expect(ws.meta(a.id)!.name).toBe("New Name");
    expect(new ProjectService(ws.storeFor(a.id)).current.name).toBe("New Name");
  });
  it("duplicates a project (Save As): a full copy with a new id and name, independent thereafter", () => {
    const ws = new Workspace(tmp(), clock);
    const a = ws.create("Original");
    const sa = new ProjectService(ws.storeFor(a.id));
    sa.dispatch(addNote("shared-note"));
    sa.close();
    const copy = ws.duplicate(a.id, "My copy");
    expect(copy.id).not.toBe(a.id);
    const sc = new ProjectService(ws.storeFor(copy.id));
    expect(sc.current.name).toBe("My copy");
    expect(sc.current.id).toBe(copy.id);
    expect(Object.keys(sc.current.tracks["track-1"]!.clips["clip-1"]!.notes)).toEqual(["shared-note"]); // copied content
    sc.dispatch(addNote("only-in-copy"));
    sc.close();
    const sa2 = new ProjectService(ws.storeFor(a.id));
    expect(Object.keys(sa2.current.tracks["track-1"]!.clips["clip-1"]!.notes)).toEqual(["shared-note"]); // original unaffected
    sa2.close();
  });
  it("deletes a project and its files", () => {
    const root = tmp();
    const ws = new Workspace(root, clock);
    const a = ws.create("Doomed");
    ws.create("Keep");
    const dir = path.join(root, a.id);
    expect(fs.existsSync(dir)).toBe(true);
    ws.delete(a.id);
    expect(ws.exists(a.id)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    expect(ws.list().map((p) => p.name)).toEqual(["Keep"]);
  });
  it("ensureAtLeastOne creates a first project only when none exist", () => {
    const ws = new Workspace(tmp(), clock);
    const first = ws.ensureAtLeastOne();
    expect(first.name).toBe("My first project");
    expect(ws.ensureAtLeastOne().id).toBe(first.id); // does not make a second
  });
});

describe("workspace: migration and durability", () => {
  it("adopts an existing single-project folder (the old 'default' layout)", () => {
    const root = tmp();
    // simulate the old layout: a project living directly in <root>/default
    const legacy = new ProjectService(new LocalStore(path.join(root, "default")), undefined, "default");
    legacy.dispatch(addNote("legacy"));
    legacy.close();
    // write a name into it so the workspace can show it
    const snap = path.join(root, "default", "snapshot.json");
    legacy.close();
    const svc = new ProjectService(new LocalStore(path.join(root, "default")));
    svc.close();

    const ws = new Workspace(root, clock);
    const found = ws.list();
    expect(found.some((p) => p.id === "default")).toBe(true);
    const reopened = new ProjectService(ws.storeFor("default"));
    expect(Object.keys(reopened.current.tracks["track-1"]!.clips["clip-1"]!.notes)).toContain("legacy");
    reopened.close();
    expect(fs.existsSync(snap)).toBe(true);
  });
  it("rebuilds the index from folders if index.json is lost", () => {
    const root = tmp();
    const ws1 = new Workspace(root, clock);
    const a = ws1.create("Survivor");
    new ProjectService(ws1.storeFor(a.id)).close();
    fs.rmSync(path.join(root, "index.json"));
    const ws2 = new Workspace(root, clock);
    expect(ws2.list().some((p) => p.id === a.id)).toBe(true); // adopted from its folder
  });
});
