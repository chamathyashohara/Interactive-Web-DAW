import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computePeaks, decodeWav, encodeWav } from "@daw/sounds";
import { LibraryService, type Analyzer } from "../library/libraryService";
import { EXE_NAME, findRecorderApp, searchRecorderApp } from "./recorderApps";
import { RecordingService, type RecordingState } from "./recordingService";
import { TakeWatcher, looksLikeWav, type TakeFile } from "./takeWatcher";

const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rec-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const touch = (file: string, content: Buffer | string = "x") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const wavBytes = (secs = 0.3) => Buffer.from(encodeWav([Float32Array.from({ length: Math.round(secs * 48000) }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 220 * i) / 48000))]));

describe("finding Producer Studio and Performer Client", () => {
  it("looks in the build folder and prefers a Release build", () => {
    const root = tmp();
    touch(path.join(root, "msvc-x64", "bin", "Debug", EXE_NAME.producer));
    touch(path.join(root, "msvc-x64", "bin", "Release", EXE_NAME.producer));
    const found = searchRecorderApp("producer", [root]);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("Release");
    expect(searchRecorderApp("performer", [root])).toEqual([]);
  });

  it("an override or a program chosen by hand wins over searching, and a missing path is ignored", () => {
    const root = tmp();
    const built = path.join(root, "build", "bin", "Release", EXE_NAME.performer);
    const chosen = path.join(root, "mine", "Perf.exe");
    touch(built);
    touch(chosen);
    expect(findRecorderApp("performer", { roots: [root] })).toBe(built);
    expect(findRecorderApp("performer", { roots: [root], saved: chosen })).toBe(chosen);
    expect(findRecorderApp("performer", { roots: [root], saved: chosen, env: path.join(root, "gone.exe") })).toBe(chosen);
    expect(findRecorderApp("producer", { roots: [root] })).toBeNull();
  });
});

describe("noticing new recordings", () => {
  it("looksLikeWav accepts a real WAV and refuses anything else", () => {
    const dir = tmp();
    touch(path.join(dir, "a.wav"), wavBytes());
    touch(path.join(dir, "b.wav"), "not a wav at all, just text that is long enough");
    expect(looksLikeWav(path.join(dir, "a.wav"))).toBe(true);
    expect(looksLikeWav(path.join(dir, "b.wav"))).toBe(false);
    expect(looksLikeWav(path.join(dir, "missing.wav"))).toBe(false);
  });

  it("offers a new WAV only once it stops growing, and never the ones already there", () => {
    const dir = tmp();
    touch(path.join(dir, "old.wav"), wavBytes());
    const seen: TakeFile[][] = [];
    const w = new TakeWatcher(dir, (t) => seen.push(t), 60_000);
    w.start();
    w.poll();
    expect(w.list()).toEqual([]); // the old one is not offered

    const take = path.join(dir, "session-1", "take-1.wav");
    touch(take, wavBytes(0.2));
    w.poll(); // first sight: size remembered
    expect(w.list()).toEqual([]);
    fs.appendFileSync(take, wavBytes(0.2)); // still being written
    w.poll();
    expect(w.list()).toEqual([]);
    w.poll(); // unchanged since last check: finished
    expect(w.list().map((t) => t.name)).toEqual(["take-1.wav"]);
    expect(seen.length).toBe(1);

    w.poll();
    expect(w.list()).toHaveLength(1); // not offered twice
    w.dismiss(take);
    expect(w.list()).toEqual([]);
    w.stop();
  });

  it("ignores files that are not WAVs and empty files", () => {
    const dir = tmp();
    const w = new TakeWatcher(dir, () => {}, 60_000);
    w.start();
    touch(path.join(dir, "notes.txt"), "hello");
    touch(path.join(dir, "empty.wav"), "");
    touch(path.join(dir, "fake.wav"), "this is not riff data, but it is longer than a header");
    w.poll();
    w.poll();
    w.poll();
    expect(w.list()).toEqual([]);
  });

  it("changing the folder starts the list again", () => {
    const a = tmp();
    const b = tmp();
    const w = new TakeWatcher(a, () => {}, 60_000);
    w.start();
    touch(path.join(a, "x.wav"), wavBytes());
    w.poll();
    w.poll();
    expect(w.list()).toHaveLength(1);
    w.setFolder(b);
    expect(w.list()).toEqual([]);
    expect(w.folder).toBe(b);
    w.stop();
  });
});

describe("RecordingService", () => {
  const make = (root: string, over: Partial<ConstructorParameters<typeof RecordingService>[0]> = {}) => {
    const changes: RecordingState[] = [];
    const svc = new RecordingService({
      settingsFile: path.join(root, "settings", "recording.json"),
      defaultWatchDir: path.join(root, "takes"),
      searchRoots: [path.join(root, "build")],
      onChange: (s) => changes.push(s),
      ...over,
    });
    return { svc, changes };
  };

  it("reports which programs were found, and says so plainly when a program is missing", async () => {
    const root = tmp();
    touch(path.join(root, "build", "bin", "Release", EXE_NAME.producer));
    const { svc } = make(root);
    const st = svc.state();
    expect(st.apps.producer.found).toBe(true);
    expect(st.apps.performer.found).toBe(false);
    const r = await svc.launch("performer");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("PerformerClient.exe was not found");
  });

  it("starts the chosen program as its own process", async () => {
    const root = tmp();
    const { svc } = make(root, { env: { producer: process.execPath } }); // node.exe stands in for a recorder program
    const r = await svc.launch("producer");
    expect(r).toEqual({ ok: true });
  });

  it("remembers a program picked by hand and the watched folder across restarts", () => {
    const root = tmp();
    const exe = path.join(root, "elsewhere", "Producer.exe");
    touch(exe);
    const picked = path.join(root, "my-takes");
    fs.mkdirSync(picked);
    const first = make(root);
    first.svc.locate("producer", exe);
    first.svc.setWatchDir(picked);
    first.svc.stop();
    const second = make(root);
    expect(second.svc.state().apps.producer.path).toBe(exe);
    expect(second.svc.state().watchDir).toBe(picked);
    second.svc.stop();
  });
});

describe("adding a recording to the sound library", () => {
  const fakeAnalyzer: Analyzer = async (file) => {
    const w = decodeWav(new Uint8Array(fs.readFileSync(file)));
    return { durationSec: w.channels[0]!.length / w.sampleRate, sampleRate: w.sampleRate, channels: w.channels.length, peaks: computePeaks(w.channels) };
  };

  it("copies one WAV in, returns its entry, leaves the original, and recognises it the second time", async () => {
    const root = tmp();
    const take = path.join(root, "takes", "take 2026-10-24 vocals.wav");
    touch(take, wavBytes(1));
    const lib = new LibraryService(path.join(root, "lib"), fakeAnalyzer);
    const r = await lib.importFile(take);
    expect(r.ok).toBe(true);
    expect(r.entry?.id).toMatch(/^imported\//);
    expect(r.entry?.durationSec).toBeCloseTo(1, 2);
    expect(r.entry?.pack).toContain("Recording");
    expect(lib.pathOf(r.entry!.id)).not.toBeNull();
    expect(fs.existsSync(take)).toBe(true); // the original is untouched

    const again = await lib.importFile(take);
    expect(again.ok).toBe(true);
    expect(again.entry?.id).toBe(r.entry?.id);
    expect(lib.list().entries.filter((e) => e.id === r.entry!.id)).toHaveLength(1);
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("daw-take-") && fs.existsSync(path.join(os.tmpdir(), n, "x")))).toEqual([]);
  });

  it("refuses something that is not audio, or missing", async () => {
    const root = tmp();
    touch(path.join(root, "a.txt"), "hello");
    const lib = new LibraryService(path.join(root, "lib"), fakeAnalyzer);
    expect((await lib.importFile(path.join(root, "a.txt"))).ok).toBe(false);
    expect((await lib.importFile(path.join(root, "gone.wav"))).ok).toBe(false);
  });
});
