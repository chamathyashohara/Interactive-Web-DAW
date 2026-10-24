import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SR, decodeWav, starterSpecs } from "../src";
import { ensureStarterLibrary, writeStarterLibrary } from "../src/writeLibrary";

const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "starter-"));
  dirs.push(d);
  return path.join(d, "lib");
};
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const some = () => starterSpecs().filter((s) => ["Punch Kick", "Tight Snare", "Closed Hat Tight"].includes(s.name));

describe("writing the Starter library", () => {
  it("writes WAV files and an index whose entries match the files", () => {
    const dir = tmp();
    const index = writeStarterLibrary(dir, undefined, some());
    expect(index.entries).toHaveLength(3);
    for (const e of index.entries) {
      const wav = decodeWav(new Uint8Array(fs.readFileSync(path.join(dir, e.file))));
      expect(wav.sampleRate).toBe(SR);
      expect(wav.channels.length).toBe(e.channels);
      expect(Math.abs(wav.channels[0]!.length / SR - e.durationSec)).toBeLessThan(0.002);
      expect(e.peaks).toHaveLength(96);
      expect(Math.max(...e.peaks)).toBe(255);
      expect(e.origin).toBe("starter");
      expect(e.file.includes("\\")).toBe(false);
    }
    expect(JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")).entries).toHaveLength(3);
  });

  it("reports progress", () => {
    const seen: number[] = [];
    writeStarterLibrary(tmp(), (done, total) => seen.push(done / total), some());
    expect(seen).toEqual([1 / 3, 2 / 3, 1]);
  });

  it("ensure: generates once, then reuses the installed copy", () => {
    const dir = tmp();
    const first = ensureStarterLibrary(dir, undefined, some());
    const stamp = fs.statSync(path.join(dir, "index.json")).mtimeMs;
    const second = ensureStarterLibrary(dir, () => expect.fail("must not regenerate"), some());
    expect(second.entries.map((e) => e.id)).toEqual(first.entries.map((e) => e.id));
    expect(fs.statSync(path.join(dir, "index.json")).mtimeMs).toBe(stamp);
    expect(fs.existsSync(`${dir}.tmp`)).toBe(false);
  });

  it("ensure: regenerates a damaged or outdated library", () => {
    const dir = tmp();
    ensureStarterLibrary(dir, undefined, some());
    fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify({ version: 0 }));
    const again = ensureStarterLibrary(dir, undefined, some());
    expect(again.entries).toHaveLength(3);
    fs.rmSync(path.join(dir, again.entries[0]!.file));
    expect(ensureStarterLibrary(dir, undefined, some()).entries).toHaveLength(3);
    expect(fs.existsSync(path.join(dir, again.entries[0]!.file))).toBe(true);
  });
});
