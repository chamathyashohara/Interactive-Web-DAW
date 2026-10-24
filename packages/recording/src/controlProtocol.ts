/**
 * Control protocol 1.2 wire format (PROTOCOL_OVERVIEW §4, §11, §14, §15), identical to the C++ recorder's so the two can talk.
 *
 *   u32 length | u16 type | u16 reserved(0) | u32 msg_id | u32 ref_id | TLV...   (TLV = u16 tag | u16 len | bytes)
 *
 * Unknown tags are ignored; unknown types, duplicate tags, missing required tags and oversize frames are errors.
 */
import { beBytes, concat, readBe, readU16, readU32, toText, utf8, writeU32 } from "./bytes";

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 2;
export const HEADER_BYTES = 12;
export const MAX_FRAME_BYTES = 16384;
export const MAX_STRING_BYTES = 256;

export const MsgType = {
  Hello: 0x0001,
  HelloAck: 0x0002,
  Join: 0x0003,
  JoinAck: 0x0004,
  Error: 0x000f,
  Heartbeat: 0x0010,
  HeartbeatAck: 0x0011,
  ReadyStatus: 0x0020,
  Arm: 0x0030,
  ArmAck: 0x0031,
  ScheduleStart: 0x0032,
  StartAck: 0x0033,
  TakeStarted: 0x0034,
  Cancel: 0x0035,
  StopSchedule: 0x0040,
  StopAck: 0x0041,
  LocalStop: 0x0042,
  TakeFinalised: 0x0043,
  SessionClosed: 0x0050,
  TransferRequest: 0x0060,
  TransferAck: 0x0061,
} as const;
export type MsgType = (typeof MsgType)[keyof typeof MsgType];

const MSG_NAMES = Object.fromEntries(
  Object.entries(MsgType).map(([k, v]) => [v, k.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()]),
) as Record<number, string>;
export const msgTypeName = (t: number): string => MSG_NAMES[t] ?? "UNKNOWN";
export const isKnownMsgType = (t: number): boolean => t in MSG_NAMES;

export const Tag = {
  SentNs: 1,
  ProtoMajor: 2,
  ProtoMinor: 3,
  Role: 4,
  AppVersion: 5,
  DisplayName: 6,
  PairingCode: 7,
  SessionId: 8,
  ClientId: 9,
  ErrorCode: 10,
  ErrorText: 11,
  Ready: 12,
  Reasons: 13,
  State: 14,
  TakeId: 15,
  StartAtNs: 16,
  StopAtNs: 17,
  PlannedLocalNs: 18,
  ThetaNs: 19,
  UncertaintyNs: 20,
  EchoSentNs: 21,
  RecvNs: 22,
  FirstFrame: 23,
  Status: 24,
  Frames: 25,
  StopReason: 26,
  Consent: 27,
  MaxTakeSeconds: 28,
  ResumeToken: 29,
  Accepted: 30,
  FirstSampleNs: 31,
  LateFrames: 32,
  ReadyChecks: 33,
  TransferPort: 34,
  TransferToken: 35,
  DeliveryConsent: 36,
} as const;
export type Tag = (typeof Tag)[keyof typeof Tag];

/** Width in bytes of a fixed-size tag; 0 = string. */
function tagWidth(tag: number): number {
  switch (tag) {
    case Tag.Role: case Tag.Ready: case Tag.State: case Tag.Status: case Tag.Consent: case Tag.Accepted: case Tag.DeliveryConsent:
      return 1;
    case Tag.ProtoMajor: case Tag.ProtoMinor: case Tag.ErrorCode: case Tag.TransferPort:
      return 2;
    case Tag.TakeId: case Tag.MaxTakeSeconds:
      return 4;
    case Tag.SentNs: case Tag.StartAtNs: case Tag.StopAtNs: case Tag.PlannedLocalNs: case Tag.ThetaNs: case Tag.UncertaintyNs:
    case Tag.EchoSentNs: case Tag.RecvNs: case Tag.FirstFrame: case Tag.Frames: case Tag.FirstSampleNs: case Tag.LateFrames:
      return 8;
    default:
      return 0;
  }
}

export class Frame {
  msgId = 0;
  refId = 0;
  fields = new Map<number, Uint8Array>();
  constructor(public type: number) {}

  setU8(tag: number, v: number): this { this.fields.set(tag, beBytes(v, 1)); return this; }
  setU16(tag: number, v: number): this { this.fields.set(tag, beBytes(v, 2)); return this; }
  setU32(tag: number, v: number): this { this.fields.set(tag, beBytes(v, 4)); return this; }
  setU64(tag: number, v: number | bigint): this { this.fields.set(tag, beBytes(v, 8)); return this; }
  /** Signed 64-bit; accepts a JS number (nanosecond counts stay far below 2^53). */
  setI64(tag: number, v: number | bigint): this {
    this.fields.set(tag, beBytes(typeof v === "bigint" ? v : BigInt(Math.trunc(v)), 8));
    return this;
  }
  setStr(tag: number, v: string): this {
    this.fields.set(tag, utf8.encode(v).slice(0, MAX_STRING_BYTES));
    return this;
  }
  has(tag: number): boolean { return this.fields.has(tag); }
  private fixed(tag: number, w: number): bigint | undefined {
    const b = this.fields.get(tag);
    return b && b.length === w ? readBe(b, 0, w) : undefined;
  }
  u8(tag: number): number | undefined { const v = this.fixed(tag, 1); return v === undefined ? undefined : Number(v); }
  u16(tag: number): number | undefined { const v = this.fixed(tag, 2); return v === undefined ? undefined : Number(v); }
  u32(tag: number): number | undefined { const v = this.fixed(tag, 4); return v === undefined ? undefined : Number(v); }
  u64(tag: number): number | undefined { const v = this.fixed(tag, 8); return v === undefined ? undefined : Number(v); }
  i64(tag: number): number | undefined { const v = this.fixed(tag, 8); return v === undefined ? undefined : Number(BigInt.asIntN(64, v)); }
  str(tag: number): string | undefined { const b = this.fields.get(tag); return b ? toText(b) : undefined; }
}

/** Bytes on the wire, including the u32 length prefix. */
export function encodeFrame(f: Frame): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array(4), beBytes(f.type, 2), beBytes(0, 2), beBytes(f.msgId, 4), beBytes(f.refId, 4)];
  let size = 4 + HEADER_BYTES;
  for (const [tag, value] of [...f.fields.entries()].sort((a, b) => a[0] - b[0])) {
    const room = 4 + MAX_FRAME_BYTES - size;
    if (room < 4) break;
    const len = Math.min(value.length, room - 4, 0xffff);
    parts.push(beBytes(tag, 2), beBytes(len, 2), value.subarray(0, len));
    size += 4 + len;
  }
  const out = concat(parts);
  writeU32(out, 0, out.length - 4);
  return out;
}

export function requiredTags(type: number): number[] {
  const r: number[] = [Tag.SentNs];
  switch (type) {
    case MsgType.Hello: r.push(Tag.ProtoMajor, Tag.ProtoMinor, Tag.Role, Tag.AppVersion); break;
    case MsgType.HelloAck: r.push(Tag.ProtoMajor, Tag.ProtoMinor, Tag.AppVersion); break;
    case MsgType.Join: r.push(Tag.ClientId, Tag.DisplayName); break;
    case MsgType.JoinAck: r.push(Tag.SessionId, Tag.ResumeToken, Tag.DisplayName, Tag.MaxTakeSeconds); break;
    case MsgType.Error: r.push(Tag.ErrorCode); break;
    case MsgType.HeartbeatAck: r.push(Tag.EchoSentNs, Tag.RecvNs); break;
    case MsgType.ReadyStatus: r.push(Tag.Ready, Tag.Consent, Tag.State); break;
    case MsgType.Arm: r.push(Tag.TakeId, Tag.MaxTakeSeconds); break;
    case MsgType.ArmAck: case MsgType.StartAck: case MsgType.StopAck: case MsgType.TransferAck: r.push(Tag.TakeId, Tag.Accepted); break;
    case MsgType.ScheduleStart: r.push(Tag.TakeId, Tag.StartAtNs); break;
    case MsgType.TakeStarted: r.push(Tag.TakeId, Tag.FirstFrame, Tag.FirstSampleNs); break;
    case MsgType.Cancel: r.push(Tag.TakeId, Tag.ErrorCode); break;
    case MsgType.StopSchedule: r.push(Tag.TakeId, Tag.StopAtNs); break;
    case MsgType.LocalStop: r.push(Tag.TakeId, Tag.StopReason); break;
    case MsgType.TakeFinalised: r.push(Tag.TakeId, Tag.Status, Tag.Frames); break;
    case MsgType.SessionClosed: r.push(Tag.ErrorCode); break;
    case MsgType.TransferRequest: r.push(Tag.TakeId, Tag.TransferPort, Tag.TransferToken); break;
  }
  return r;
}

/** Presence and width of the required tags; an empty string means the frame is valid. */
export function validateFrame(f: Frame): string {
  if (!isKnownMsgType(f.type)) return "unknown message type";
  for (const tag of requiredTags(f.type)) {
    const v = f.fields.get(tag);
    if (!v) return `${msgTypeName(f.type)}: missing field ${tag}`;
    const w = tagWidth(tag);
    if (w !== 0 && v.length !== w) return `${msgTypeName(f.type)}: field ${tag} has the wrong size`;
  }
  for (const [tag, v] of f.fields) {
    const w = tagWidth(tag);
    if (w === 0 && v.length > MAX_STRING_BYTES) return "string field too long";
    if (w !== 0 && v.length !== w) return `field ${tag} has the wrong size`;
  }
  return "";
}

export type DecodeResult = { kind: "need-more" } | { kind: "frame"; frame: Frame } | { kind: "error"; error: string };

/** Reassembles frames from a TCP byte stream. After an error the connection must be closed. */
export class FrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);
  private failed = false;

  feed(data: Uint8Array): void {
    if (this.failed) return;
    this.buf = this.buf.length === 0 ? data.slice() : concat([this.buf, data]);
  }

  private fail(error: string): DecodeResult {
    this.failed = true;
    return { kind: "error", error };
  }

  next(): DecodeResult {
    if (this.failed) return { kind: "error", error: "decoder already failed" };
    const b = this.buf;
    if (b.length > 4 + MAX_FRAME_BYTES + 65536) return this.fail("too much unread data");
    if (b.length < 4) return { kind: "need-more" };
    const length = readU32(b, 0);
    if (length < HEADER_BYTES || length > MAX_FRAME_BYTES) return this.fail(`frame length ${length} out of range`);
    if (b.length < 4 + length) return { kind: "need-more" };
    const body = b.subarray(4, 4 + length);
    const type = readU16(body, 0);
    if (!isKnownMsgType(type)) return this.fail(`unknown message type ${type}`);
    if (readU16(body, 2) !== 0) return this.fail("reserved field not zero");
    const f = new Frame(type);
    f.msgId = readU32(body, 4);
    f.refId = readU32(body, 8);
    let pos = HEADER_BYTES;
    while (pos < length) {
      if (pos + 4 > length) return this.fail("truncated TLV header");
      const tag = readU16(body, pos);
      const len = readU16(body, pos + 2);
      pos += 4;
      if (pos + len > length) return this.fail("TLV runs past the end of the frame");
      if (f.fields.has(tag)) return this.fail(`duplicate tag ${tag}`);
      f.fields.set(tag, body.slice(pos, pos + len));
      pos += len;
    }
    this.buf = b.slice(4 + length);
    const problem = validateFrame(f);
    if (problem) return this.fail(problem);
    return { kind: "frame", frame: f };
  }
}
