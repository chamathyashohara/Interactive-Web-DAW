import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPluginFolders, scanPlugins } from "./pluginScan";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "daw-plugins-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const file = (dir: string, name: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), "x");
};
const bundleDir = (dir: string, name: string) => fs.mkdirSync(path.join(dir, name), { recursive: true });

describe("scanning for VST3 plugins", () => {
  it("finds both .vst3 files and .vst3 bundle folders, named without the extension", () => {
    file(root, "Sylenth1.vst3");
    bundleDir(root, "Nexus.vst3");
    file(root, "notes.txt");
    const found = scanPlugins([root]);
    expect(found.map((p) => p.name)).toEqual(["Nexus", "Sylenth1"]); // sorted by name
    expect(found.find((p) => p.name === "Nexus")!.bundle).toBe(true);
    expect(found.find((p) => p.name === "Sylenth1")!.bundle).toBe(false);
    expect(found.find((p) => p.name === "Sylenth1")!.id).toBe(path.join(root, "Sylenth1.vst3"));
  });
  it("merges several folders and does not list the same plugin twice", () => {
    const a = path.join(root, "a"), b = path.join(root, "b");
    file(a, "Serum.vst3");
    file(b, "Serum.vst3"); // different folder, same name: both ids differ, both kept
    file(b, "Massive.vst3");
    const found = scanPlugins([a, b, a]); // a repeated: still each id once
    expect(found.map((p) => p.name)).toEqual(["Massive", "Serum", "Serum"]);
    expect(new Set(found.map((p) => p.id)).size).toBe(3);
  });
  it("finds a .vst3 nested one level inside a vendor folder (e.g. Spire's layout)", () => {
    bundleDir(root, "Spire-1.5_x64");
    file(path.join(root, "Spire-1.5_x64"), "Spire.vst3");
    file(path.join(root, "Spire-1.5_x64"), "manual.pdf");
    const found = scanPlugins([root]);
    expect(found.map((p) => p.name)).toEqual(["Spire"]);
    expect(found[0]!.id).toBe(path.join(root, "Spire-1.5_x64", "Spire.vst3"));
  });
  it("skips missing or unreadable folders without throwing", () => {
    file(root, "OnlyOne.vst3");
    expect(scanPlugins([path.join(root, "does-not-exist"), root]).map((p) => p.name)).toEqual(["OnlyOne"]);
    expect(scanPlugins([])).toEqual([]);
  });
});

describe("default folders", () => {
  it("offers the standard Windows VST3 locations", () => {
    const folders = defaultPluginFolders({ CommonProgramFiles: "C:\\Program Files\\Common Files", LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" } as NodeJS.ProcessEnv);
    if (process.platform === "win32") {
      expect(folders).toContain("C:\\Program Files\\Common Files\\VST3");
      expect(folders.some((f) => f.includes("AppData"))).toBe(true);
    } else {
      expect(folders.length).toBeGreaterThan(0); // other platforms still return sensible defaults
    }
  });
});
