import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TakeStatus, wav } from "../src";
import { CaptureRecorderPort } from "../src/node";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

class ManualClock {
  ns = 5_000_000_000;
  nowNs() { return this.ns; }
}

const RATE = 48000;
const BLOCK = 480; // 10 ms

/** Feeds the recorder blocks whose samples encode their own frame index, one block per 10 ms of the manual clock. */
function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rr-cap-"));
  dirs.push(root);
  const clock = new ManualClock();
  const rec = new CaptureRecorderPort({ recordingsRoot: root, clock });
  rec.setCaptureState({ open: true, deviceName: "test mic", sampleRate: RATE, channels: 1 });
  let frame = 0;
  const feed = (blocks: number) => {
    for (let b = 0; b < blocks; b++) {
      const s = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) s[i] = (frame + i) / 1e6; // value = frame index / 1e6
      clock.ns += (BLOCK / RATE) * 1e9;
      rec.onCapture(frame, s);
      frame += BLOCK;
    }
  };
  return { root, clock, rec, feed, frameNow: () => frame };
}

function readSamples(file: string) {
  const b = fs.readFileSync(file);
  const info = wav.inspectWav(new Uint8Array(b.subarray(0, 4096)), b.length);
  const floats = new Float32Array(new Uint8Array(b.subarray(info.dataOffset)).buffer, 0, info.frames);
  return { info, floats: Float32Array.from(floats) };
}

describe("CaptureRecorderPort", () => {
  it("is ready only with a healthy microphone, a writable folder and enough disk", () => {
    const r = rig();
    expect(r.rec.readiness().ok).toBe(false); // no audio yet
    r.feed(5);
    const ok = r.rec.readiness();
    expect(ok.ok).toBe(true);
    expect(ok.checks.length).toBe(5);
    r.clock.ns += 5e9; // audio stops arriving
    expect(r.rec.readiness().ok).toBe(false);
  });

  it("starts on the sample that matches the scheduled time and ends on the exact stop sample", () => {
    const r = rig();
    r.feed(20);
    const startNs = r.clock.ns + 300e6; // 300 ms from now
    expect(r.rec.scheduleTake({ takeId: 1, sessionId: "1a2b3c4d", role: "performer", maxTakeSeconds: 60, startAtNs: startNs })).toBe("");
    r.feed(40); // 400 ms: the start (300 ms ahead) is inside
    const events = r.rec.poll();
    expect(events.map((e) => e.kind)).toEqual(["started"]);
    const started = events[0]!;
    const expectedFrame = Math.ceil(r.rec.captureClock.frameAt(startNs));
    expect(started.firstFrame).toBe(expectedFrame);
    expect(started.lateFrames).toBe(0);
    // the same instant the other PC would use differs by less than one sample
    expect(Math.abs(started.firstSampleNs - startNs)).toBeLessThan(1e9 / RATE + 1);

    const stopNs = r.clock.ns + 200e6;
    r.rec.scheduleStop(stopNs, true);
    r.feed(30);
    const fin = r.rec.poll();
    expect(fin.map((e) => e.kind)).toEqual(["finalised"]);
    const e = fin[0]!;
    expect(e.status).toBe(TakeStatus.Complete);
    expect(e.finalised).toBe(true);
    expect(path.basename(e.file)).toBe("take01_performer_1a2b3c4d.wav");
    const stopFrame = Math.ceil(r.rec.captureClock.frameAt(stopNs));
    expect(e.frames).toBe(stopFrame - expectedFrame);

    const { info, floats } = readSamples(e.file);
    expect(info.ok).toBe(true);
    expect(info.frames).toBe(e.frames);
    expect(floats[0]).toBeCloseTo(expectedFrame / 1e6, 9);
    expect(floats[floats.length - 1]).toBeCloseTo((stopFrame - 1) / 1e6, 9);
    expect(fs.existsSync(`${e.file}.partial`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${e.file}.json`, "utf8")).frames).toBe(e.frames);
    expect(e.file).toContain(r.rec.sessionFolder());
  });

  it("reports late frames when the start was missed", () => {
    const r = rig();
    r.feed(10);
    const startNs = r.clock.ns - 50e6; // already 50 ms in the past
    r.rec.scheduleTake({ takeId: 2, sessionId: "1a2b3c4d", role: "producer", maxTakeSeconds: 60, startAtNs: startNs });
    r.feed(2);
    const started = r.rec.poll().find((e) => e.kind === "started")!;
    expect(started.lateFrames).toBeGreaterThan(0);
  });

  it("stops now when asked (Stop & save)", () => {
    const r = rig();
    r.feed(5);
    r.rec.scheduleTake({ takeId: 3, sessionId: "1a2b3c4d", role: "performer", maxTakeSeconds: 60, startAtNs: r.clock.ns + 50e6 });
    r.feed(10);
    r.rec.poll();
    r.rec.scheduleStop(0, false);
    r.feed(3);
    const e = r.rec.poll().find((x) => x.kind === "finalised")!;
    expect(e.finalised).toBe(true);
    expect(e.frames).toBeGreaterThan(0);
    expect(readSamples(e.file).info.ok).toBe(true);
  });

  it("a microphone that disappears mid-take is finalised as incomplete_device, with the audio so far kept", () => {
    const r = rig();
    r.feed(5);
    r.rec.scheduleTake({ takeId: 4, sessionId: "1a2b3c4d", role: "performer", maxTakeSeconds: 60, startAtNs: r.clock.ns + 30e6 });
    r.feed(20);
    r.rec.poll();
    r.rec.setCaptureState({ open: false, failed: "unplugged" });
    const e = r.rec.poll().find((x) => x.kind === "finalised")!;
    expect(e.status).toBe(TakeStatus.IncompleteDevice);
    expect(e.frames).toBeGreaterThan(0);
    expect(readSamples(e.file).info.ok).toBe(true);
  });

  it("cancelling before the start leaves no file", () => {
    const r = rig();
    r.feed(5);
    r.rec.scheduleTake({ takeId: 5, sessionId: "1a2b3c4d", role: "performer", maxTakeSeconds: 60, startAtNs: r.clock.ns + 1e9 });
    r.rec.cancelTake();
    const files = fs.readdirSync(r.rec.sessionFolder());
    expect(files).toEqual([]);
    expect(r.rec.readiness().checks.find((c) => c.item === 4)?.ok).toBe(true);
  });

  it("never overwrites an existing take file", () => {
    const r = rig();
    r.feed(5);
    const spec = { takeId: 6, sessionId: "1a2b3c4d", role: "performer" as const, maxTakeSeconds: 60, startAtNs: r.clock.ns + 20e6 };
    expect(r.rec.scheduleTake(spec)).toBe("");
    r.feed(10);
    r.rec.poll();
    r.rec.scheduleStop(0, false);
    r.feed(2);
    r.rec.poll();
    expect(r.rec.scheduleTake(spec)).toContain("already exists");
  });

  it("stops by itself at the safety limit", () => {
    const r = rig();
    r.feed(5);
    r.rec.scheduleTake({ takeId: 7, sessionId: "1a2b3c4d", role: "performer", maxTakeSeconds: 1, startAtNs: r.clock.ns + 20e6 });
    r.feed(150);
    const e = r.rec.poll().find((x) => x.kind === "finalised")!;
    expect(e.stopReason).toContain("safety");
    expect(e.frames).toBeGreaterThanOrEqual(RATE);
    expect(e.frames).toBeLessThan(RATE + BLOCK);
  });
});
