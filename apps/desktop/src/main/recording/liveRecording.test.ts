import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wav } from "@daw/recording";
import { LiveRecordingService, listInterfaces, type LiveState } from "./liveRecording";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextPort = 33000 + Math.floor(Math.random() * 20000);

const services: LiveRecordingService[] = [];
const feeders: ReturnType<typeof setInterval>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  feeders.splice(0).forEach(clearInterval);
  await Promise.all(services.splice(0).map((s) => s.shutdown()));
  await sleep(100);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 10000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A service whose microphone is a generated tone, streamed in 10 ms blocks like the window does. */
function makeService(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rr-svc-${label}-`));
  dirs.push(root);
  const states: LiveState[] = [];
  const toRenderer: [string, unknown][] = [];
  const svc = new LiveRecordingService({
    recordingsRoot: path.join(root, "takes"),
    logFile: path.join(root, "log.jsonl"),
    appVersion: "test",
    onState: (s) => states.push(s),
    toRenderer: (c, p) => toRenderer.push([c, p]),
  });
  svc.start();
  services.push(svc);
  svc.captureState({ open: true, deviceName: `${label} mic`, sampleRate: 48000, channels: 1 });
  let frame = 0;
  const t0 = Date.now();
  feeders.push(
    setInterval(() => {
      // keep the frame counter locked to real time even if a timer tick is late
      const due = Math.floor(((Date.now() - t0) / 1000) * 48000 / 480) * 480;
      while (frame < due) {
        const s = new Float32Array(480);
        for (let i = 0; i < 480; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 440 * (frame + i)) / 48000);
        svc.capture(frame, s);
        frame += 480;
      }
    }, 5),
  );
  return { svc, root, states, toRenderer, last: () => svc.state() };
}

describe("LiveRecordingService", () => {
  it("lists a loopback address so a session can be tried on one PC", () => {
    expect(listInterfaces().some((i) => i.address === "127.0.0.1")).toBe(true);
    expect(listInterfaces().some((i) => i.address.startsWith("169.254."))).toBe(false);
  });

  it("runs a whole session: join, consent, take, stop, and a verified copy of the singer's take", async () => {
    const producer = makeService("producer");
    const singer = makeService("singer");
    const port = (nextPort += 5);

    expect((await producer.svc.createSession({ bind: "127.0.0.1", port, name: "Prod" })).ok).toBe(true);
    const code = producer.last().snapshot!.pairingCode;
    expect(code).toMatch(/^\d{6}$/);
    expect((await singer.svc.join({ host: "127.0.0.1", port, code, name: "Singer" })).ok).toBe(true);
    await until(() => producer.last().snapshot?.link === 4 && singer.last().snapshot?.link === 4, 8000, "connected");

    // nobody can record before consent
    expect(producer.svc.record()).toMatch(/not ready/);
    producer.svc.setConsent(true);
    singer.svc.setConsent(true);
    singer.svc.setDeliveryConsent(true);
    await until(() => producer.last().snapshot?.session === 1 && singer.last().snapshot?.session === 1, 12000, "both ready");

    // talkback: the live socket opens when the link is up, and Opus packets cross it (the encoder is in the window, so send a stand-in packet)
    producer.svc.setTalkback(true, true);
    singer.svc.setTalkback(true, true);
    await until(() => producer.last().media?.peerKnown === true && singer.last().media?.running === true, 8000, "media endpoints");
    singer.svc.liveSend(new Uint8Array([1, 2, 3, 4]), 0, false);
    await until(() => producer.toRenderer.some(([c]) => c === "live:audio"), 4000, "audio at the producer's window");
    const pkt = producer.toRenderer.find(([c]) => c === "live:audio")![1] as { payload: Uint8Array; seq: number };
    expect([...pkt.payload]).toEqual([1, 2, 3, 4]);

    expect(producer.svc.record()).toBe("");
    await until(() => producer.last().snapshot?.session === 4 && singer.last().snapshot?.session === 4, 10000, "recording");
    await sleep(1200);
    expect(producer.svc.stop()).toBe("");
    await until(() => producer.last().snapshot?.session === 1 && singer.last().snapshot?.take.localFinalised === true, 10000, "take finished");

    // both PCs wrote their own float WAV, sample-exact in length bookkeeping
    const mine = producer.last().takes.find((t) => t.kind === "mine")!;
    expect(mine.ready).toBe(true);
    const buf = fs.readFileSync(mine.file);
    const info = wav.inspectWav(new Uint8Array(buf.subarray(0, 4096)), buf.length);
    expect(info.ok).toBe(true);
    expect(info.frames / 48000).toBeGreaterThan(1.0);
    const snap = producer.last().snapshot!;
    expect(snap.take.hasStartOffset).toBe(true);
    expect(Math.abs(snap.take.startOffsetMs)).toBeLessThan(100);
    expect(snap.take.peerFinalised).toBe(true);

    // auto-transfer: the producer asks for a copy and verifies it
    await until(() => producer.last().takes.some((t) => t.kind === "singer-copy"), 15000, "verified copy of the singer's take");
    const copy = producer.last().takes.find((t) => t.kind === "singer-copy")!;
    const singersOriginal = singer.last().takes.find((t) => t.kind === "mine")!.file;
    expect(fs.readFileSync(copy.file).equals(fs.readFileSync(singersOriginal))).toBe(true);
    expect(copy.file).toContain("from_performer");
    expect(path.dirname(singersOriginal)).not.toBe(path.dirname(copy.file));
  }, 60000);

  it("refuses to record when the microphone is off", async () => {
    const producer = makeService("producer");
    const singer = makeService("singer");
    singer.svc.captureState({ open: false });
    const port = (nextPort += 5);
    await producer.svc.createSession({ bind: "127.0.0.1", port });
    const code = producer.last().snapshot!.pairingCode;
    await singer.svc.join({ host: "127.0.0.1", port, code });
    await until(() => producer.last().snapshot?.link === 4, 8000, "connected");
    producer.svc.setConsent(true);
    singer.svc.setConsent(true);
    await sleep(800);
    const err = producer.svc.record();
    expect(err).toMatch(/performer not ready/);
    expect(producer.last().snapshot!.peerReasons).toContain("microphone is not on");
  }, 30000);

  it("leaving ends the session for both and closes the talkback socket", async () => {
    const producer = makeService("producer");
    const singer = makeService("singer");
    const port = (nextPort += 5);
    await producer.svc.createSession({ bind: "127.0.0.1", port });
    await singer.svc.join({ host: "127.0.0.1", port, code: producer.last().snapshot!.pairingCode });
    await until(() => singer.last().snapshot?.link === 4, 8000, "connected");
    await singer.svc.leave();
    expect(singer.last().role).toBeNull();
    await until(() => producer.last().snapshot?.peerName === "" || producer.last().snapshot?.link !== 4, 8000, "producer notices");
  }, 30000);
});
