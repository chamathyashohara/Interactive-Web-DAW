import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LinkState, SessionState, TakeStatus, wav } from "../src";
import { MemoryLogger, SessionController, TestRecorderPort } from "../src/node";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextPort = 31000 + Math.floor(Math.random() * 20000);
const freePort = () => (nextPort += 5);

const open: SessionController[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.shutdown()));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rr-test-"));
  dirs.push(d);
  return d;
}

/** Writes a float32 mono WAV of `frames` frames and returns its path. */
function writeWav(file: string, frames: number) {
  const head = wav.buildWavHeader({ sampleRate: 48000, channels: 1 }, frames);
  const body = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) body.writeFloatLE(Math.sin(i / 20) * 0.5, i * 4);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(head), body]));
  return file;
}

interface Pair {
  producer: SessionController;
  performer: SessionController;
  pPort: TestRecorderPort;
  qPort: TestRecorderPort;
  port: number;
  log: MemoryLogger;
  root: string;
}

async function pair(over: { link?: object; performer?: object } = {}): Promise<Pair> {
  const root = tmp();
  const port = freePort();
  const log = new MemoryLogger();
  const pPort = new TestRecorderPort();
  const qPort = new TestRecorderPort();
  qPort.reportFile = (take, frames) => writeWav(path.join(root, `performer-take${take}.wav`), frames);
  const link = { heartbeatIntervalMs: 50, ...over.link };
  const producer = new SessionController({ role: "producer", appVersion: "t", displayName: "Producer", link, receivedRoot: path.join(root, "received") }, pPort, log);
  const performer = new SessionController({ role: "performer", appVersion: "t", displayName: "Singer", link, ...over.performer }, qPort, log);
  open.push(producer, performer);
  producer.startPolling(10);
  performer.startPolling(10);
  return { producer, performer, pPort, qPort, port, log, root };
}

async function until(cond: () => boolean, ms = 8000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function connect(p: Pair) {
  expect(await p.producer.createSession("127.0.0.1", p.port)).toBe("");
  const code = p.producer.snapshot().pairingCode;
  expect(code).toMatch(/^\d{6}$/);
  expect(await p.performer.join("127.0.0.1", p.port, code)).toBe("");
  await until(() => p.performer.snapshot().link === LinkState.Connected && p.producer.snapshot().link === LinkState.Connected, 5000, "both connected");
  p.producer.setConsent(true);
  p.performer.setConsent(true);
  await until(() => p.producer.snapshot().session === SessionState.Ready && p.performer.snapshot().session === SessionState.Ready, 8000, "both ready");
}

describe("session handshake", () => {
  it("joins with the pairing code, measures the clock offset and becomes ready", async () => {
    const p = await pair();
    await connect(p);
    const s = p.performer.snapshot();
    expect(s.sessionId).toBe(p.producer.snapshot().sessionId);
    expect(s.linkStats.offsetSamples).toBeGreaterThanOrEqual(3);
    expect(Math.abs(s.linkStats.thetaNs)).toBeLessThan(5_000_000); // same process, same clock
    expect(p.producer.snapshot().protocolMinor).toBe(3);
    expect(p.producer.snapshot().peerName).toBe("Singer");
  });

  it("refuses a wrong pairing code", async () => {
    const p = await pair();
    expect(await p.producer.createSession("127.0.0.1", p.port)).toBe("");
    const real = p.producer.snapshot().pairingCode;
    expect(await p.performer.join("127.0.0.1", p.port, real === "000000" ? "111111" : "000000")).toBe("");
    await until(() => p.performer.snapshot().lastError !== "", 5000, "a refusal");
    expect(p.performer.snapshot().lastError.toLowerCase()).toContain("wrong pairing code");
    expect(p.performer.snapshot().link).toBe(LinkState.Disconnected);
  });

  it("refuses an incompatible protocol major with both versions in the message", async () => {
    const p = await pair({ performer: { testProtocolMajor: 9 } });
    expect(await p.producer.createSession("127.0.0.1", p.port)).toBe("");
    await p.performer.join("127.0.0.1", p.port, p.producer.snapshot().pairingCode);
    await until(() => p.performer.snapshot().lastError !== "", 5000, "a refusal");
    expect(p.performer.snapshot().lastError).toMatch(/1\.3.*9\.3/);
  });

  it("refuses to listen on 0.0.0.0", async () => {
    const p = await pair();
    expect(await p.producer.createSession("0.0.0.0", p.port)).toContain("0.0.0.0");
  });
});

describe("a coordinated take", () => {
  it("records on both sides, stops, and both report finalised", async () => {
    const p = await pair();
    await connect(p);
    expect(p.producer.startTake()).toBe("");
    await until(() => p.producer.snapshot().session === SessionState.Recording && p.performer.snapshot().session === SessionState.Recording, 8000, "both recording");
    const t = p.producer.snapshot().take;
    expect(t.peerArmAck && t.peerStartAck && t.localStarted).toBe(true);
    await until(() => p.producer.snapshot().take.peerStarted, 3000, "performer confirmed start");
    await until(() => p.producer.snapshot().take.hasStartOffset, 3000, "start offset estimate");
    expect(Math.abs(p.producer.snapshot().take.startOffsetMs)).toBeLessThan(50);
    await sleep(300);
    expect(p.producer.stopTake()).toBe("");
    await until(() => p.producer.snapshot().session === SessionState.Ready && p.performer.snapshot().session === SessionState.Ready, 8000, "ready again");
    const done = p.producer.snapshot().take;
    expect(done.peerFinalised).toBe(true);
    expect(done.peerStatus).toBe(TakeStatus.Complete);
    expect(done.localFinalised).toBe(true);
    expect(done.peerStopAck).toBe(true);
    expect(p.log.find("take_timing").length).toBeGreaterThanOrEqual(2); // one per PC
    expect(done.startLeadMs).toBeGreaterThanOrEqual(300);
  });

  it("Stop before the start cancels on both PCs and records nothing", async () => {
    const p = await pair();
    await connect(p);
    p.producer.setAutoStartLead(false);
    p.producer.setStartLeadMs(3000);
    expect(p.producer.startTake()).toBe("");
    await until(() => p.producer.snapshot().session === SessionState.Scheduled, 5000, "scheduled");
    expect(p.producer.stopTake()).toBe("");
    await until(() => p.performer.snapshot().session === SessionState.Ready && p.producer.snapshot().session === SessionState.Ready, 5000, "back to ready");
    await sleep(100);
    expect(p.producer.snapshot().take.localStarted).toBe(false);
    expect(p.performer.snapshot().take.localStarted).toBe(false);
    expect(p.producer.snapshot().take.cancelled).toBe(true);
  });

  it("the performer's Stop & save ends its take and the producer is told", async () => {
    const p = await pair();
    await connect(p);
    p.producer.startTake();
    await until(() => p.performer.snapshot().session === SessionState.Recording, 8000, "performer recording");
    expect(p.performer.stopAndSave()).toBe("");
    await until(() => p.performer.snapshot().session === SessionState.Ready, 8000, "performer done");
    await until(() => p.producer.snapshot().take.peerFinalised, 3000, "producer told");
  });

  it("Record is refused until both sides consented and are ready", async () => {
    const p = await pair();
    expect(await p.producer.createSession("127.0.0.1", p.port)).toBe("");
    await p.performer.join("127.0.0.1", p.port, p.producer.snapshot().pairingCode);
    await until(() => p.producer.snapshot().link === LinkState.Connected, 5000, "connected");
    p.producer.setConsent(true);
    await sleep(200);
    expect(p.producer.startTake()).toMatch(/not ready.*performer has not consented/);
    p.performer.setConsent(true);
    await until(() => p.producer.snapshot().session === SessionState.Ready, 8000, "ready");
  });

  it("a device fault on the performer's side finalises its take as incomplete_device", async () => {
    const p = await pair();
    await connect(p);
    p.producer.startTake();
    await until(() => p.performer.snapshot().session === SessionState.Recording, 8000, "recording");
    p.qPort.simulateFault();
    await until(() => p.producer.snapshot().take.peerFinalised, 8000, "performer report");
    expect(p.producer.snapshot().take.peerStatus).toBe(TakeStatus.IncompleteDevice);
  });
});

describe("take transfer", () => {
  it("copies the performer's original to the producer and verifies it", async () => {
    const p = await pair();
    await connect(p);
    p.performer.setDeliveryConsent(true);
    p.producer.startTake();
    await until(() => p.performer.snapshot().session === SessionState.Recording, 8000, "recording");
    await sleep(400);
    p.producer.stopTake();
    await until(() => p.producer.snapshot().take.peerFinalised && p.producer.snapshot().session === SessionState.Ready, 8000, "take finished");
    await until(() => p.producer.snapshot().peerDeliveryConsent, 3000, "delivery consent seen");
    expect(await p.producer.requestTransfer(1)).toBe("");
    await until(() => p.producer.snapshot().transfers.some((t) => t.state === "verified"), 10000, "verified");
    const view = p.producer.snapshot().transfers[0]!;
    const original = path.join(p.root, "performer-take1.wav");
    expect(fs.readFileSync(view.file).equals(fs.readFileSync(original))).toBe(true);
    expect(view.frames).toBe(p.producer.snapshot().take.peerFrames);
    expect(view.framesVsReport).toBe("match");
    await until(() => p.performer.snapshot().transfers.some((t) => t.state === "verified"), 5000, "performer sees VERIFIED");
    expect(p.performer.snapshot().transfers[0]!.sourceUnchanged).toBe(true);
  });

  it("is refused without the performer's delivery consent", async () => {
    const p = await pair();
    await connect(p);
    p.producer.startTake();
    await until(() => p.performer.snapshot().session === SessionState.Recording, 8000, "recording");
    p.producer.stopTake();
    await until(() => p.producer.snapshot().take.peerFinalised && p.producer.snapshot().session === SessionState.Ready, 8000, "take finished");
    expect(await p.producer.requestTransfer(1)).toBe("");
    await until(() => p.producer.snapshot().transfers.some((t) => t.state === "failed"), 5000, "refused");
    expect(p.producer.snapshot().transfers[0]!.detail).toContain("refused");
  });
});

describe("a lost link", () => {
  it("is detected, and the performer reconnects with its resume token", async () => {
    const p = await pair();
    await connect(p);
    p.performer.linkInstance!.testDropConnection();
    await until(() => p.performer.snapshot().link === LinkState.LinkLost || p.producer.snapshot().link === LinkState.LinkLost, 5000, "link lost");
    await until(() => p.performer.snapshot().link === LinkState.Connected && p.producer.snapshot().link === LinkState.Connected, 10000, "reconnected");
    expect(p.producer.snapshot().linkStats.connections).toBe(2);
  });
});
