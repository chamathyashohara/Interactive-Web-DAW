import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { media } from "../src";
import { MediaEndpoint, type IncomingAudio } from "../src/node";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextPort = 52000 + Math.floor(Math.random() * 8000);
const open: MediaEndpoint[] = [];
afterEach(async () => {
  open.splice(0).forEach((e) => e.stop());
  await sleep(80);
});

async function until(cond: () => boolean, ms = 4000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const SESSION = 0x1a2b3c4d;

async function pair() {
  const port = (nextPort += 3);
  const producer = new MediaEndpoint({ bindMode: true, localAddress: "127.0.0.1", peerAddress: "127.0.0.1", mediaPort: port, sessionId: SESSION, outgoingStream: 1, incomingStream: 2, reportIntervalMs: 100 });
  const performer = new MediaEndpoint({ bindMode: false, localAddress: "", peerAddress: "127.0.0.1", mediaPort: port, sessionId: SESSION, outgoingStream: 2, incomingStream: 1, reportIntervalMs: 100 });
  open.push(producer, performer);
  expect(await producer.start()).toBe("");
  expect(await performer.start()).toBe("");
  producer.setControlLinkUp(true);
  performer.setControlLinkUp(true);
  return { port, producer, performer };
}

describe("MediaEndpoint", () => {
  it("carries audio both ways on one UDP flow and learns the performer's endpoint", async () => {
    const { producer, performer } = await pair();
    const atProducer: IncomingAudio[] = [];
    const atPerformer: IncomingAudio[] = [];
    producer.onAudio = (p) => atProducer.push(p);
    performer.onAudio = (p) => atPerformer.push(p);
    await until(() => producer.stats().peerKnown, 3000, "producer learns the performer");
    for (let i = 0; i < 5; i++) {
      expect(performer.sendAudio(new Uint8Array([i, 9, 9]), i * 480, false)).toBe(true);
      expect(producer.sendAudio(new Uint8Array([i, 7]), i * 480, i === 3)).toBe(true);
    }
    await until(() => atProducer.length === 5 && atPerformer.length === 5, 3000, "5 packets each way");
    expect(atProducer.map((p) => p.seq)).toEqual([0, 1, 2, 3, 4]);
    expect([...atProducer[2]!.payload]).toEqual([2, 9, 9]);
    expect(atPerformer.map((p) => p.muted)).toEqual([false, false, false, true, false]);
    expect(atPerformer[4]!.mediaIndex).toBe(4 * 480);
  });

  it("exchanges receiver reports about the stream each side sends", async () => {
    const { producer, performer } = await pair();
    performer.setIncomingReport({ received: 123, jbFill: 3, jbTarget: 3, jitterUs: 250 });
    await until(() => producer.stats().hasRemoteReport && producer.stats().remoteReport.received === 123, 3000, "report at the producer");
    expect(producer.stats().remoteReport.jitterUs).toBe(250);
    expect(producer.stats().remoteReport.flags & media.REPORT_FLAG_PLAYING).toBe(media.REPORT_FLAG_PLAYING);
  });

  it("drops duplicates, wrong sessions, wrong streams, corruption and strangers, each counted by reason", async () => {
    const { port, producer, performer } = await pair();
    const got: IncomingAudio[] = [];
    performer.onAudio = (p) => got.push(p);
    await until(() => producer.stats().peerKnown, 3000, "peer learned");
    const raw = dgram.createSocket("udp4");
    const mk = (over: Partial<Parameters<typeof media.writePacket>[0]> = {}, payload = new Uint8Array([1, 2, 3])) =>
      media.writePacket({ seq: 10, mediaIndex: 0, sessionId: SESSION, streamId: 1, type: media.PacketType.Audio, flags: media.CODEC_OPUS, ...over }, payload)!;
    const sendToProducer = (d: Uint8Array) => new Promise<void>((r) => raw.send(d, port, "127.0.0.1", () => r()));
    expect(producer.sendAudio(new Uint8Array([1]), 0, false)).toBe(true);
    await until(() => got.length === 1, 3000, "first packet");
    await sendToProducer(mk({ streamId: 2, seq: 1 })); // valid performer audio (stream 2) from 127.0.0.1
    await sendToProducer(mk({ streamId: 2, seq: 1 })); // duplicate
    await sendToProducer(mk({ streamId: 2, seq: 2, sessionId: 0x11111111 })); // wrong session
    await sendToProducer(mk({ streamId: 1, seq: 3 })); // wrong stream: the producer's own stream id
    const bad = mk({ streamId: 2, seq: 4 });
    bad[27] ^= 0xff; // corrupt the payload
    await sendToProducer(bad);
    await sendToProducer(new Uint8Array(5)); // too short
    await sleep(200);
    const s = producer.stats();
    expect(s.audioReceived).toBe(1);
    expect(s.invalid.bad_session).toBe(1);
    expect(s.invalid.wrong_stream).toBe(1);
    expect(s.invalid.bad_crc).toBe(1);
    expect(s.invalid.bad_length).toBe(1);
    raw.close();
  });

  it("ends a stream on purpose and tells the other side this direction is closing", async () => {
    const { producer, performer } = await pair();
    let ended = 0;
    performer.onEndOfStream = () => ended++;
    await until(() => producer.stats().peerKnown, 3000, "peer learned");
    producer.sendAudio(new Uint8Array([1]), 0, false);
    producer.setSending(false);
    await until(() => ended >= 1, 3000, "END_OF_STREAM");
    expect(producer.sendAudio(new Uint8Array([2]), 480, false)).toBe(false); // switched off
    performer.stop();
    await until(() => producer.stats().peerClosed, 3000, "closing report seen");
    expect(producer.stats().peerReachable).toBe(false);
  });

  it("stops sending when the control link is down and nothing has been heard", async () => {
    const port = (nextPort += 3);
    const e = new MediaEndpoint({ bindMode: false, localAddress: "", peerAddress: "127.0.0.1", mediaPort: port, sessionId: SESSION, outgoingStream: 2, incomingStream: 1 });
    open.push(e);
    expect(await e.start()).toBe("");
    expect(e.sendAudio(new Uint8Array([1]), 0, false)).toBe(false);
    e.setControlLinkUp(true);
    expect(e.sendAudio(new Uint8Array([1]), 0, false)).toBe(true);
  });
});
