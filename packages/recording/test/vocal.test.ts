/**
 * Vocal over a backing track, end to end at the protocol level, with the singer "in another place": every byte between the two PCs goes through
 * a proxy that delays and jitters it (like a real internet or Wi-Fi path). The singer's ears and microphone are simulated: the microphone hears the
 * backing track late by a known speaker-to-microphone latency L, exactly like a real sound card would. The check is the one that matters to a producer:
 * after the take, is the vocal back on the music it answers?
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LinkState, SessionState, TakeStatus } from "../src";
import {
  BackingServer, CaptureRecorderPort, MemoryLogger, SessionController, VocalProducerPort, downloadBacking, sha256OfFile, type PortTakeSpec,
} from "../src/node";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextPort = 30000 + Math.floor(Math.random() * 20000);
const RATE = 48000;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(cond: () => boolean, ms = 15000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A TCP proxy that delays every chunk by delayMs +/- jitterMs (never reordering), in both directions. */
function delayProxy(listenHost: string, port: number, targetHost: string, delayMs: number, jitterMs: number) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(port, targetHost);
    sockets.add(client);
    sockets.add(upstream);
    const pipe = (from: net.Socket, to: net.Socket) => {
      // a strict FIFO: nothing can overtake anything else, whatever the individual delays
      const queue: { at: number; data?: Buffer; end?: boolean }[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      let last = 0;
      const drain = () => {
        timer = null;
        while (queue.length && queue[0]!.at <= Date.now()) {
          const q = queue.shift()!;
          if (q.end) to.end();
          else if (!to.destroyed && q.data) to.write(q.data);
        }
        if (queue.length) timer = setTimeout(drain, Math.max(1, queue[0]!.at - Date.now()));
      };
      from.on("data", (d: Buffer) => {
        last = Math.max(last, Date.now() + delayMs + (Math.random() * 2 - 1) * jitterMs);
        queue.push({ at: last, data: d });
        if (!timer) timer = setTimeout(drain, Math.max(1, queue[0]!.at - Date.now()));
      });
      from.on("end", () => {
        queue.push({ at: Math.max(last, Date.now() + delayMs), end: true }); // the close travels in the queue and cannot overtake data
        if (!timer) timer = setTimeout(drain, Math.max(1, queue[0]!.at - Date.now()));
      });
      from.on("error", () => to.destroy());
    };
    pipe(client, upstream);
    pipe(upstream, client);
    // when one side closes, the other is closed only after what is still "in flight" has been delivered
    client.on("close", () => setTimeout(() => upstream.destroy(), delayMs + jitterMs + 300));
    upstream.on("close", () => setTimeout(() => client.destroy(), delayMs + jitterMs + 300));
  });
  return new Promise<{ close(): void }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, listenHost, () => resolve({ close: () => { server.close(); sockets.forEach((s) => s.destroy()); } }));
  });
}

function writeBackingWav(file: string, seconds: number): void {
  // 16-bit stereo 48 kHz; the content is irrelevant to delivery (the alignment test uses its own click model)
  const frames = Math.round(seconds * RATE);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin(i / 30) * 8000);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

interface Rig {
  producer: SessionController;
  singer: SessionController;
  server: BackingServer;
  port: number;
  root: string;
  singerPort: CaptureRecorderPort;
  /** what the singer's machine did with the backing track */
  plays: { startLocalNs: number; offsetUs: number }[];
  stops: number;
  vocalSchedules: { takeId: number; startFrame: number; offsetUs: number }[];
  producerEvents: { kind: "start" | "end"; spec: PortTakeSpec; atNs: number }[];
  have: { id: string };
  backingFile: string;
  latencyFrames: number;
  setLatency(frames: number): void;
}

/** The singer's simulated ears and microphone: the click track, heard `latencyFrames` late. Frames before the start are silent. */
const CLICK_EVERY = 24000;
const clickAt = (n: number): boolean => n >= 0 && n % CLICK_EVERY === 0;

async function rig(opts: { delayMs: number; jitterMs: number; latencyFrames: number }): Promise<Rig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rr-vocal-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const port = (nextPort += 6);
  const log = new MemoryLogger();
  const link = { heartbeatIntervalMs: 50 };
  const producerEvents: Rig["producerEvents"] = [];
  const producerPort = new VocalProducerPort({
    engineReady: () => true,
    onStart: (spec) => producerEvents.push({ kind: "start", spec, atNs: performance.now() * 1e6 }),
    onEnd: (spec) => producerEvents.push({ kind: "end", spec, atNs: performance.now() * 1e6 }),
  });
  const producer = new SessionController({ role: "producer", appVersion: "t", displayName: "Producer", link, receivedRoot: path.join(root, "received") }, producerPort, log);
  producer.setMode("vocal");

  const singerPort = new CaptureRecorderPort({ recordingsRoot: path.join(root, "singer-takes") });
  singerPort.setCaptureState({ open: true, deviceName: "sim mic", sampleRate: RATE, channels: 1 });
  const have = { id: "" };
  const plays: Rig["plays"] = [];
  const vocalSchedules: Rig["vocalSchedules"] = [];
  const state = { stops: 0, latency: opts.latencyFrames };
  singerPort.setLatencyUs((opts.latencyFrames / RATE) * 1e6);
  let play: { startFrame: number; offsetFrames: number } | null = null;
  singerPort.onVocalSchedule = (o) => {
    vocalSchedules.push({ takeId: o.takeId, startFrame: o.startFrame, offsetUs: o.offsetUs });
    play = { startFrame: o.startFrame, offsetFrames: Math.round((o.offsetUs / 1e6) * RATE) };
  };
  singerPort.onVocalEnd = () => { play = null; };
  const singer = new SessionController(
    {
      role: "performer", appVersion: "t", displayName: "Singer", link,
      hooks: {
        backingHave: () => have.id,
        onBackingOffer: (o) => {
          void downloadBacking({ host: o.host, port: o.port, token: o.token, id: o.id, bytes: o.bytes, dest: path.join(root, "singer-backing.wav") }).then((err) => {
            if (!err) have.id = o.id;
          });
        },
        onPlayBacking: (startLocalNs, offsetUs) => { plays.push({ startLocalNs, offsetUs }); return ""; },
        onStopBacking: () => { state.stops++; },
      },
    },
    singerPort,
    log,
  );

  // the singer's microphone: real-time blocks, containing the backing track heard `latency` frames late
  let frame = 0;
  const t0 = Date.now();
  const feeder = setInterval(() => {
    const due = Math.floor((((Date.now() - t0) / 1000) * RATE) / 480) * 480;
    while (frame < due) {
      const s = new Float32Array(480);
      if (play) {
        for (let i = 0; i < 480; i++) {
          const backingIndex = play.offsetFrames + (frame + i - play.startFrame - state.latency);
          if (frame + i >= play.startFrame && clickAt(backingIndex)) s[i] = 1;
        }
      }
      singerPort.onCapture(frame, s);
      frame += 480;
    }
  }, 5);
  cleanups.push(() => clearInterval(feeder));

  producer.startPolling(10);
  singer.startPolling(10);
  cleanups.push(async () => { await singer.shutdown(); await producer.shutdown(); });
  expect(await producer.createSession("127.0.0.1", port)).toBe("");
  const server = new BackingServer("127.0.0.1", port + 3);
  expect(await server.start()).toBe("");
  cleanups.push(() => server.stop());
  // "another place": the singer reaches the producer only through the delaying proxy on 127.0.0.2
  const proxies = [await delayProxy("127.0.0.2", port, "127.0.0.1", opts.delayMs, opts.jitterMs), await delayProxy("127.0.0.2", port + 3, "127.0.0.1", opts.delayMs, opts.jitterMs)];
  cleanups.push(() => proxies.forEach((p) => p.close()));
  expect(await singer.join("127.0.0.2", port, producer.snapshot().pairingCode)).toBe("");
  await until(() => producer.snapshot().link === LinkState.Connected && singer.snapshot().link === LinkState.Connected, 8000, "connected");
  server.setAllowedPeer(producer.snapshot().peerAddress);
  producer.setConsent(true);
  singer.setConsent(true);

  const backingFile = path.join(root, "backing.wav");
  writeBackingWav(backingFile, 12);
  const id = await sha256OfFile(backingFile);
  const pub = server.publish(backingFile, id, fs.statSync(backingFile).size);
  producer.offerBacking({ id, port: port + 3, token: pub.token, bytes: pub.bytes });
  return {
    producer, singer, server, port, root, singerPort, plays, stops: 0, vocalSchedules, producerEvents, have, backingFile, latencyFrames: opts.latencyFrames,
    setLatency: (n) => { state.latency = n; singerPort.setLatencyUs((n / RATE) * 1e6); },
  } as Rig;
}

describe("vocal over a backing track, with the singer behind a slow, jittery link", () => {
  it("delivers the backing track, verified, then both sides become Ready only once the singer has it", async () => {
    const r = await rig({ delayMs: 40, jitterMs: 15, latencyFrames: 2400 });
    expect(r.producer.startTake()).toMatch(/not ready|does not have/); // not before the singer has it
    try {
      await until(() => r.have.id !== "", 15000, "the singer has the backing track");
    } catch (e) {
      console.log(r.singer.takeHistory().join(" | "), " ---- ", r.producer.takeHistory().join(" | "), r.server.served, r.server.refused);
      throw e;
    }
    expect(r.have.id).toBe(await sha256OfFile(r.backingFile));
    expect(fs.readFileSync(path.join(r.root, "singer-backing.wav")).equals(fs.readFileSync(r.backingFile))).toBe(true);
    await until(() => r.producer.snapshot().session === SessionState.Ready && r.singer.snapshot().session === SessionState.Ready, 15000, "both ready");
    expect(r.producer.snapshot().backing.haveId).toBe(r.have.id);
    expect(r.singer.snapshot().localChecks.some((c) => c.item === 8 && c.ok)).toBe(true);
    expect(r.server.served).toBeGreaterThan(0);
  }, 40000);

  it("a take plays the backing from the chosen position and the recorded vocal lands back on the music, to the sample", async () => {
    const latency = 2203; // 45.9 ms: a typical output + input latency of a consumer sound card
    const r = await rig({ delayMs: 40, jitterMs: 15, latencyFrames: latency });
    await until(() => r.producer.snapshot().session === SessionState.Ready && r.singer.snapshot().session === SessionState.Ready, 20000, "both ready");
    const offsetUs = 2_750_000; // the producer parked the playhead 2.75 s into the song
    expect(r.producer.startTake({ offsetUs })).toBe("");
    await until(() => r.singer.snapshot().session === SessionState.Recording && r.producer.snapshot().session === SessionState.Recording, 15000, "both recording");
    expect(r.vocalSchedules).toHaveLength(1);
    expect(r.vocalSchedules[0]!.offsetUs).toBe(offsetUs);
    await sleep(2600);
    expect(r.producer.stopTake()).toBe("");
    await until(() => r.producer.snapshot().take.peerFinalised && r.producer.snapshot().session === SessionState.Ready, 15000, "take finished");

    // the producer played the arrangement during the take and stopped it
    expect(r.producerEvents.map((e) => e.kind)).toEqual(["start", "end"]);
    expect(r.producerEvents[0]!.spec.vocal?.offsetUs).toBe(offsetUs);

    // the producer knows the singer's latency and what it recorded
    const t = r.producer.snapshot().take;
    expect(t.vocal).toBe(true);
    expect(t.peerLatencyUs).toBe(Math.round((latency / RATE) * 1e6));
    expect(t.peerStatus).toBe(TakeStatus.Complete);
    expect(t.peerFrames).toBeGreaterThan(RATE * 2.5);
    expect(r.singer.snapshot().take.localStatus).toBe(TakeStatus.Complete);

    // the singer's file: find the clicks (they are the vocal "answering" the music)
    const file = r.singer.snapshot().take.localFile;
    const buf = fs.readFileSync(file);
    const samples = new Float32Array(new Uint8Array(buf.subarray(58)).buffer);
    const lateFrames = r.singer.snapshot().take.localLateFrames;
    const clicks: number[] = [];
    for (let i = 0; i < samples.length; i++) if (samples[i]! > 0.5) clicks.push(i);
    expect(clicks.length).toBeGreaterThanOrEqual(5);
    // Backing time of a click = k * 0.5 s. The first click after the start position (2.75 s) is at 3.0 s = 0.25 s into the take.
    // It is heard `latency` late, so it sits at 0.25 s + latency in the file (plus any frames the recording began late).
    const offsetFrames = Math.round((offsetUs / 1e6) * RATE);
    const firstBackingClick = Math.ceil(offsetFrames / CLICK_EVERY) * CLICK_EVERY;
    expect(clicks[0]).toBe(firstBackingClick - offsetFrames + latency - lateFrames);
    // spacing is exact: the take is a continuous, gap-free recording
    for (let i = 1; i < clicks.length; i++) expect(clicks[i]! - clicks[i - 1]!).toBe(CLICK_EVERY);

    // and the placement the producer's DAW will use puts every click back on the backing track's click
    const { planVocalClip, ticksToSeconds } = await import("@daw/shared");
    const tempo = 120;
    const startTick = Math.round((offsetUs / 1e6) * (tempo / 60) * 960);
    const plan = planVocalClip({ startTick, tempo, durationSec: samples.length / RATE, latencySec: t.peerLatencyUs / 1e6, lateSec: t.peerLateFrames / RATE });
    for (const c of clicks) {
      const timeline = ticksToSeconds(plan.startTick, tempo) + (c / RATE - plan.trimSec);
      const backingTime = Math.round(((c - latency + lateFrames) / RATE + offsetUs / 1e6) * RATE) / RATE; // where the backing click really was
      expect(Math.abs(timeline - backingTime)).toBeLessThan(1 / RATE + 2e-4); // within one sample (plus the tick grid: 1 ms/tick at 120 bpm is 0.5 ms)
    }
  }, 60000);

  it("a second take does not touch the first, and keeps its own file and latency", async () => {
    const r = await rig({ delayMs: 25, jitterMs: 10, latencyFrames: 1200 });
    await until(() => r.producer.snapshot().session === SessionState.Ready && r.singer.snapshot().session === SessionState.Ready, 20000, "ready");
    const files: string[] = [];
    for (const latency of [1200, 3000]) {
      r.setLatency(latency);
      expect(r.producer.startTake({ offsetUs: 1_000_000 })).toBe("");
      await until(() => r.singer.snapshot().session === SessionState.Recording, 15000, "recording");
      await sleep(900);
      r.producer.stopTake();
      await until(() => r.producer.snapshot().take.peerFinalised && r.producer.snapshot().session === SessionState.Ready, 15000, "done");
      files.push(r.singer.snapshot().take.localFile);
      expect(r.producer.snapshot().take.peerLatencyUs).toBe(Math.round((latency / RATE) * 1e6));
    }
    expect(files[0]).not.toBe(files[1]);
    expect(fs.existsSync(files[0]!) && fs.existsSync(files[1]!)).toBe(true);
    expect(r.producer.snapshot().take.takeId).toBe(2);
  }, 60000);

  it("Play: the singer hears the backing at the producer's start time, and Stop stops it", async () => {
    const r = await rig({ delayMs: 40, jitterMs: 15, latencyFrames: 1000 });
    await until(() => r.producer.snapshot().session === SessionState.Ready, 20000, "ready");
    const res = r.producer.playBacking(4_000_000);
    expect(res.error).toBe("");
    await until(() => r.plays.length === 1, 5000, "the singer was told to play");
    expect(r.plays[0]!.offsetUs).toBe(4_000_000);
    // singer start (converted to its own clock) equals the producer's start: same process clock here, so they must agree closely
    expect(Math.abs(r.plays[0]!.startLocalNs - res.startAtNs)).toBeLessThan(40e6);
    await until(() => r.producer.singerIsHearing, 5000, "the producer knows the singer is hearing it");
    r.producer.stopBacking();
    await until(() => r.singer.snapshot().backing.playing === false && !r.producer.singerIsHearing, 5000, "stopped");
  }, 60000);

  it("refuses to play or record when the backing track is not there, with a plain reason", async () => {
    const r = await rig({ delayMs: 10, jitterMs: 0, latencyFrames: 0 });
    // before the download completes (or if it never does) the producer must not let a take start
    const early = r.producer.playBacking(0);
    expect(early.error).toMatch(/does not have|not connected/);
    await until(() => r.have.id !== "", 15000, "downloaded");
    r.producer.withdrawBacking();
    await sleep(100);
    expect(r.producer.startTake()).toMatch(/does not have|not ready|being prepared/);
  }, 40000);
});
