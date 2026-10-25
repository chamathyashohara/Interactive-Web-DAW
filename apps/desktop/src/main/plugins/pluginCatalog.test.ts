import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginCatalog } from "./pluginCatalog";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "daw-catalog-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const touch = (dir: string, name: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), "x");
  return path.join(dir, name);
};
const settings = () => path.join(root, "settings", "plugin-folders.json");

describe("plugin catalog", () => {
  it("lists what is in the standard folders, both VST3 and VST2", () => {
    const std = path.join(root, "std");
    touch(std, "Diva.vst3");
    touch(std, "Nexus.dll");
    const list = new PluginCatalog(settings(), [std]).list();
    expect(list.entries.map((e) => [e.name, e.format])).toEqual([["Diva", "vst3"], ["Nexus", "vst2"]]);
    expect(list.folders).toEqual([std]);
  });
  it("searches folders the user adds, and remembers them across restarts", () => {
    const mine = path.join(root, "mine");
    touch(mine, "Serum.vst3");
    const a = new PluginCatalog(settings(), []);
    expect(a.addFolder(mine)).toBe(true);
    expect(a.list().entries.map((e) => e.name)).toEqual(["Serum"]);
    const b = new PluginCatalog(settings(), []); // a new run reads the saved file
    expect(b.list().entries.map((e) => e.name)).toEqual(["Serum"]);
    expect(b.list().userFolders).toEqual([mine]);
  });
  it("refuses a folder that does not exist, and can forget one", () => {
    const c = new PluginCatalog(settings(), []);
    expect(c.addFolder(path.join(root, "nope"))).toBe(false);
    const mine = path.join(root, "mine");
    fs.mkdirSync(mine);
    c.addFolder(mine);
    c.removeFolder(mine);
    expect(c.list().userFolders).toEqual([]);
  });
  it("accepts a single plugin file chosen by hand, wherever it lives", () => {
    const elsewhere = touch(path.join(root, "weird", "place"), "Sylenth1.vst3");
    const c = new PluginCatalog(settings(), []);
    expect(c.addFile(elsewhere)?.name).toBe("Sylenth1");
    expect(new PluginCatalog(settings(), []).list().entries.map((e) => e.id)).toEqual([elsewhere]); // remembered
    expect(c.addFile(touch(root, "notes.txt"))).toBeNull(); // not a plugin file
  });
  it("drops a remembered file that has since been deleted", () => {
    const f = touch(path.join(root, "x"), "Gone.vst3");
    const c = new PluginCatalog(settings(), []);
    c.addFile(f);
    fs.rmSync(f);
    expect(c.list().entries).toEqual([]);
  });
  it("does not list the same plugin twice when it is in a standard folder and was also chosen by hand", () => {
    const std = path.join(root, "std");
    const f = touch(std, "Diva.vst3");
    const c = new PluginCatalog(settings(), [std]);
    c.addFile(f);
    expect(c.list().entries).toHaveLength(1);
  });
});
