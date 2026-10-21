import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computePeaks, decodeWav, encodeWav, starterSpecs } from "@daw/sounds";
import { LibraryService, systemTar, type Analyzer } from "./libraryService";
import { SampleAnalyzer } from "./sampleAnalyzer";

const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lib-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Stands in for the engine: decodes our own 16-bit WAVs. */
const fakeAnalyzer: Analyzer = async (file) => {
  const w = decodeWav(new Uint8Array(fs.readFileSync(file)));
  return { durationSec: w.channels[0]!.length / w.sampleRate, sampleRate: w.sampleRate, channels: w.channels.length, peaks: computePeaks(w.channels) };
};

const tone = (secs: number, hz = 220): Float32Array => Float32Array.from({ length: Math.round(secs * 48000) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / 48000));
const writeWav = (file: string, secs: number, hz = 220) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeWav([tone(secs, hz)]));
};

/** A pack shaped like a typical third-party download. */
function makePack(root: string): string {
  const d = path.join(root, "KSHMR Pack");
  writeWav(path.join(d, "Drums", "Kicks", "KSHMR Big Kick 01 (A).wav"), 0.5, 55);
  writeWav(path.join(d, "Drums", "Kicks", "KSHMR Tight Kick 02.wav"), 0.4, 60);
  writeWav(path.join(d, "Drums", "Snares", "KSHMR Crack Snare 01.wav"), 0.3, 800);
  writeWav(path.join(d, "Drums", "Snares", "KSHMR Fat Snare 02.wav"), 0.3, 700);
  writeWav(path.join(d, "Drums", "Hats", "KSHMR Open Hat 01.wav"), 0.4, 6000);
  writeWav(path.join(d, "Drums", "Hats", "KSHMR Closed Hat 01.wav"), 0.1, 7000);
  writeWav(path.join(d, "Drums", "Claps", "KSHMR Clap 01.wav"), 0.2, 900);
  writeWav(path.join(d, "FX", "KSHMR Riser 128 bpm.wav"), 1.0, 300);
  writeWav(path.join(d, "Loops", "KSHMR Drum Loop 120 bpm.wav"), 4.0, 100);
  writeWav(path.join(d, "Bass", "KSHMR Sub Bass (F#m).wav"), 1.0, 46);
  fs.writeFileSync(path.join(d, "readme.txt"), "not audio");
  return d;
}

describe("importing a folder", () => {
  it("removes the brand word, categorises, reads tags and copies the audio", async () => {
    const root = tmp();
    const src = makePack(root);
    const lib = new LibraryService(path.join(root, "lib"), fakeAnalyzer);
    const progress: number[] = [];
    const r = await lib.importPath(src, (p) => progress.push(p.done));
    expect(r.ok).toBe(true);
    expect(r.brandRemoved).toBe("KSHMR");
    expect(r.added).toBe(10);
    expect(r.failed).toEqual([]);
    expect(r.pack).toBe("Pack");
    expect(progress.at(-1)).toBe(10);

    const { entries } = lib.list();
    const by = (n: string) => entries.find((e) => e.name === n)!;
    expect(entries.some((e) => /kshmr/i.test(e.name + e.file + e.pack + e.tags.join(" ")))).toBe(false);
    expect(by("Big Kick 01").category).toBe("Kick");
    expect(by("Big Kick 01").meta.rootPc).toBe(9);
    expect(by("Crack Snare 01").category).toBe("Snare");
    expect(by("Open Hat 01").sub).toBe("Open Hat");
    expect(by("Clap 01").category).toBe("Clap");
    expect(by("Riser 128 bpm").category).toBe("FX");
    const loop = by("Drum Loop 120 bpm");
    expect(loop.category).toBe("Loop");
    expect(loop.meta).toMatchObject({ bpm: 120, bars: 2, loop: true });
    expect(by("Sub Bass").meta.key).toEqual({ tonic: 6, mode: "minor" });
    expect(by("Big Kick 01").peaks).toHaveLength(96);
    expect(by("Big Kick 01").origin).toBe("imported");
    for (const e of entries) {
      const abs = lib.pathOf(e.id)!;
      expect(abs && fs.existsSync(abs)).toBeTruthy();
      expect(abs.startsWith(path.join(root, "lib"))).toBe(true); // copied into the library, not referenced in place
    }
    expect(fs.existsSync(src)).toBe(true); // the original is untouched
  });

  it("is idempotent: importing the same pack again adds nothing", async () => {
    const root = tmp();
    const src = makePack(root);
    const lib = new LibraryService(path.join(root, "lib"), fakeAnalyzer);
    await lib.importPath(src);
    const again = await lib.importPath(src);
    expect(again.added).toBe(0);
    expect(again.duplicates).toBe(10);
    expect(lib.list().entries).toHaveLength(10);
  });

  it("the library survives a restart", async () => {
    const root = tmp();
    const src = makePack(root);
    const first = new LibraryService(path.join(root, "lib"), fakeAnalyzer);
    await first.importPath(src);
    const second = new LibraryService(path.join(root, "lib"), fakeAnalyzer);
    expect(second.list().entries.map((e) => e.id).sort()).toEqual(first.list().entries.map((e) => e.id).sort());
  });

  it("reports unreadable files and keeps importing the rest", async () => {
    const root = tmp();
    const src = makePack(root);
    const bad: Analyzer = async (f) => {
      if (f.includes("Tight Kick")) throw new Error("unsupported or damaged audio file");
      return fakeAnalyzer(f);
    };
    const lib = new LibraryService(path.join(root, "lib"), bad);
    const r = await lib.importPath(src);
    expect(r.added).toBe(9);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.reason).toMatch(/damaged/);
  });

  it("refuses things that are not a pack, with a reason", async () => {
    const root = tmp();
    const lib = new LibraryService(path.join(root, "lib"), fakeAnalyzer);
    expect((await lib.importPath(path.join(root, "nope"))).reason).toMatch(/cannot be found/);
    fs.mkdirSync(path.join(root, "empty"));
    expect((await lib.importPath(path.join(root, "empty"))).reason).toMatch(/No audio files/);
    fs.writeFileSync(path.join(root, "x.txt"), "hi");
    expect((await lib.importPath(path.join(root, "x.txt"))).reason).toMatch(/\.zip/);
  });

  it("gives a second pack with the same name its own name", async () => {
    const root = tmp();
    const lib = new LibraryService(path.join(root, "lib"), fakeAnalyzer);
    const a = path.join(root, "A", "My Pack");
    const b = path.join(root, "B", "My Pack");
    writeWav(path.join(a, "Kick 1.wav"), 0.2, 50);
    writeWav(path.join(b, "Kick 2.wav"), 0.2, 60);
    expect((await lib.importPath(a)).pack).toBe("My Pack");
    expect((await lib.importPath(b)).pack).toBe("My Pack 2");
  });

  it("removes an imported pack and its files, but not the Starter packs", async () => {
    const root = tmp();
    const src = makePack(root);
    const lib = new LibraryService(path.join(root, "lib"), fakeAnalyzer);
    const r = await lib.importPath(src);
    const some = lib.list().entries[0]!;
    const abs = lib.pathOf(some.id)!;
    expect(lib.removePack("Starter Drums")).toBe(false);
    expect(lib.removePack(r.pack!)).toBe(true);
    expect(fs.existsSync(abs)).toBe(false);
    expect(lib.list().entries).toHaveLength(0);
  });
});

describe("importing a zip", () => {
  it("unpacks with the system tar, then imports like a folder", async () => {
    const root = tmp();
    const src = makePack(root);
    const zip = path.join(root, "kshmr samples.zip");
    const made = spawnSync(systemTar(), ["-a", "-cf", zip, "-C", src, "."], { windowsHide: true });
    if (made.status !== 0 || !fs.existsSync(zip)) return; // this machine's tar cannot create zips; skip
    expect(fs.readFileSync(zip).subarray(0, 2).toString("latin1")).toBe("PK"); // a real zip, not a renamed tar
    const lib = new LibraryService(path.join(root, "lib"), fakeAnalyzer);
    const r = await lib.importPath(zip);
    expect(r.ok).toBe(true);
    expect(r.added).toBe(10);
    expect(r.pack).toBe("samples"); // the brand word comes out of the pack name too
    expect(r.brandRemoved).toBe("KSHMR");
    expect(fs.readdirSync(path.join(root, "lib")).filter((n) => n.startsWith("import-"))).toEqual([]); // temp folder cleaned up
  });

  it("reports a broken zip", async () => {
    const root = tmp();
    const zip = path.join(root, "broken.zip");
    fs.writeFileSync(zip, "this is not a zip");
    const lib = new LibraryService(path.join(root, "lib"), fakeAnalyzer);
    const r = await lib.importPath(zip);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unpack/);
  });
});

describe("the Starter packs", () => {
  it("are generated into the library on first run and reused afterwards", async () => {
    const root = tmp();
    const lib = new LibraryService(path.join(root, "lib"), fakeAnalyzer);
    const seen: number[] = [];
    const list = await lib.init((d, t) => seen.push(d / t));
    expect(list.entries.length).toBe(starterSpecs().length);
    expect(list.packs.map((p) => p.name)).toContain("Starter Drums");
    expect(seen.at(-1)).toBe(1);
    const kick = list.entries.find((e) => e.name === "Punch Kick")!;
    expect(fs.existsSync(lib.pathOf(kick.id)!)).toBe(true);
    const again: number[] = [];
    await new LibraryService(path.join(root, "lib"), fakeAnalyzer).init((d) => again.push(d));
    expect(again).toEqual([]); // nothing regenerated
  }, 60_000);
});

describe("SampleAnalyzer", () => {
  it("matches answers to requests by id, and fails requests when the engine goes away", async () => {
    const sent: { id: string; path: string }[] = [];
    let up = true;
    const a = new SampleAnalyzer((c) => sent.push(c), () => up, 5000);
    const p1 = a.analyze("a.wav");
    const p2 = a.analyze("b.wav");
    a.onInfo({ t: "sampleInfo", id: sent[1]!.id, ok: true, durationSec: 2, sampleRate: 48000, channels: 2, frames: 96000, peak: 0.5, peaks: [] });
    a.onInfo({ t: "sampleInfo", id: sent[0]!.id, ok: false, message: "damaged" });
    await expect(p2).resolves.toMatchObject({ durationSec: 2 });
    await expect(p1).rejects.toThrow("damaged");
    const p3 = a.analyze("c.wav");
    a.failAll("engine down");
    await expect(p3).rejects.toThrow("engine down");
    up = false;
    await expect(a.analyze("d.wav")).rejects.toThrow(/not running/);
  });
});
