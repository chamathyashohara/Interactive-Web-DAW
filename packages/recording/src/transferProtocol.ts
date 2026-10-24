/** RRXF v1: the take-transfer connection (PROTOCOL_OVERVIEW §15). Frame: u32 length | u16 type | u16 0 | payload, big-endian. */
import { beBytes, concat, readBe, readU16, readU32, toText, utf8, writeU32 } from "./bytes";

export const MAGIC = 0x52525846; // "RRXF"
export const VERSION = 1;
export const DEFAULT_CHUNK_BYTES = 32768;
export const MIN_CHUNK_BYTES = 1024;
export const MAX_CHUNK_BYTES = 65536;
export const MAX_FRAME_BYTES = 4 + 4 + 4 + 32 + MAX_CHUNK_BYTES;
export const MAX_TEXT_BYTES = 256;
export const MAX_NAME_BYTES = 128;
export const TOKEN_CHARS = 32;

export const XType = { Hello: 1, Offer: 2, Resume: 3, Chunk: 4, Ack: 5, Nack: 6, Done: 7, Result: 8, Abort: 9 } as const;
export type XType = (typeof XType)[keyof typeof XType];
const X_NAMES = ["", "HELLO", "OFFER", "RESUME", "CHUNK", "ACK", "NACK", "DONE", "RESULT", "ABORT"];
export const xtypeName = (t: number): string => X_NAMES[t] ?? "UNKNOWN";

export interface XMsg {
  type: XType;
  sessionId: string;
  token: string;
  takeId: number;
  fileBytes: number;
  chunkBytes: number;
  chunkCount: number;
  fileSha: Uint8Array;
  sampleRate: number;
  channels: number;
  bits: number;
  formatTag: number;
  frames: number;
  takeStatus: number;
  name: string;
  nextChunk: number;
  index: number;
  chunkSha: Uint8Array;
  data: Uint8Array;
  code: number;
  already: boolean;
  text: string;
}

const ZERO32 = new Uint8Array(32);
export function xmsg(type: XType, over: Partial<XMsg> = {}): XMsg {
  return {
    type, sessionId: "", token: "", takeId: 0, fileBytes: 0, chunkBytes: 0, chunkCount: 0, fileSha: ZERO32, sampleRate: 0, channels: 0, bits: 0,
    formatTag: 0, frames: 0, takeStatus: 0, name: "", nextChunk: 0, index: 0, chunkSha: ZERO32, data: new Uint8Array(0), code: 0, already: false, text: "", ...over,
  };
}

export const chunkCountFor = (fileBytes: number, chunkBytes: number): number => (chunkBytes === 0 ? 0 : Math.ceil(fileBytes / chunkBytes));

function fixed(s: string, n: number): Uint8Array {
  const out = new Uint8Array(n);
  out.set(utf8.encode(s).subarray(0, n));
  return out;
}
function text(s: string, limit: number): Uint8Array {
  const b = utf8.encode(s).subarray(0, limit);
  return concat([beBytes(b.length, 2), b]);
}

export function encodeX(m: XMsg): Uint8Array {
  const body: Uint8Array[] = [];
  switch (m.type) {
    case XType.Hello:
      body.push(beBytes(MAGIC, 4), beBytes(VERSION, 2), fixed(m.sessionId, 8), fixed(m.token, TOKEN_CHARS), beBytes(m.takeId, 4));
      break;
    case XType.Offer:
      body.push(beBytes(m.takeId, 4), beBytes(m.fileBytes, 8), beBytes(m.chunkBytes, 4), beBytes(m.chunkCount, 4), m.fileSha, beBytes(m.sampleRate, 4),
        beBytes(m.channels, 2), beBytes(m.bits, 2), beBytes(m.formatTag, 2), beBytes(m.frames, 8), beBytes(m.takeStatus, 1), text(m.name, MAX_NAME_BYTES));
      break;
    case XType.Resume:
      body.push(beBytes(m.takeId, 4), beBytes(m.nextChunk, 4), beBytes(m.code, 2), text(m.text, MAX_TEXT_BYTES));
      break;
    case XType.Chunk: {
      const data = m.data.subarray(0, MAX_CHUNK_BYTES);
      body.push(beBytes(m.index, 4), beBytes(data.length, 4), m.chunkSha, data);
      break;
    }
    case XType.Ack:
      body.push(beBytes(m.nextChunk, 4));
      break;
    case XType.Nack:
      body.push(beBytes(m.nextChunk, 4), beBytes(m.code, 2));
      break;
    case XType.Done:
      body.push(beBytes(m.takeId, 4));
      break;
    case XType.Result:
      body.push(beBytes(m.takeId, 4), beBytes(m.code, 2), beBytes(m.already ? 1 : 0, 1), text(m.text, MAX_TEXT_BYTES));
      break;
    case XType.Abort:
      body.push(beBytes(m.code, 2), text(m.text, MAX_TEXT_BYTES));
      break;
  }
  const payload = concat(body);
  const out = concat([new Uint8Array(4), beBytes(m.type, 2), beBytes(0, 2), payload]);
  writeU32(out, 0, out.length - 4);
  return out;
}

class Reader {
  private i = 0;
  constructor(private b: Uint8Array) {}
  private need(n: number): boolean { return this.b.length - this.i >= n; }
  u8(): number | null { return this.need(1) ? this.b[this.i++]! : null; }
  u16(): number | null { if (!this.need(2)) return null; const v = readU16(this.b, this.i); this.i += 2; return v; }
  u32(): number | null { if (!this.need(4)) return null; const v = readU32(this.b, this.i); this.i += 4; return v; }
  u64(): number | null { if (!this.need(8)) return null; const v = Number(readBe(this.b, this.i, 8)); this.i += 8; return v; }
  bytes(n: number): Uint8Array | null { if (!this.need(n)) return null; const v = this.b.slice(this.i, this.i + n); this.i += n; return v; }
  text(limit: number): string | null {
    const n = this.u16();
    if (n === null || n > limit) return null;
    const b = this.bytes(n);
    return b ? toText(b) : null;
  }
  atEnd(): boolean { return this.i === this.b.length; }
}

const isHexStr = (s: string): boolean => /^[0-9a-f]*$/.test(s);

function decodePayload(type: number, r: Reader, m: XMsg): string | null {
  m.type = type as XType;
  const bad = () => `malformed ${xtypeName(type)}`;
  switch (type) {
    case XType.Hello: {
      const magic = r.u32(), version = r.u16(), sid = r.bytes(8), tok = r.bytes(TOKEN_CHARS), take = r.u32();
      if (magic === null || version === null || !sid || !tok || take === null) return bad();
      if (magic !== MAGIC) return "not an RRXF stream";
      if (version !== VERSION) return `unsupported RRXF version ${version}`;
      m.sessionId = toText(sid);
      m.token = toText(tok);
      m.takeId = take;
      if (!isHexStr(m.sessionId) || !isHexStr(m.token)) return "malformed HELLO";
      break;
    }
    case XType.Offer: {
      const take = r.u32(), fb = r.u64(), cb = r.u32(), cc = r.u32(), sha = r.bytes(32), rate = r.u32(), ch = r.u16(), bits = r.u16(), tag = r.u16(), frames = r.u64(), st = r.u8(), name = r.text(MAX_NAME_BYTES);
      if (take === null || fb === null || cb === null || cc === null || !sha || rate === null || ch === null || bits === null || tag === null || frames === null || st === null || name === null) return bad();
      Object.assign(m, { takeId: take, fileBytes: fb, chunkBytes: cb, chunkCount: cc, fileSha: sha, sampleRate: rate, channels: ch, bits, formatTag: tag, frames, takeStatus: st, name });
      break;
    }
    case XType.Resume: {
      const take = r.u32(), next = r.u32(), code = r.u16(), t = r.text(MAX_TEXT_BYTES);
      if (take === null || next === null || code === null || t === null) return bad();
      Object.assign(m, { takeId: take, nextChunk: next, code, text: t });
      break;
    }
    case XType.Chunk: {
      const index = r.u32(), n = r.u32(), sha = r.bytes(32);
      if (index === null || n === null || !sha) return bad();
      if (n === 0 || n > MAX_CHUNK_BYTES) return "chunk length out of range";
      const data = r.bytes(n);
      if (!data) return bad();
      Object.assign(m, { index, chunkSha: sha, data });
      break;
    }
    case XType.Ack: {
      const next = r.u32();
      if (next === null) return bad();
      m.nextChunk = next;
      break;
    }
    case XType.Nack: {
      const next = r.u32(), code = r.u16();
      if (next === null || code === null) return bad();
      Object.assign(m, { nextChunk: next, code });
      break;
    }
    case XType.Done: {
      const take = r.u32();
      if (take === null) return bad();
      m.takeId = take;
      break;
    }
    case XType.Result: {
      const take = r.u32(), code = r.u16(), already = r.u8(), t = r.text(MAX_TEXT_BYTES);
      if (take === null || code === null || already === null || t === null) return bad();
      Object.assign(m, { takeId: take, code, already: already !== 0, text: t });
      break;
    }
    case XType.Abort: {
      const code = r.u16(), t = r.text(MAX_TEXT_BYTES);
      if (code === null || t === null) return bad();
      Object.assign(m, { code, text: t });
      break;
    }
    default:
      return "unknown RRXF message type";
  }
  return r.atEnd() ? null : bad();
}

export type XDecodeResult = { kind: "need-more" } | { kind: "message"; message: XMsg } | { kind: "error"; error: string };

export class XDecoder {
  static readonly BOUND = 4 + MAX_FRAME_BYTES + 65536;
  private buf: Uint8Array = new Uint8Array(0);
  private failed = false;

  feed(data: Uint8Array): void {
    if (!this.failed) this.buf = this.buf.length === 0 ? data.slice() : concat([this.buf, data]);
  }
  get buffered(): number { return this.buf.length; }

  private fail(error: string): XDecodeResult {
    this.failed = true;
    return { kind: "error", error };
  }

  next(): XDecodeResult {
    if (this.failed) return { kind: "error", error: "decoder failed earlier" };
    const b = this.buf;
    if (b.length > XDecoder.BOUND) return this.fail("too much unread data");
    if (b.length < 4) return { kind: "need-more" };
    const len = readU32(b, 0);
    if (len < 4 || len > MAX_FRAME_BYTES) return this.fail("frame length out of range");
    if (b.length < 4 + len) return { kind: "need-more" };
    if (readU16(b, 6) !== 0) return this.fail("reserved field not zero");
    const m = xmsg(XType.Abort);
    const error = decodePayload(readU16(b, 4), new Reader(b.subarray(8, 4 + len)), m);
    if (error) return this.fail(error);
    this.buf = b.slice(4 + len);
    return { kind: "message", message: m };
  }
}
