import { describe, expect, it } from "vitest";
import { ClockOffsetEstimator, Frame, FrameDecoder, MsgType, Tag, encodeFrame, crc32, media, xfer, wav, JitterBuffer } from "../src";

function roundTrip(f: Frame) {
  const d = new FrameDecoder();
  d.feed(encodeFrame(f));
  return d.next();
}

describe("control framing", () => {
  it("round-trips a frame and its typed fields", () => {
    const f = new Frame(MsgType.ScheduleStart);
    f.msgId = 7;
    f.setI64(Tag.SentNs, 123456789).setU32(Tag.TakeId, 4).setI64(Tag.StartAtNs, -5_000_000).setStr(Tag.SessionId, "1a2b3c4d");
    const r = roundTrip(f);
    expect(r.kind).toBe("frame");
    if (r.kind !== "frame") return;
    expect(r.frame.msgId).toBe(7);
    expect(r.frame.u32(Tag.TakeId)).toBe(4);
    expect(r.frame.i64(Tag.StartAtNs)).toBe(-5_000_000);
    expect(r.frame.str(Tag.SessionId)).toBe("1a2b3c4d");
  });

  it("matches the C++ layout byte for byte", () => {
    const f = new Frame(MsgType.Heartbeat);
    f.msgId = 1;
    f.setI64(Tag.SentNs, 0x0102030405060708n);
    const b = encodeFrame(f);
    // length(4) type(2) reserved(2) msg_id(4) ref_id(4) | tag(2) len(2) value(8)
    expect([...b]).toEqual([0, 0, 0, 24, 0, 0x10, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 8, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("reassembles frames split across reads and rejects bad input", () => {
    const a = new Frame(MsgType.Heartbeat).setI64(Tag.SentNs, 1);
    a.msgId = 1;
    const bytes = encodeFrame(a);
    const d = new FrameDecoder();
    d.feed(bytes.subarray(0, 5));
    expect(d.next().kind).toBe("need-more");
    d.feed(bytes.subarray(5));
    expect(d.next().kind).toBe("frame");

    const missing = new Frame(MsgType.Arm).setI64(Tag.SentNs, 1).setU32(Tag.TakeId, 1); // no MaxTakeSeconds
    expect(roundTrip(missing).kind).toBe("error");
    const huge = new Uint8Array([0, 0xff, 0xff, 0xff, 0, 0x10, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    const d2 = new FrameDecoder();
    d2.feed(huge);
    expect(d2.next().kind).toBe("error");
  });

  it("ignores unknown tags", () => {
    const f = new Frame(MsgType.Heartbeat).setI64(Tag.SentNs, 1);
    f.fields.set(999, new Uint8Array([1, 2, 3]));
    const r = roundTrip(f);
    expect(r.kind).toBe("frame");
  });
});

describe("clock offset", () => {
  it("uses the smallest-delay sample and reports delta/2 as the uncertainty", () => {
    const e = new ClockOffsetEstimator();
    // responder clock is 1000 ns ahead; one slow sample and one fast sample
    e.addSample(0, 1500, 1600, 2000); // delta 1900
    e.addSample(10_000, 11_050, 11_060, 10_100 + 10); // fast path: delta = (10110-10000)-(10)=100
    expect(e.bestDeltaNs).toBe(100);
    expect(e.uncertaintyNs).toBe(50);
    expect(e.sampleCount).toBe(2);
  });
  it("rejects absurd round trips (Stage 12 ceiling is 1 s)", () => {
    const e = new ClockOffsetEstimator();
    expect(e.addSample(0, 0, 0, 2_000_000_000)).toBe(false);
    expect(e.addSample(0, 0, 0, 900_000_000)).toBe(true);
  });
});

describe("media packet", () => {
  it("round-trips an audio packet and validates in the documented order", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const d = media.writePacket({ seq: 5, mediaIndex: 480, sessionId: 0x1a2b3c4d, streamId: 1, type: media.PacketType.Audio, flags: media.CODEC_OPUS }, payload)!;
    const ok = media.parsePacket(d, 0x1a2b3c4d);
    expect(ok.check).toBe("ok");
    expect(media.parsePacket(d, 0x11111111).check).toBe("bad_session");
    const corrupt = d.slice();
    corrupt[28] ^= 1;
    expect(media.parsePacket(corrupt, 0x1a2b3c4d).check).toBe("bad_crc");
    expect(media.parsePacket(d.subarray(0, 10), 0x1a2b3c4d).check).toBe("bad_length");
    const muted = media.writePacket({ seq: 6, mediaIndex: 960, sessionId: 0x1a2b3c4d, streamId: 2, type: media.PacketType.Audio, flags: media.CODEC_OPUS | media.FLAG_MUTED }, payload)!;
    expect(media.parsePacket(muted, 0x1a2b3c4d).check).toBe("ok");
    const reserved = media.writePacket({ seq: 7, mediaIndex: 0, sessionId: 0x1a2b3c4d, streamId: 1, type: media.PacketType.Audio, flags: media.CODEC_OPUS | 0x10 }, payload)!;
    expect(media.parsePacket(reserved, 0x1a2b3c4d).check).toBe("bad_payload");
  });
  it("crc32 matches the IEEE check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("round-trips a receiver report", () => {
    const r = { ...media.emptyReport(), received: 1234567890123, late: 4, jbFill: 3, flags: media.REPORT_FLAG_PLAYING };
    expect(media.readReport(media.writeReport(r))).toEqual(r);
  });
});

describe("transfer protocol", () => {
  it("round-trips OFFER and CHUNK", () => {
    const offer = xfer.xmsg(xfer.XType.Offer, { takeId: 3, fileBytes: 1000, chunkBytes: 1024, chunkCount: 1, fileSha: new Uint8Array(32).fill(7), sampleRate: 48000, channels: 1, bits: 32, formatTag: 3, frames: 235, name: "take03.wav" });
    const d = new xfer.XDecoder();
    d.feed(xfer.encodeX(offer));
    const r = d.next();
    expect(r.kind).toBe("message");
    if (r.kind === "message") expect(r.message).toMatchObject({ takeId: 3, fileBytes: 1000, frames: 235, name: "take03.wav", sampleRate: 48000 });
    const chunk = xfer.xmsg(xfer.XType.Chunk, { index: 2, data: new Uint8Array(10).fill(9), chunkSha: new Uint8Array(32).fill(1) });
    d.feed(xfer.encodeX(chunk));
    const c = d.next();
    expect(c.kind === "message" && c.message.data.length).toBe(10);
  });
});

describe("wav", () => {
  it("builds the 58-byte float header the C++ recorder writes and inspects it", () => {
    const frames = 100;
    const head = wav.buildWavHeader({ sampleRate: 48000, channels: 1 }, frames);
    expect(head.length).toBe(58);
    const file = new Uint8Array(58 + frames * 4);
    file.set(head);
    const info = wav.inspectWav(file, file.length);
    expect(info.ok).toBe(true);
    expect(info.frames).toBe(frames);
    expect(info.sampleRate).toBe(48000);
    expect(wav.inspectWav(file.subarray(0, 100), file.length - 4).ok).toBe(false);
  });
});

describe("jitter buffer", () => {
  const pkt = (seq: number) => ({ seq, mediaIndex: seq * 480, arrivalNs: 0, data: new Uint8Array([seq]) });
  it("fills to the target, then plays in order and conceals a hole", () => {
    const jb = new JitterBuffer(3);
    expect(jb.pull().kind).toBe("filling");
    for (const s of [0, 1, 3]) jb.insert(pkt(s));
    expect(jb.playing).toBe(true);
    expect(jb.pull().kind).toBe("packet"); // 0
    expect(jb.pull().kind).toBe("packet"); // 1
    expect(jb.pull().kind).toBe("lost"); // 2 missing, 3 held
    expect(jb.pull().kind).toBe("packet"); // 3
    expect(jb.pull().kind).toBe("underrun");
    expect(jb.stats.lost).toBe(1);
  });
  it("drops late and duplicate packets", () => {
    const jb = new JitterBuffer(1);
    jb.insert(pkt(10));
    jb.pull();
    expect(jb.insert(pkt(9))).toBe("late");
    jb.insert(pkt(11));
    expect(jb.insert(pkt(11))).toBe("duplicate");
  });
  it("handles sequence wrap-around", () => {
    const jb = new JitterBuffer(1);
    jb.insert(pkt(0xfffffffe));
    expect(jb.pull().kind).toBe("packet");
    jb.insert(pkt(0xffffffff));
    expect(jb.pull().kind).toBe("packet");
    jb.insert(pkt(0));
    expect(jb.pull().kind).toBe("packet");
  });
});
