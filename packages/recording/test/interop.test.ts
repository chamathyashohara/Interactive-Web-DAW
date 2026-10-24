/**
 * Interoperability with the original C++ recorder: the TypeScript session talks to rr_session_probe.exe (the C++ library driven from the
 * command line). Skipped unless RR_PROBE points at that executable, e.g.
 *   RR_PROBE="D:/DAW RESEARCH/PP1-TEST/build/msvc-x64/bin/Release/rr_session_probe.exe" npx vitest run interop
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LinkState, SessionState, TakeStatus } from "../src";
import { media } from "../src";
import { MediaEndpoint, MemoryLogger, SessionController, TestRecorderPort, type IncomingAudio } from "../src/node";

const PROBE = process.env.RR_PROBE ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const procs: ChildProcess[] = [];
const ctrls: SessionController[] = [];
const dirs: string[] = [];
let nextPort = 41000 + Math.floor(Math.random() * 15000);

afterEach(async () => {
  for (const p of procs.splice(0)) p.kill();
  await Promise.all(ctrls.splice(0).map((c) => c.shutdown()));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function probe(args: string[]) {
  const out: string[] = [];
  const p = spawn(PROBE, args, { stdio: ["ignore", "pipe", "pipe"] });
  p.stdout!.on("data", (d) => out.push(String(d)));
  p.stderr!.on("data", (d) => out.push(String(d)));
  procs.push(p);
  return { p, text: () => out.join("") };
}

describe.skipIf(!PROBE)("interop with the C++ recorder", () => {
  it("TypeScript producer + C++ performer: join, ready, one coordinated take", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-interop-"));
    dirs.push(dir);
    const port = (nextPort += 4);
    const log = new MemoryLogger();
    const producer = new SessionController({ role: "producer", appVersion: "ts", displayName: "TS producer" }, new TestRecorderPort(), log);
    ctrls.push(producer);
    producer.startPolling(10);
    expect(await producer.createSession("127.0.0.1", port)).toBe("");
    const code = producer.snapshot().pairingCode;
    const c = probe(["--performer", "--host", "127.0.0.1", "--port", String(port), "--code", code, "--out", dir, "--script", "wait-ready 30; wait-closed"]);
    await until(() => producer.snapshot().link === LinkState.Connected, 8000, "C++ performer joined\n" + c.text());
    expect(producer.snapshot().peerName.length).toBeGreaterThan(0);
    producer.setConsent(true);
    await until(() => producer.snapshot().session === SessionState.Ready, 15000, "producer ready\n" + c.text());
    expect(producer.snapshot().protocolMinor).toBe(2);
    expect(producer.startTake()).toBe("");
    await until(() => producer.snapshot().session === SessionState.Recording, 8000, "recording\n" + c.text());
    await until(() => producer.snapshot().take.peerStarted, 5000, "C++ performer confirmed start\n" + c.text());
    await sleep(800);
    expect(producer.stopTake()).toBe("");
    await until(() => producer.snapshot().take.peerFinalised, 10000, "C++ performer report\n" + c.text());
    expect(producer.snapshot().take.peerStatus).toBe(TakeStatus.Complete);
    expect(producer.snapshot().take.peerFrames).toBeGreaterThan(0);
  }, 60000);

  it("C++ producer + TypeScript performer: join with the pairing code, ready, take", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-interop-"));
    dirs.push(dir);
    const port = (nextPort += 4);
    const codeFile = path.join(dir, "code.txt");
    const c = probe(["--producer", "--bind", "127.0.0.1", "--port", String(port), "--code-file", codeFile, "--out", dir, "--script", "wait-ready 30; record; wait 1.5; stop; wait-state Ready 15; wait 1; quit"]);
    await until(() => fs.existsSync(codeFile) && fs.readFileSync(codeFile, "utf8").trim().length === 6, 8000, "C++ producer started\n" + c.text());
    const code = fs.readFileSync(codeFile, "utf8").trim();
    const port2 = new TestRecorderPort();
    const performer = new SessionController({ role: "performer", appVersion: "ts", displayName: "TS singer" }, port2, new MemoryLogger());
    ctrls.push(performer);
    performer.startPolling(10);
    expect(await performer.join("127.0.0.1", port, code)).toBe("");
    performer.setConsent(true);
    await until(() => performer.snapshot().session === SessionState.Ready, 15000, "performer ready\n" + c.text());
    await until(() => performer.snapshot().session === SessionState.Recording, 15000, "performer recording\n" + c.text());
    await until(() => performer.snapshot().take.localFinalised, 15000, "performer take finalised\n" + c.text());
    expect(performer.snapshot().take.localStatus).toBe(TakeStatus.Complete);
    await until(() => c.p.exitCode !== null, 20000, "C++ producer script end\n" + c.text());
    expect(c.p.exitCode).toBe(0);
  }, 90000);

  it("live media: the C++ performer's Opus stream is accepted, and a replayed stream is accepted by it (header, CRC, reports)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-interop-"));
    dirs.push(dir);
    const port = (nextPort += 4);
    const producer = new SessionController({ role: "producer", appVersion: "ts", displayName: "TS producer" }, new TestRecorderPort(), new MemoryLogger());
    ctrls.push(producer);
    producer.startPolling(10);
    expect(await producer.createSession("127.0.0.1", port)).toBe("");
    const c = probe(["--performer", "--host", "127.0.0.1", "--port", String(port), "--code", producer.snapshot().pairingCode, "--out", dir, "--live", "--live-source", "tone", "--live-sink", "null", "--script", "hear on; wait 12; quit"]);
    await until(() => producer.snapshot().link === LinkState.Connected, 8000, "C++ performer joined\n" + c.text());
    const sid = media.sessionIdToU32(producer.snapshot().sessionId)!;
    const ep = new MediaEndpoint({ bindMode: true, localAddress: "127.0.0.1", peerAddress: "127.0.0.1", mediaPort: port + 1, sessionId: sid, outgoingStream: 1, incomingStream: 2 });
    expect(await ep.start()).toBe("");
    ep.setControlLinkUp(true);
    const got: IncomingAudio[] = [];
    ep.onAudio = (p) => got.push(p);
    try {
      await until(() => got.length >= 40, 10000, "40 Opus packets from the C++ performer\n" + c.text());
      expect(ep.stats().invalidTotal).toBe(0);
      expect(got[0]!.payload.length).toBeGreaterThan(0);
      // replay what we received as our own stream 1 (they are real Opus frames)
      const mine = got.slice(0, 60);
      for (const p of mine) {
        ep.sendAudio(p.payload, p.mediaIndex, false);
        await sleep(10);
      }
      await until(() => ep.stats().hasRemoteReport && ep.stats().remoteReport.received >= 30, 8000, "the C++ performer's report about our stream\n" + c.text());
      const r = ep.stats().remoteReport;
      expect(r.decodeErrors).toBe(0);
      expect(r.invalidPackets).toBe(0);
      expect(r.flags & media.REPORT_FLAG_PLAYING).toBe(media.REPORT_FLAG_PLAYING);
    } finally {
      ep.stop();
    }
  }, 60000);
});
